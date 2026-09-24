/**
 * The storage authority: the only code that opens the question database.
 *
 * Runs in the service worker. Commands are applied one transaction at a time;
 * a response is sent only after the transaction committed. Queries return
 * snapshots. The legacy migration runs on startup, journaled, and never touches
 * session storage.
 */

import { openDatabase } from './db';
import {
  applyCommand,
  dumpAll,
  findSourcesByScope,
  getQuestionBundle,
  listQuestionsForSource,
  listSources,
  readMeta,
  searchQuestions,
  writeMeta
} from './repository';
import {
  legacyKeysEligibleForCleanup,
  MIGRATION_JOURNAL_KEY,
  runLegacyMigration,
  type MigrationJournal
} from './migration';
import { createBackup, renderSourceMarkdown, restoreBackup, validateBackup, type BackupFile } from './backup';
import type {
  DomainBackupResponse,
  DomainCommandMessage,
  DomainCommandResponse,
  DomainExportResponse,
  DomainLegacyCleanupResponse,
  DomainQueryMessage,
  DomainQueryResponse,
  DomainRestoreResponse,
  QuestionChangedMessage
} from './protocol';
import { ALL_PROVIDER_ORIGINS } from '../shared/providers/origins';
import { BUILD_ID } from '../shared/build-info';

/** Mirror of the journal in chrome.storage.local, so a stale client can be fenced. */
export const MIGRATION_JOURNAL_STORAGE_KEY = 'aside:migration-journal';
export const LEGACY_FENCE_KEY = 'aside:legacy-fence';

let migrationRun: Promise<void> | null = null;
let lastMigrationPrivateIds: string[] = [];
let storageHealthy = true;
let lastStorageError: string | null = null;

async function db(): Promise<IDBDatabase> {
  try {
    const database = await openDatabase();
    storageHealthy = true;
    return database;
  } catch (error) {
    storageHealthy = false;
    lastStorageError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/** One command per worker lifetime is enough: the journal makes re-runs no-ops. */
export function ensureMigrated(): Promise<void> {
  migrationRun ??= (async () => {
    try {
      const database = await db();
      const raw = (await chrome.storage.local.get(null)) as Record<string, unknown>;
      const result = await runLegacyMigration(database, raw, async (journal) => {
        await chrome.storage.local.set({ [MIGRATION_JOURNAL_STORAGE_KEY]: journal });
      });
      lastMigrationPrivateIds = result.durablePrivateIds;
      if (result.journal.completedAt) {
        // Fence: a client older than this build reads the flag and stops writing
        // legacy records, so a stale client cannot undo the cutover.
        await chrome.storage.local.set({ [LEGACY_FENCE_KEY]: { cutoverAt: result.journal.completedAt, buildId: BUILD_ID } });
      }
    } catch (error) {
      // A migration that cannot run leaves legacy data untouched; the status
      // query reports it so the UI can say so.
      storageHealthy = false;
      lastStorageError = error instanceof Error ? error.message : String(error);
    }
  })();
  return migrationRun;
}

async function broadcast(message: QuestionChangedMessage): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: ALL_PROVIDER_ORIGINS.map((origin) => `${origin}/*`) });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // No listener in that tab yet.
      }
    })
  );
  // The library page is an extension page; it listens on the runtime channel.
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No extension page open.
  }
}

function sourceIdOfCommand(command: DomainCommandMessage['command']): string | null {
  switch (command.type) {
    case 'CreateQuestion':
      return command.source.id;
    case 'AliasSource':
      return command.sourceId;
    default:
      return null;
  }
}

function questionIdOfCommand(command: DomainCommandMessage['command']): string | null {
  switch (command.type) {
    case 'CreateQuestion':
    case 'CreateChildQuestion':
      return command.question.id;
    case 'UpdateDraft':
    case 'RenameQuestion':
    case 'FreezeSnapshot':
    case 'AppendOrReviseCapturedMessage':
    case 'ResolveQuestion':
    case 'ReopenQuestion':
    case 'ArchiveQuestion':
    case 'DeleteQuestion':
      return command.questionId;
    case 'SaveNote':
      return command.note.questionId;
    case 'UpdateRun':
    case 'DeleteNote':
    case 'AliasSource':
      return null;
    default:
      return null;
  }
}

export async function handleDomainCommand(message: DomainCommandMessage): Promise<DomainCommandResponse> {
  await ensureMigrated();
  try {
    const outcome = await applyCommand(await db(), message.command);
    if (outcome.status === 'applied') {
      const questionId = questionIdOfCommand(message.command);
      if (questionId) {
        void broadcast({
          type: 'QUESTION_CHANGED',
          questionId,
          sourceId: sourceIdOfCommand(message.command),
          kind:
            message.command.type === 'CreateQuestion' || message.command.type === 'CreateChildQuestion'
              ? 'created'
              : message.command.type === 'DeleteQuestion'
                ? 'deleted'
                : 'updated'
        });
      }
    }
    return { ok: true, outcome };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleDomainQuery(message: DomainQueryMessage): Promise<DomainQueryResponse> {
  await ensureMigrated();
  if (message.query === 'buildInfo') {
    return { ok: true, query: 'buildInfo', buildId: BUILD_ID };
  }
  try {
    const database = await db();
    switch (message.query) {
      case 'sources':
        return { ok: true, query: 'sources', sources: await listSources(database) };
      case 'questionsForSource':
        return { ok: true, query: 'questionsForSource', questions: await listQuestionsForSource(database, message.sourceId) };
      case 'questionsForScope': {
        const sources = await findSourcesByScope(database, message.scopeKey);
        const source = sources[0];
        return {
          ok: true,
          query: 'questionsForScope',
          sourceId: source?.id ?? null,
          questions: source ? await listQuestionsForSource(database, source.id) : []
        };
      }
      case 'bundle':
        return { ok: true, query: 'bundle', bundle: await getQuestionBundle(database, message.questionId) };
      case 'search':
        return { ok: true, query: 'search', hits: await searchQuestions(database, message.term) };
      case 'migrationStatus':
        return {
          ok: true,
          query: 'migrationStatus',
          journal: (await readMeta<MigrationJournal>(database, MIGRATION_JOURNAL_KEY)) ?? null,
          durablePrivateIds: lastMigrationPrivateIds,
          storageHealthy
        };
      default:
        return { ok: false, reason: 'Unknown query.' };
    }
  } catch (error) {
    return {
      ok: false,
      reason: lastStorageError ?? (error instanceof Error ? error.message : String(error)),
      storageHealthy: false
    };
  }
}

export async function handleDomainBackup(): Promise<DomainBackupResponse> {
  await ensureMigrated();
  try {
    return { ok: true, backup: createBackup(await dumpAll(await db()), BUILD_ID) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleDomainRestore(raw: unknown): Promise<DomainRestoreResponse> {
  await ensureMigrated();
  const verdict = validateBackup(raw);
  if (!verdict.ok) {
    return { ok: false, reason: 'The backup file is not valid.', problems: verdict.problems };
  }
  try {
    return { ok: true, report: await restoreBackup(await db(), raw as BackupFile) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleDomainExport(sourceId: string): Promise<DomainExportResponse> {
  await ensureMigrated();
  try {
    const database = await db();
    const entries = await listQuestionsForSource(database, sourceId);
    const bundles = [];
    for (const entry of entries) {
      const bundle = await getQuestionBundle(database, entry.question.id);
      if (bundle) {
        bundles.push(bundle);
      }
    }
    const source = bundles[0]?.source;
    const title = source?.title ?? 'source';
    const safeName = title.replace(/[^\w一-鿿-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'source';
    return {
      ok: true,
      markdown: renderSourceMarkdown(title, source?.url ?? '', bundles),
      filename: `aside-${safeName}.md`
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove legacy ordinary records after a validated migration. Explicit, separate
 * from migration, and never touches session storage or private records.
 */
export async function handleLegacyCleanup(confirm: boolean): Promise<DomainLegacyCleanupResponse> {
  if (!confirm) {
    return { ok: false, reason: 'Cleanup requires explicit confirmation.' };
  }
  await ensureMigrated();
  try {
    const database = await db();
    const journal = await readMeta<MigrationJournal>(database, MIGRATION_JOURNAL_KEY);
    if (!journal?.validation?.ok) {
      return { ok: false, reason: 'Migration has not been validated; legacy records are kept as the rollback source.' };
    }
    const raw = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const keys = legacyKeysEligibleForCleanup(raw, journal);
    if (keys.length) {
      await chrome.storage.local.remove(keys);
    }
    const updated: MigrationJournal = { ...journal, cleanedUpAt: Date.now() };
    await writeMeta(database, MIGRATION_JOURNAL_KEY, updated);
    await chrome.storage.local.set({ [MIGRATION_JOURNAL_STORAGE_KEY]: updated });
    return { ok: true, removedKeys: keys };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
