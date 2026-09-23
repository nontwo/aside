/**
 * The reading-Q&A domain: what a question is, what it is attached to, and what
 * was actually sent and received on its behalf.
 *
 * These records are the canonical, durable state for ordinary (non-private)
 * questions. The in-page panel keeps a separate, non-canonical view/run projection
 * (BranchPanelState) so a tab can close a view without touching the question.
 *
 * Nothing here is a DOM node, a tab id or a label: ids are stable local ids, and
 * provider references are kept separately from local identity so a remote
 * conversation can be re-linked without duplicating the question.
 */

import type { ChatRole } from '../shared/types';

export type ProviderId = 'chatgpt' | 'claude';

/** Local retention, independent of the provider's own conversation mode. */
export type RetentionPolicy = 'durable' | 'session-only';

/** What the Owner has decided about a question; never inferred from the provider. */
export type QuestionLifecycle = 'active' | 'resolved' | 'archived';

export type SourceKind = 'assistant-answer' | 'user-message' | 'unknown';

/** How much of a source's material Aside actually read. */
export type AcquisitionState =
  | 'captured-text'
  | 'selected-fragment'
  | 'metadata-only'
  | 'unavailable';

export interface Source {
  id: string;
  providerId: ProviderId;
  /** Provider conversation / container identity, namespaced by provider. */
  scopeKey: string;
  conversationId: string | null;
  containerId: string | null;
  url: string;
  title: string;
  kind: SourceKind;
  acquisition: AcquisitionState;
  /** Stable ids of the message this source was read from, if any. */
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export type BlockKind = 'paragraph' | 'code' | 'list' | 'table' | 'math' | 'heading' | 'unknown';

/**
 * Immutable captured material. Identified by a content hash, so a block the same
 * text was captured for twice is stored once and shared by reference.
 */
export interface SourceBlock {
  id: string;
  sourceId: string;
  role: ChatRole;
  kind: BlockKind;
  /** Structure-preserving text, as a model should read it. */
  text: string;
  /** Whitespace-normalized text, used only to find the block again. */
  anchorText: string;
  /** Provider message identity at capture time. */
  messageId: string;
  turnIndex: number;
  contentHash: string;
  capturedAt: number;
  limitation?: string;
}

/** Where a question points inside its source: W3C-style quote selector plus hints. */
export interface Anchor {
  id: string;
  sourceId: string;
  /** Structured text of the selection, for interpretation. */
  selectedText: string;
  /** Normalized exact quote plus prefix/suffix, for matching. */
  exact: string;
  prefix: string;
  suffix: string;
  messageId: string;
  turnIndex: number;
  role: ChatRole;
  contentHash: string;
  /** Navigation fallback only; never proof of identity. */
  scrollHint: number;
  createdAt: number;
}

export interface Question {
  id: string;
  sourceId: string;
  anchorId: string;
  /** Explicit child of another question's answer, or null for a root question. */
  parentQuestionId: string | null;
  parentMessageId: string | null;
  title: string;
  titleSource: 'auto' | 'user';
  lifecycle: QuestionLifecycle;
  retention: RetentionPolicy;
  /** The provider's own conversation mode the question was asked in. */
  providerMode: 'normal' | 'private';
  entryAction: 'ask' | 'why' | 'new_tab';
  createdAt: number;
  updatedAt: number;
  rev: number;
}

/** A draft that has not been sent. Editable; replaced by a snapshot on submit. */
export interface QuestionDraft {
  questionId: string;
  text: string;
  /** Block ids the Owner explicitly excluded from the plan. */
  excludedBlockIds: string[];
  /** Free text the Owner added for this question. */
  background: string;
  updatedAt: number;
  rev: number;
}

export interface SnapshotBlockRef {
  blockId: string;
  contentHash: string;
  role: 'focus' | 'enclosing' | 'preceding-question' | 'dependency' | 'background' | 'history';
  included: boolean;
  /** Why an excluded block was left out, when it was left out by the compiler. */
  omitReason?: 'budget' | 'user' | 'unavailable';
}

/**
 * Exactly what was submitted. Immutable: a later edit or a still-streaming source
 * cannot change what an answer was given.
 */
export interface ContextSnapshot {
  id: string;
  questionId: string;
  /** The complete prompt string, byte for byte. */
  prompt: string;
  question: string;
  blocks: SnapshotBlockRef[];
  /** Material the compiler knew about but could not supply. */
  missing: string[];
  compilerVersion: string;
  templateVersion: string;
  charCount: number;
  createdAt: number;
}

export type CaptureState = 'link-only' | 'partial' | 'captured-through';

export interface Message {
  id: string;
  questionId: string;
  role: ChatRole;
  /** Structure-preserving visible text. */
  text: string;
  /** True while the provider was still streaming when this text was read. */
  partial: boolean;
  /** Provider message identity when it could be observed. */
  providerMessageId: string | null;
  /** Ordering within the thread. */
  ordinal: number;
  snapshotId: string | null;
  attemptId: string | null;
  capturedAt: number;
  rev: number;
}

export type RunState =
  | 'draft'
  | 'preparing'
  | 'submitting'
  | 'submitted'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'submission-unknown';

export interface ProviderLink {
  id: string;
  questionId: string;
  providerId: ProviderId;
  /** Remote conversation url once known; null until the provider assigned one. */
  conversationUrl: string | null;
  attemptId: string | null;
  snapshotId: string | null;
  run: RunState;
  /** Evidence that the provider accepted the submission, if any. */
  acknowledgement: string | null;
  capture: CaptureState;
  capturedThroughMessageId: string | null;
  lastCaptureAt: number | null;
  /** Observed model name, or null when it could not be observed reliably. */
  model: string | null;
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export interface Note {
  id: string;
  questionId: string;
  sourceId: string;
  /** Owner-chosen or Owner-edited text. */
  text: string;
  /** Which message the text was taken from, when it was. */
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Minimal deletion memory. Never carries titles, urls or text. */
export interface Tombstone {
  id: string;
  kind: 'question' | 'source';
  deletedAt: number;
}
