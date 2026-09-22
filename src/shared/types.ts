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

export interface CreateBranchWindowMessage {
  type: 'CREATE_BRANCH_WINDOW';
  panelId: string;
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

export interface RunBranchPromptInTabMessage {
  type: 'RUN_BRANCH_PROMPT_IN_TAB';
  panelId: string;
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
}

export interface RunBranchPromptInTabResponse {
  ok: boolean;
  reason?: string;
}

export interface BranchAutomationEventMessage {
  type: 'BRANCH_AUTOMATION_EVENT';
  panelId: string;
  event: BranchPanelEvent;
}

export interface ForwardBranchPanelEventMessage {
  type: 'BRANCH_PANEL_EVENT';
  panelId: string;
  event: BranchPanelEvent;
}

export type BackgroundRequestMessage =
  | CreateBranchWindowMessage
  | FocusBranchWindowMessage
  | BranchAutomationEventMessage;
