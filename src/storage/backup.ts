/**
 * Versioned JSON backup / restore of ordinary question data, and on-demand
 * source-scoped Markdown export.
 *
 * Backups are produced only on an explicit user action and never include
 * session-only (private) material — private questions live outside this database
 * entirely, so there is nothing here to exclude by policy; the check below is a
 * belt-and-braces guard against a record that claims to be session-only.
 *
 * Restore validates the schema, treats every record as data, never executes
 * content, and never silently replaces a newer record: an incoming record older
 * than or equal to the stored revision is skipped and reported.
 */

import type { DatabaseDump, QuestionBundle } from './repository';
import { STORES, requestToPromise, withTransaction } from './db';
import type { Question, Tombstone } from '../domain/types';

export const BACKUP_FORMAT = 'aside-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: number;
  buildId: string;
  data: DatabaseDump;
}

export function createBackup(dump: DatabaseDump, buildId: string, now = Date.now()): BackupFile {
  const durableQuestionIds = new Set(
    dump.questions.filter((question) => question.retention === 'durable').map((question) => question.id)
  );
  const keep = <T extends { questionId: string }>(rows: T[]) =>
    rows.filter((row) => durableQuestionIds.has(row.questionId));

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    buildId,
    data: {
      sources: dump.sources,
      blocks: dump.blocks,
      anchors: dump.anchors,
      questions: dump.questions.filter((question) => durableQuestionIds.has(question.id)),
      drafts: keep(dump.drafts),
      snapshots: keep(dump.snapshots),
      messages: keep(dump.messages),
      links: keep(dump.links),
      notes: keep(dump.notes),
      tombstones: dump.tombstones
    }
  };
}

export interface BackupValidation {
  ok: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateBackup(raw: unknown): BackupValidation {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, problems: ['not an object'] };
  }
  if (raw.format !== BACKUP_FORMAT) {
    problems.push('unrecognised format');
  }
  if (raw.version !== BACKUP_VERSION) {
    problems.push(`unsupported version ${String(raw.version)}`);
  }
  if (!isRecord(raw.data)) {
    problems.push('missing data');
    return { ok: false, problems };
  }
  const data = raw.data;
  const lists = ['sources', 'blocks', 'anchors', 'questions', 'drafts', 'snapshots', 'messages', 'links', 'notes', 'tombstones'];
  lists.forEach((name) => {
    if (!Array.isArray(data[name])) {
      problems.push(`${name} is not a list`);
    }
  });
  if (Array.isArray(data.questions)) {
    (data.questions as unknown[]).forEach((question, index) => {
      if (!isRecord(question) || typeof question.id !== 'string' || typeof question.sourceId !== 'string') {
        problems.push(`question ${index} is malformed`);
      } else if (question.retention === 'session-only') {
        problems.push(`question ${question.id} is session-only and cannot be restored from disk`);
      }
    });
  }
  return { ok: problems.length === 0, problems };
}

export interface RestoreReport {
  imported: Record<string, number>;
  skippedOlder: string[];
  skippedDeleted: string[];
  conflicts: string[];
}

/**
 * Merge a validated backup into the database.
 *
 * Identity conflicts resolve by revision: a stored record with a revision at or
 * above the incoming one is kept and the incoming one reported. A question that
 * is tombstoned here is never brought back by an import.
 */
export async function restoreBackup(db: IDBDatabase, backup: BackupFile): Promise<RestoreReport> {
  const report: RestoreReport = { imported: {}, skippedOlder: [], skippedDeleted: [], conflicts: [] };
  const bump = (name: string) => {
    report.imported[name] = (report.imported[name] ?? 0) + 1;
  };

  await withTransaction(db, Object.values(STORES), 'readwrite', async (tx) => {
    const tombstones = tx.objectStore(STORES.tombstones);
    const deleted = new Set<string>();
    ((await requestToPromise(tombstones.getAll())) as Tombstone[]).forEach((tomb) => deleted.add(tomb.id));
    backup.data.tombstones.forEach((tomb) => deleted.add(tomb.id));

    const putIfNewer = async (
      storeName: (typeof STORES)[keyof typeof STORES],
      incoming: object,
      key: string
    ) => {
      const row = incoming as { rev?: number };
      const store = tx.objectStore(storeName);
      const existing = (await requestToPromise(store.get(key))) as { rev?: number } | undefined;
      if (existing && typeof existing.rev === 'number' && typeof row.rev === 'number' && existing.rev >= row.rev) {
        report.skippedOlder.push(`${storeName}:${key}`);
        return;
      }
      if (existing && (typeof existing.rev !== 'number' || typeof row.rev !== 'number')) {
        // Immutable rows (snapshots, blocks, anchors): keep what is stored.
        report.conflicts.push(`${storeName}:${key}`);
        return;
      }
      await requestToPromise(store.put(row));
      bump(storeName);
    };

    for (const source of backup.data.sources) {
      await putIfNewer(STORES.sources, source, source.id);
    }
    for (const block of backup.data.blocks) {
      await putIfNewer(STORES.blocks, block, block.id);
    }
    for (const anchor of backup.data.anchors) {
      await putIfNewer(STORES.anchors, anchor, anchor.id);
    }
    for (const question of backup.data.questions as Question[]) {
      if (deleted.has(question.id)) {
        report.skippedDeleted.push(question.id);
        continue;
      }
      await putIfNewer(STORES.questions, question, question.id);
    }
    const liveQuestion = (questionId: string) => !deleted.has(questionId);
    for (const draft of backup.data.drafts) {
      if (liveQuestion(draft.questionId)) {
        await putIfNewer(STORES.drafts, draft, draft.questionId);
      }
    }
    for (const snapshot of backup.data.snapshots) {
      if (liveQuestion(snapshot.questionId)) {
        await putIfNewer(STORES.snapshots, snapshot, snapshot.id);
      }
    }
    for (const message of backup.data.messages) {
      if (liveQuestion(message.questionId)) {
        await putIfNewer(STORES.messages, message, message.id);
      }
    }
    for (const link of backup.data.links) {
      if (liveQuestion(link.questionId)) {
        await putIfNewer(STORES.links, link, link.id);
      }
    }
    for (const note of backup.data.notes) {
      if (liveQuestion(note.questionId)) {
        await putIfNewer(STORES.notes, note, note.id);
      }
    }
    for (const tomb of backup.data.tombstones) {
      await requestToPromise(tombstones.put(tomb));
    }
  });

  return report;
}

/* ------------------------------------------------------------------ *
 * Markdown export
 * ------------------------------------------------------------------ */

function fence(text: string): string {
  // Choose a fence longer than any run of backticks in the text so the content
  // cannot break out of the block.
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}text\n${text}\n${marker}`;
}

function captureLabel(bundle: QuestionBundle): string {
  const link = bundle.links.at(-1);
  if (!link) {
    return 'not sent';
  }
  switch (link.capture) {
    case 'captured-through':
      return `captured through message ${link.capturedThroughMessageId ?? '?'}`;
    case 'partial':
      return `partially captured (last at ${link.lastCaptureAt ? new Date(link.lastCaptureAt).toISOString() : 'unknown'})`;
    default:
      return 'link only — transcript not captured';
  }
}

export function renderSourceMarkdown(sourceTitle: string, sourceUrl: string, bundles: QuestionBundle[]): string {
  const lines: string[] = [`# ${sourceTitle || 'Source'}`, '', `Source: ${sourceUrl}`, ''];

  bundles.forEach((bundle) => {
    const { question, anchor, messages, notes, snapshots } = bundle;
    lines.push(`## ${question.title}`, '');
    lines.push(`- Status: ${question.lifecycle}`);
    lines.push(`- Asked: ${new Date(question.createdAt).toISOString()}`);
    lines.push(`- Capture: ${captureLabel(bundle)}`);
    const link = bundle.links.at(-1);
    if (link?.conversationUrl) {
      lines.push(`- Provider conversation: ${link.conversationUrl}`);
    }
    if (bundle.parent) {
      lines.push(`- Child of: ${bundle.parent.title}`);
    }
    lines.push('');
    if (anchor) {
      lines.push('### Selected passage', '', fence(anchor.selectedText), '');
    }
    const latestSnapshot = snapshots.at(-1);
    if (latestSnapshot) {
      lines.push('### Question', '', fence(latestSnapshot.question), '');
      if (latestSnapshot.missing.length) {
        lines.push('Missing material at submission:', ...latestSnapshot.missing.map((item) => `- ${item}`), '');
      }
    } else if (bundle.draft?.text) {
      lines.push('### Draft (not sent)', '', fence(bundle.draft.text), '');
    }
    if (messages.length) {
      lines.push('### Thread', '');
      messages.forEach((message) => {
        lines.push(`**${message.role}**${message.partial ? ' (partial)' : ''}:`, '', fence(message.text), '');
      });
    }
    if (notes.length) {
      lines.push('### Notes', '');
      notes.forEach((note) => {
        lines.push(fence(note.text), '');
      });
    }
  });

  return lines.join('\n');
}
