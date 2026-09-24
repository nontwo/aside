/**
 * Messages between content scripts and the storage authority in the worker.
 *
 * Content scripts never open the database. They send a command and are told the
 * outcome after the transaction committed, or send a query and receive a
 * snapshot. Broadcasts go only to tabs on provider origins, and carry ids plus
 * the minimum needed to refresh a list — never a whole record — so a question's
 * content is not sprayed across unrelated tabs.
 */

import type { CommandOutcome, DomainCommand } from '../domain/commands';
import type { QuestionBundle, QuestionListEntry, SearchHit, SourceListEntry } from './repository';
import type { MigrationJournal } from './migration';
import type { BackupFile, RestoreReport } from './backup';

export interface DomainCommandMessage {
  type: 'DOMAIN_COMMAND';
  command: DomainCommand;
}

export type DomainQueryMessage =
  | { type: 'DOMAIN_QUERY'; query: 'sources' }
  | { type: 'DOMAIN_QUERY'; query: 'questionsForSource'; sourceId: string }
  | { type: 'DOMAIN_QUERY'; query: 'questionsForScope'; scopeKey: string }
  | { type: 'DOMAIN_QUERY'; query: 'bundle'; questionId: string }
  | { type: 'DOMAIN_QUERY'; query: 'search'; term: string }
  | { type: 'DOMAIN_QUERY'; query: 'migrationStatus' }
  | { type: 'DOMAIN_QUERY'; query: 'buildInfo' };

export interface DomainBackupMessage {
  type: 'DOMAIN_BACKUP';
}

export interface DomainRestoreMessage {
  type: 'DOMAIN_RESTORE';
  backup: unknown;
}

export interface DomainExportMessage {
  type: 'DOMAIN_EXPORT_MARKDOWN';
  sourceId: string;
}

export interface DomainLegacyCleanupMessage {
  type: 'DOMAIN_LEGACY_CLEANUP';
  /** Must be true; a cleanup is an explicit, separate decision. */
  confirm: boolean;
}

export type DomainRequestMessage =
  | DomainCommandMessage
  | DomainQueryMessage
  | DomainBackupMessage
  | DomainRestoreMessage
  | DomainExportMessage
  | DomainLegacyCleanupMessage;

export type DomainCommandResponse = { ok: true; outcome: CommandOutcome } | { ok: false; reason: string };

export type DomainQueryResponse =
  | { ok: true; query: 'sources'; sources: SourceListEntry[] }
  | { ok: true; query: 'questionsForSource'; questions: QuestionListEntry[] }
  | { ok: true; query: 'questionsForScope'; sourceId: string | null; questions: QuestionListEntry[] }
  | { ok: true; query: 'bundle'; bundle: QuestionBundle | null }
  | { ok: true; query: 'search'; hits: SearchHit[] }
  | { ok: true; query: 'migrationStatus'; journal: MigrationJournal | null; durablePrivateIds: string[]; storageHealthy: boolean }
  | { ok: true; query: 'buildInfo'; buildId: string }
  | { ok: false; reason: string; storageHealthy?: boolean };

export type DomainBackupResponse = { ok: true; backup: BackupFile } | { ok: false; reason: string };
export type DomainRestoreResponse = { ok: true; report: RestoreReport } | { ok: false; reason: string; problems?: string[] };
export type DomainExportResponse = { ok: true; markdown: string; filename: string } | { ok: false; reason: string };
export type DomainLegacyCleanupResponse = { ok: true; removedKeys: string[] } | { ok: false; reason: string };

/** Sent to provider tabs after a committed change. Ids only. */
export interface QuestionChangedMessage {
  type: 'QUESTION_CHANGED';
  questionId: string;
  sourceId: string | null;
  kind: 'created' | 'updated' | 'deleted';
}

export function isDomainRequest(value: unknown): value is DomainRequestMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === 'DOMAIN_COMMAND' ||
    type === 'DOMAIN_QUERY' ||
    type === 'DOMAIN_BACKUP' ||
    type === 'DOMAIN_RESTORE' ||
    type === 'DOMAIN_EXPORT_MARKDOWN' ||
    type === 'DOMAIN_LEGACY_CLEANUP'
  );
}
