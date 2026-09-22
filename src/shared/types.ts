export type ChatRole = 'user' | 'assistant' | 'system';

export type BranchKind = 'persistent' | 'temporary';
export type BranchEntryAction = 'ask' | 'why' | 'new_tab';
export type BranchSurfaceMode = 'embedded' | 'native_window';

export type BranchCreationMode =
  | 'pending'
  | 'local_persistent'
  | 'local_temporary'
  | 'failed';

export type BranchPanelStatus =
  | 'draft'
  | 'creating_branch'
  | 'opening_branch'
  | 'live'
  | 'failed';

export interface RangeQuotes {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface SelectedBlock {
  messageId: string;
  role: ChatRole;
  turnIndex: number;
  text: string;
  excerpt: string;
}

export interface SelectionPayload {
  rootConversationId: string;
  rootChatUrl: string;
  selectedText: string;
  selectedBlocks: SelectedBlock[];
  branchBaseMessageId: string;
  rangeQuotes: RangeQuotes;
  fallbackScrollY: number;
}

export interface BranchPanelState {
  panelId: string;
  rootConversationId: string;
  rootChatUrl: string;
  rootProjectUrl?: string;
  selection: SelectionPayload;
  focusPreview: string;
  branchKind: BranchKind;
  entryAction: BranchEntryAction;
  surfaceMode: BranchSurfaceMode;
  launchUrl?: string;
  branchChatUrl?: string;
  launchTabId?: number;
  launchWindowId?: number;
  creationMode: BranchCreationMode;
  title: string;
  titleStatus: 'pending' | 'ready';
  minimized: boolean;
  /** Identifies the current attempt; events from an older attempt are rejected. */
  attemptId?: string;
  initialQuestion?: string;
  initialPrompt?: string;
  status: BranchPanelStatus;
  statusLabel: string;
  errorMessage?: string;
  debugLog?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptTurn {
  id: string;
  role: ChatRole;
  turnIndex: number;
  text: string;
  excerpt: string;
}

export interface BranchStatusEvent {
  kind: 'status';
  status: Exclude<BranchPanelStatus, 'draft'>;
  statusLabel: string;
}

export interface BranchDebugLogEvent {
  kind: 'debug-log';
  message: string;
}

export interface BranchTitleEvent {
  kind: 'title';
  title: string;
}

export interface BranchLiveEvent {
  kind: 'live';
  branchChatUrl?: string;
  launchTabId?: number;
  launchWindowId?: number;
}

export interface BranchFailedEvent {
  kind: 'failed';
  reason: string;
  branchChatUrl?: string;
  launchTabId?: number;
  launchWindowId?: number;
}

export type BranchPanelEvent =
  | BranchStatusEvent
  | BranchDebugLogEvent
  | BranchTitleEvent
  | BranchLiveEvent
  | BranchFailedEvent;

/**
 * Identity every branch message must carry.
 *
 * panelId alone is not enough: a retry reuses the same panel, so an event from the
 * previous attempt would look legitimate. attemptId is minted fresh per attempt and
 * checked before any state is mutated or any event forwarded.
 */
export interface BranchAttemptRef {
  providerId: string;
  panelId: string;
  attemptId: string;
}

export interface CreateBranchWindowMessage extends BranchAttemptRef {
  type: 'CREATE_BRANCH_WINDOW';
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
  focusWindow?: boolean;
  arrangeSideBySide?: boolean;
}

export interface CreateBranchWindowResponse {
  ok: boolean;
  tabId?: number;
  windowId?: number;
  reason?: string;
}

export interface FocusBranchWindowMessage {
  type: 'FOCUS_BRANCH_WINDOW';
  panelId: string;
  launchTabId?: number;
  launchWindowId?: number;
  branchChatUrl?: string;
}

export interface FocusBranchWindowResponse {
  ok: boolean;
  tabId?: number;
  windowId?: number;
  reason?: string;
}

export interface RunBranchPromptInTabMessage extends BranchAttemptRef {
  type: 'RUN_BRANCH_PROMPT_IN_TAB';
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
}

export interface RunBranchPromptInTabResponse {
  ok: boolean;
  reason?: string;
}

export interface BranchAutomationEventMessage extends BranchAttemptRef {
  type: 'BRANCH_AUTOMATION_EVENT';
  event: BranchPanelEvent;
}

export interface ForwardBranchPanelEventMessage extends BranchAttemptRef {
  type: 'BRANCH_PANEL_EVENT';
  event: BranchPanelEvent;
}

export type BackgroundRequestMessage =
  | CreateBranchWindowMessage
  | FocusBranchWindowMessage
  | BranchAutomationEventMessage;

/* ------------------------------------------------------------------ *
 * Panel store messages. The service worker is the single authoritative
 * writer; content scripts propose changes and are told the outcome.
 * ------------------------------------------------------------------ */

export interface PanelUpsertMessage {
  type: 'PANEL_UPSERT';
  panelId: string;
  scopeKey: string;
  area: 'local' | 'session';
  baseRev: number;
  state: BranchPanelState;
}

export interface PanelDeleteMessage {
  type: 'PANEL_DELETE';
  panelId: string;
  baseRev: number;
}

export interface PanelListMessage {
  type: 'PANEL_LIST';
}

export interface PanelListedRecord {
  panelId: string;
  scopeKey: string;
  area: 'local' | 'session';
  rev: number;
  state: BranchPanelState;
}

export interface PanelListResponse {
  ok: boolean;
  records: PanelListedRecord[];
  /** True when private branches could not be read, so the UI can say so. */
  sessionUnavailable?: boolean;
}

export interface PanelWriteResponse {
  ok: boolean;
  status: 'applied' | 'deleted' | 'conflict' | 'rejected-deleted' | 'noop' | 'error';
  rev?: number;
  /** Present on conflict: the record the writer must reconcile against. */
  current?: PanelListedRecord;
  reason?: string;
  /** True when the write could not be stored at all, so the tab shows unsaved state. */
  unsaved?: boolean;
}

/** Broadcast to every tab after an accepted write. */
export interface PanelChangedMessage {
  type: 'PANEL_CHANGED';
  panelId: string;
  scopeKey: string;
  rev: number;
  deleted: boolean;
  state?: BranchPanelState;
}
