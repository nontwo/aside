/**
 * A scratch handoff: one disposable reading question on its way to a native
 * temporary conversation the Owner runs themselves.
 *
 * Deliberately NOT a Question. It is never written to the question database,
 * extension local/sync storage, files, logs, export or backup. It lives in the
 * worker's memory and, for recovery across a worker restart or a source reload,
 * in chrome.storage.session restricted to trusted extension contexts.
 *
 * It holds no answer transcript, no model id and no generation state: Aside does
 * not observe the native conversation. Native privacy is always "the Owner
 * confirms it in the native page".
 */

import type { ProviderId } from '../domain/types';
import type { SelectionPayload } from '../shared/types';
import type { RouteCategory } from './routes';

export type HandoffEntry = 'ask' | 'why' | 'new_tab';

/** Window is the default destination; New-tab asks for a tab in the source window. */
export type TargetKind = 'window' | 'tab';

export interface HandoffDraft {
  question: string;
  /** Plan block ids the Owner removed. The focus cannot be removed. */
  excludedBlockIds: string[];
  /** Material the Owner added for this question. */
  background: string;
}

/**
 * One frozen prompt revision. The preview shows `text`; the copy writes `text`.
 * A new revision is minted only when the text changes.
 */
export interface PreparedPrompt {
  revision: number;
  text: string;
  question: string;
  compilerVersion: string;
  templateVersion: string;
  /** Plan blocks that are in the text, by role, for the short summary. */
  included: Array<{ id: string; role: string; label: string }>;
  /** Plan blocks left out, and why. */
  omitted: Array<{ id: string; label: string; reason: 'user' | 'budget' }>;
  /** Material known to exist but not available to Aside. */
  missing: string[];
  charCount: number;
  maxChars: number;
  overBudget: boolean;
}

export type ClipboardState = 'idle' | 'copied' | 'failed';

/**
 * Ownership of the native destination, as far as Aside can demonstrate it.
 *  - owned: Aside created the tab and it has stayed on the provider, on at most
 *    one conversation of its own.
 *  - uncertain: replaced, navigated off the provider, or on to a second
 *    conversation. Focusable, never closed by Aside.
 */
export type TargetOwnership = 'owned' | 'uncertain';

export type TargetState = 'none' | 'opening' | 'open' | 'closed';

export interface HandoffTarget {
  state: TargetState;
  kind: TargetKind;
  route: RouteCategory | null;
  tabId: number | null;
  windowId: number | null;
  /** True when Aside created the window, so the tab is its only intended content. */
  windowCreated: boolean;
  ownership: TargetOwnership;
  /** Distinct conversation paths observed on the owned tab (session-only). */
  conversationPaths: string[];
  openingSince: number | null;
}

export interface HandoffSource {
  tabId: number;
  windowId: number | null;
  /** Provider scope of the source conversation, for re-anchoring checks. */
  scopeKey: string;
  url: string;
  /** False once the source tab closed; the session stays until End or target close. */
  open: boolean;
}

export interface ScratchHandoff {
  sessionId: string;
  /** Monotonic record revision; every accepted write increments it. */
  epoch: number;
  providerId: ProviderId;
  policy: 'temporary-intended';
  entry: HandoffEntry;
  source: HandoffSource;
  selection: SelectionPayload;
  draft: HandoffDraft;
  /** The last prompt revision that was copied, if any. */
  copied: PreparedPrompt | null;
  clipboard: ClipboardState;
  target: HandoffTarget;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A short, content-free result code for diagnostics. */
export type HandoffCode =
  | 'ok'
  | 'focused-existing'
  | 'opened'
  | 'opening'
  | 'no-target'
  | 'unsupported-layout'
  | 'target-closed'
  | 'target-uncertain'
  | 'open-failed'
  | 'clipboard-denied'
  | 'clipboard-unavailable'
  | 'missing-session'
  | 'stale-epoch'
  | 'stale-client'
  | 'not-source-tab'
  | 'invalid-request'
  | 'retired'
  | 'storage-unavailable'
  | 'save-failed';

/* ------------------------------------------------------------------ *
 * Messages. Validated as data on arrival; the sender's tab is the
 * authorization, never a session id the page supplies.
 * ------------------------------------------------------------------ */

export interface HandoffCreateMessage {
  type: 'HANDOFF_CREATE';
  buildId: string;
  providerId: ProviderId;
  entry: HandoffEntry;
  scopeKey: string;
  sourceUrl: string;
  selection: SelectionPayload;
  draft: HandoffDraft;
}

export interface HandoffUpdateMessage {
  type: 'HANDOFF_UPDATE';
  buildId: string;
  sessionId: string;
  baseEpoch: number;
  draft?: HandoffDraft;
  hidden?: boolean;
}

export interface HandoffCopiedMessage {
  type: 'HANDOFF_COPIED';
  buildId: string;
  sessionId: string;
  ok: boolean;
  code: HandoffCode;
  prompt: PreparedPrompt | null;
}

export interface HandoffOpenMessage {
  type: 'HANDOFF_OPEN';
  buildId: string;
  sessionId: string;
  kind: TargetKind;
  /** Focus an existing target only; never create one. */
  focusOnly?: boolean;
  route?: RouteCategory;
}

export interface HandoffEndMessage {
  type: 'HANDOFF_END';
  buildId: string;
  sessionId: string;
  closeTarget: boolean;
}

export interface HandoffListForTabMessage {
  type: 'HANDOFF_LIST_FOR_TAB';
  buildId: string;
}

export interface HandoffListActiveMessage {
  type: 'HANDOFF_LIST_ACTIVE';
  buildId: string;
}

export interface HandoffReturnMessage {
  type: 'HANDOFF_RETURN';
  buildId: string;
  sessionId: string;
}

export interface HandoffArrangeMessage {
  type: 'HANDOFF_ARRANGE';
  buildId: string;
  sessionId: string;
}

export interface HandoffRoleMessage {
  type: 'HANDOFF_ROLE';
  buildId: string;
}

export interface HandoffSaveNoteMessage {
  type: 'HANDOFF_SAVE_NOTE';
  buildId: string;
  sessionId: string;
  /** The Owner's own note. */
  note: string;
  /** An answer excerpt the Owner pasted in themselves, if any. */
  excerpt: string;
  title: string;
  /** The source conversation's title as the preview showed it. */
  sourceTitle: string;
}

export type HandoffRequest =
  | HandoffCreateMessage
  | HandoffUpdateMessage
  | HandoffCopiedMessage
  | HandoffOpenMessage
  | HandoffEndMessage
  | HandoffListForTabMessage
  | HandoffListActiveMessage
  | HandoffReturnMessage
  | HandoffArrangeMessage
  | HandoffRoleMessage
  | HandoffSaveNoteMessage;

export interface HandoffResponse {
  ok: boolean;
  code: HandoffCode;
  buildId: string;
  session?: ScratchHandoff | null;
  sessions?: ScratchHandoff[];
  role?: 'target' | 'page';
  /** For End: whether the owned native tab was closed. */
  targetClosed?: boolean;
  /** For Return: how the source passage was found. */
  anchor?: AnchorResult;
  questionId?: string;
}

/** Worker -> the source tab only. */
export interface HandoffChangedMessage {
  type: 'HANDOFF_CHANGED';
  sessionId: string;
  session: ScratchHandoff | null;
  reason: 'updated' | 'ended' | 'target-closed';
}

export interface HandoffScrollToAnchorMessage {
  type: 'HANDOFF_SCROLL_TO_ANCHOR';
  sessionId: string;
}

export type AnchorResult =
  | 'exact'
  | 'message-only'
  | 'ambiguous'
  | 'not-found'
  | 'different-conversation'
  | 'source-closed';
