/**
 * The one mutation boundary for durable question records.
 *
 * A content script proposes a command; the storage authority applies it inside a
 * transaction and reports the outcome. No caller sends a whole stale record back
 * to overwrite the database, and a create is always explicit: updating an id that
 * does not exist is an error, never a silent create.
 */

import type {
  Anchor,
  ContextSnapshot,
  Message,
  Note,
  ProviderLink,
  Question,
  QuestionDraft,
  QuestionLifecycle,
  RunState,
  Source,
  SourceBlock
} from './types';

export interface CreateQuestionCommand {
  type: 'CreateQuestion';
  source: Omit<Source, 'createdAt' | 'updatedAt' | 'rev'>;
  blocks: Array<Omit<SourceBlock, 'capturedAt'>>;
  anchor: Omit<Anchor, 'createdAt'>;
  question: Omit<Question, 'createdAt' | 'updatedAt' | 'rev' | 'lifecycle'>;
  draft?: Pick<QuestionDraft, 'text' | 'excludedBlockIds' | 'background'>;
  /**
   * A note written in the same transaction, so an explicit "save local note"
   * either creates the question and its note together or creates nothing.
   */
  note?: { id: string; text: string };
  /** Leave an existing Source's title as it is (explicit notes never rename). */
  keepExistingSourceTitle?: boolean;
}

export interface UpdateDraftCommand {
  type: 'UpdateDraft';
  questionId: string;
  /** The draft revision the caller last saw; 0 when it has never seen one. */
  baseRev: number;
  text?: string;
  excludedBlockIds?: string[];
  background?: string;
}

export interface RenameQuestionCommand {
  type: 'RenameQuestion';
  questionId: string;
  baseRev: number;
  title: string;
}

export interface FreezeSnapshotCommand {
  type: 'FreezeSnapshot';
  questionId: string;
  snapshot: Omit<ContextSnapshot, 'createdAt'>;
  link: Omit<ProviderLink, 'createdAt' | 'updatedAt' | 'rev'>;
}

export interface UpdateRunCommand {
  type: 'UpdateRun';
  linkId: string;
  baseRev: number;
  /** The attempt this update speaks for; a stale attempt is rejected. */
  attemptId: string;
  run?: RunState;
  conversationUrl?: string | null;
  acknowledgement?: string | null;
  model?: string | null;
}

export interface AppendOrReviseCapturedMessageCommand {
  type: 'AppendOrReviseCapturedMessage';
  questionId: string;
  linkId: string;
  attemptId: string;
  message: Omit<Message, 'id' | 'questionId' | 'capturedAt' | 'rev'> & { id?: string };
  /** Updated capture state on the link, decided by the capturer from evidence. */
  capture: ProviderLink['capture'];
  capturedThroughMessageId: string | null;
}

export interface SetLifecycleCommand {
  type: 'ResolveQuestion' | 'ReopenQuestion' | 'ArchiveQuestion';
  questionId: string;
  baseRev: number;
}

export interface SaveNoteCommand {
  type: 'SaveNote';
  note: Omit<Note, 'createdAt' | 'updatedAt'>;
}

export interface DeleteNoteCommand {
  type: 'DeleteNote';
  noteId: string;
}

export interface DeleteQuestionCommand {
  type: 'DeleteQuestion';
  questionId: string;
  /** 'reparent' keeps children under the deleted question's parent; 'subtree' removes them. */
  descendants: 'reparent' | 'subtree';
}

export interface AliasSourceCommand {
  type: 'AliasSource';
  /** A source created for a page with no conversation id yet. */
  sourceId: string;
  conversationId: string;
  scopeKey: string;
  url: string;
}

export interface CreateChildQuestionCommand {
  type: 'CreateChildQuestion';
  parentQuestionId: string;
  parentMessageId: string;
  question: Omit<Question, 'createdAt' | 'updatedAt' | 'rev' | 'lifecycle' | 'parentQuestionId' | 'parentMessageId' | 'sourceId' | 'anchorId'>;
  draft?: Pick<QuestionDraft, 'text' | 'excludedBlockIds' | 'background'>;
}

export type DomainCommand =
  | CreateQuestionCommand
  | UpdateDraftCommand
  | RenameQuestionCommand
  | FreezeSnapshotCommand
  | UpdateRunCommand
  | AppendOrReviseCapturedMessageCommand
  | SetLifecycleCommand
  | SaveNoteCommand
  | DeleteNoteCommand
  | DeleteQuestionCommand
  | AliasSourceCommand
  | CreateChildQuestionCommand;

export type CommandOutcome =
  | { status: 'applied'; rev: number; id: string }
  | { status: 'conflict'; current: { rev: number; text?: string } }
  | { status: 'rejected'; reason: string }
  | { status: 'error'; reason: string };

/** Lifecycle rules, pure so they are unit-testable without storage. */
export function nextLifecycle(
  current: QuestionLifecycle,
  command: SetLifecycleCommand['type']
): QuestionLifecycle | null {
  switch (command) {
    case 'ResolveQuestion':
      return current === 'archived' ? null : 'resolved';
    case 'ReopenQuestion':
      return current === 'active' ? null : 'active';
    case 'ArchiveQuestion':
      return current === 'archived' ? null : 'archived';
    default:
      return null;
  }
}

/** A title from the question or selection, never from the model. */
export function autoTitle(questionText: string, selectionText: string): string {
  const base = (questionText.trim() || selectionText.trim()).replace(/\s+/g, ' ');
  if (!base) {
    return 'Untitled question';
  }
  const words = base.split(' ');
  const clipped = words.slice(0, 9).join(' ');
  return clipped.length > 64 ? `${clipped.slice(0, 63).trimEnd()}…` : clipped;
}
