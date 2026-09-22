import {
  ASK_BUTTON_ID,
  WHY_BUTTON_ID,
  NEW_TAB_BUTTON_ID,
  SELECTION_TOOLBAR_ID,
  DEFAULT_BRANCH_TITLE,
  HIGHLIGHT_OVERLAY_ID,
  LEGACY_LAST_BRANCH_KIND_STORAGE_KEY,
  LEGACY_PANEL_STORAGE_PREFIX,
  PANEL_STORAGE_PREFIX,
  ROOT_STYLE_ID,
  LAST_BRANCH_KIND_STORAGE_KEY
} from '../shared/constants';
import { mergePanelStateOnConflict, resolveWriteConflict } from '../shared/panel-store';
import {
  getPanelStorageKeyForConversationId,
  getPanelStorageKeyForState,
  isCatchAllPanelStorageKey,
  isPanelStorageKey,
  mergePanelBuckets
} from '../shared/panel-storage';
import type {
  PanelChangedMessage,
  PanelListResponse,
  PanelListedRecord,
  PanelWriteResponse
} from '../shared/types';
import {
  buildSelectionPayloadFromDraft,
  captureSelectionDraftFromRange,
  countTranscriptTurns,
  findQuotedTextRangeInElement,
  findTurnElementByAnchor,
  getRecentAssistantTexts,
  rangeTouchesAssistantMessage,
  setActiveScopeResolver,
  setActiveTranscriptAdapter
} from '../shared/dom';
import type { SelectionDraft } from '../shared/dom';
import {
  buildBranchPrompt,
  buildNativeBootstrapPromptFromContext,
  stripHiddenTitle
} from '../shared/prompts';
import {
  createContext,
  describeContextSize,
  freezeContext,
  measureContext,
  renderContextText,
  sanitizeStoredContext,
  withBlockIncluded,
  withUserBackground
} from '../shared/context';
import type { BranchContext, ContextBlock } from '../shared/context';
import { attachElementToHost, ensureExtensionHostElement } from './ui-host';
import { findFreeCorner, findLeftGutterSlot, findSafePlacement } from '../shared/placement';
import { surfaceIsAvailable } from '../shared/providers/types';
import type { Rect } from '../shared/placement';
import {
  getActionLabel,
  getSendCandidateProfile,
  inferTemporaryChatState,
  isAcceptableSendControl,
  isTemporaryChatControl,
  setActiveComposerAdapter
} from '../shared/send-controls';
import type {
  BranchCreationMode,
  BranchEntryAction,
  BranchKind,
  BranchPanelEvent,
  BranchPanelState,
  BranchPanelStatus,
  CreateBranchWindowResponse,
  FocusBranchWindowResponse,
  BranchAttemptRef,
  ForwardBranchPanelEventMessage,
  RunBranchPromptInTabMessage,
  SelectionPayload
} from '../shared/types';
import {
  createAttemptId,
  isBranchAttemptRef,
  isBranchPanelEvent,
  isRunBranchPromptRequest,
  ownsAttempt
} from '../shared/branch-attempt';
import {
  clipText,
  compactWhitespace,
  normalizeChatUrl,
  randomId,
  sleep
} from '../shared/utils';
import { findChatAdapterForUrl, getAdapter } from '../shared/providers';
import type { ConversationIdentity, ProviderAdapter, ProviderId } from '../shared/providers';

interface PanelRuntime {
  state: BranchPanelState;
  element: HTMLDivElement;
  titleEl: HTMLElement;
  statusEl: HTMLElement;
  errorEl: HTMLElement;
  focusTextEl: HTMLElement;
  formEl: HTMLFormElement;
  branchKindField: HTMLDivElement;
  privacyNoteEl: HTMLDetailsElement;
  privacyStorageWarning: HTMLParagraphElement;
  persistentKindButton: HTMLButtonElement;
  temporaryKindButton: HTMLButtonElement;
  questionInput: HTMLTextAreaElement;
  submitButton: HTMLButtonElement;
  iframeShell: HTMLDivElement;
  iframeEl: HTMLIFrameElement;
  iframeOverlay: HTMLDivElement;
  iframeOverlayTitle: HTMLParagraphElement;
  iframeOverlayText: HTMLParagraphElement;
  contextShell: HTMLDetailsElement;
  contextBlockList: HTMLDivElement;
  contextBackground: HTMLTextAreaElement;
  contextSizeEl: HTMLParagraphElement;
  contextPreview: HTMLPreElement;
  debugLogShell: HTMLDivElement;
  debugLogTextarea: HTMLTextAreaElement;
  copyLogButton: HTMLButtonElement;
  openTabHeaderButton: HTMLButtonElement;
  pendingFramePrompt?: string;
  frameReady: boolean;
  frameStartSent: boolean;
  watchdogId?: number;
}

/**
 * Attempts this tab started. Both tabs holding the same panel see the same
 * `attemptId` once the record syncs, so the state alone cannot say which tab is
 * driving the branch; only the tab that minted the attempt knows.
 */
const startedAttemptIds = new Set<string>();

/** True when this tab is the one actually running the panel's branch. */
function tabDrivesBranch(runtime: PanelRuntime): boolean {
  const attemptId = runtime.state.attemptId;
  return Boolean(attemptId && startedAttemptIds.has(attemptId));
}

/** The attempt a panel is currently running, if any. */
function currentAttemptRef(runtime: PanelRuntime): BranchAttemptRef | null {
  const attemptId = runtime.state.attemptId;
  if (!attemptId) {
    return null;
  }
  return { providerId: provider.id, panelId: runtime.state.panelId, attemptId };
}

type AutomationTransport = 'frame' | 'background';

type ThemeMode = 'light' | 'dark';

interface FrameStartBranchMessage extends BranchAttemptRef {
  source: 'aside';
  target: 'frame';
  type: 'SB_FRAME_START_BRANCH';
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
}

interface FrameReadyMessage {
  source: 'aside';
  target: 'parent';
  type: 'SB_FRAME_READY';
  currentUrl: string;
}

interface FrameBranchEventMessage extends BranchAttemptRef {
  source: 'aside';
  target: 'parent';
  type: 'SB_FRAME_EVENT';
  event: BranchPanelEvent;
}

type FrameIncomingMessage = FrameReadyMessage | FrameBranchEventMessage;

declare global {
  interface Window {
    __asideCleanup?: () => void;
  }
}

const PANEL_CLASS = 'aside-panel';
const PANEL_TABBAR_ID = 'aside-tabbar';
const ASIDE_LAUNCHER_ID = 'aside-launcher';
const RAIL_WIDTH_PX = 96;
const FRAME_AUTOMATION_STYLE_ID = 'aside-frame-automation-style';
const EXTENSION_HOST_ID = 'aside-root';
const TITLE_WATCH_TIMEOUT_MS = 120_000;
// The envelope has to stay hidden for as long as the message can re-render, which is
// longer than it takes to read the title out of it.
const TITLE_MARKER_WATCH_TIMEOUT_MS = TITLE_WATCH_TIMEOUT_MS;
const TEMPORARY_LEAK_WATCH_MS = 4_000;
const MIN_SELECTION_LENGTH = 4;
const ASK_TRIGGER_SYNC_DELAY_MS = 120;
const PERSIST_DEBOUNCE_MS = 300;
// ChatGPT can refuse to be framed, the frame can fail to load, or the branch window can
// stop answering. Without these ceilings a panel sat on "Loading..." forever with no way
// back to the question form.
const FRAME_HANDSHAKE_TIMEOUT_MS = 25_000;
const BRANCH_RESPONSE_TIMEOUT_MS = 180_000;
let currentSelectionPayload: SelectionPayload | null = null;
let currentSelectionDraft: SelectionDraft | null = null;
let currentSelectionRect: DOMRect | null = null;
let extensionHost: HTMLDivElement | null = null;
let selectionToolbar: HTMLDivElement | null = null;
let askButton: HTMLButtonElement | null = null;
let whyButton: HTMLButtonElement | null = null;
let newTabButton: HTMLButtonElement | null = null;
let tabBar: HTMLDivElement | null = null;
let highlightOverlay: HTMLDivElement | null = null;
let highlightOverlayTimer: number | undefined;
let selectionTimer: number | undefined;
let lastKnownUrl = normalizeChatUrl(window.location.href);
let cleanupFns: Array<() => void> = [];
const panelRuntimes = new Map<string, PanelRuntime>();
let nativeLayoutObserver: MutationObserver | null = null;
let layoutSyncFrame: number | undefined;
let asideLauncher: HTMLButtonElement | null = null;
let themeObserver: MutationObserver | null = null;
let activeTheme: ThemeMode | null = null;
let pendingUrlChangeToken = 0;
let lastUsedBranchKind: BranchKind = 'persistent';
let isEvaluatingSelection = false;
let pendingDraftFocusPanelId: string | null = null;
// Panels the user closed on purpose. Everything else found in storage belongs to another
// conversation (or another tab) and has to survive a write from this page.
const closedPanelIds = new Set<string>();

/**
 * The provider that owns this document. Resolved once at init and never changed:
 * a selection made on ChatGPT runs its branch on ChatGPT, and a Claude selection
 * runs on Claude. There is no cross-provider transfer.
 */
let provider: ProviderAdapter = getAdapter('chatgpt');

/**
 * Discriminator that keeps pages without an addressable conversation — a new chat,
 * a project home, a shared link — from sharing one storage bucket. It is scoped to
 * this document, so a reload deliberately starts a new scope rather than adopting
 * somebody else's panels.
 */
const sessionDiscriminator = randomId('doc').slice(4);

function currentIdentity(url = lastKnownUrl): ConversationIdentity {
  return provider.identify(url, sessionDiscriminator);
}
let persistTimer: number | undefined;
let persistQueue: Promise<void> = Promise.resolve();
let toolbarSyncFrame: number | undefined;

/**
 * Raised when a requested private mode could not be positively verified. It is a
 * distinct type because the caller must never treat it as a generic automation
 * failure and retry in another mode.
 */
class PrivacyNotVerifiedError extends Error {
  readonly privacyBlocked = true;

  constructor(message: string) {
    super(message);
    this.name = 'PrivacyNotVerifiedError';
  }
}

function hasRuntimeAccess(): boolean {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isInvalidatedError(error: unknown): boolean {
  return error instanceof Error && /Extension context invalidated/i.test(error.message);
}

function isTopFrame(): boolean {
  return window.top === window.self;
}

function getConversationStorageKey(url = lastKnownUrl): string {
  return getPanelStorageKeyForConversationId(currentIdentity(url).scopeKey);
}

function formatDebugLogEntry(message: string, details?: unknown): string {
  let suffix = '';
  if (details !== undefined) {
    try {
      suffix = ` ${JSON.stringify(details)}`;
    } catch {
      suffix = ` ${String(details)}`;
    }
  }

  return `[${new Date().toISOString()}] ${message}${suffix}`;
}

function recordAutomationLog(message: string, details?: unknown): string {
  const entry = formatDebugLogEntry(message, details);
  console.info('[Aside]', entry);

  if (activeAttempt) {
    void sendAutomationEvent({
      kind: 'debug-log',
      message: entry
    });
  }

  return entry;
}

function appendPanelLog(runtime: PanelRuntime, message: string, details?: unknown): void {
  const entry = formatDebugLogEntry(message, details);
  runtime.state.debugLog = [...(runtime.state.debugLog ?? []), entry].slice(-250);
  runtime.state.updatedAt = Date.now();
  console.info('[Aside]', entry);
}

function appendPanelLogEntries(runtime: PanelRuntime, entries: string[]): void {
  if (!entries.length) {
    return;
  }

  runtime.state.debugLog = [...(runtime.state.debugLog ?? []), ...entries].slice(-250);
  runtime.state.updatedAt = Date.now();
}

/**
 * Panel persistence client.
 *
 * The tab no longer reads, merges and rewrites the panel store: the service worker
 * is the single authority. Each panel is proposed individually with the revision
 * this tab last saw, so a concurrent write from another tab is reported as a
 * conflict instead of being silently overwritten, and a panel closed elsewhere
 * stays closed.
 */
const panelRevisions = new Map<string, number>();
const dirtyPanelIds = new Set<string>();
const unsavedPanelIds = new Set<string>();
let sessionStorageUsable = true;

function storageAreaForPanel(state: Pick<BranchPanelState, 'branchKind'>): 'local' | 'session' {
  return state.branchKind === 'temporary' ? 'session' : 'local';
}

function markPanelDirty(panelId: string): void {
  dirtyPanelIds.add(panelId);
}

/** The last state successfully written for a panel, so unchanged panels are skipped. */
const lastWrittenSignatures = new Map<string, string>();

/**
 * What is actually worth writing.
 *
 * `updatedAt` is excluded deliberately: several call sites stamp it without
 * changing anything the user would notice, and writing for that alone bumps the
 * record's revision, which is what makes another tab's in-progress draft flip to
 * unsaved on unrelated activity here.
 */
function panelWriteSignature(state: BranchPanelState): string {
  const { updatedAt: _updatedAt, ...rest } = state;
  return JSON.stringify(rest);
}

function markAllPanelsDirty(): void {
  panelRuntimes.forEach((runtime) => dirtyPanelIds.add(runtime.state.panelId));
}

async function sendStoreMessage<T>(message: unknown): Promise<T | null> {
  if (!hasRuntimeAccess()) {
    return null;
  }

  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (!isInvalidatedError(error)) {
      console.warn('[Aside] Panel store message failed', error);
    }
    return null;
  }
}

/** Adopt an authoritative record for a panel this tab has mounted. */
function adoptAuthoritativeState(panelId: string, state: BranchPanelState, rev: number): void {
  const runtime = panelRuntimes.get(panelId);
  panelRevisions.set(panelId, rev);
  if (!runtime) {
    return;
  }

  // Never yank text out from under someone mid-sentence: if the user is typing in
  // this panel, keep their question and leave the panel marked unsaved.
  const editing = document.activeElement === runtime.questionInput;
  const localQuestion = runtime.questionInput.value;

  runtime.state = mergePanelStateOnConflict({
    local: runtime.state,
    theirs: state,
    localQuestion: editing ? localQuestion : state.initialQuestion ?? '',
    localDrivesBranch: tabDrivesBranch(runtime)
  });
  lastWrittenSignatures.set(panelId, panelWriteSignature(runtime.state));
  if (!editing) {
    runtime.questionInput.value = runtime.state.initialQuestion ?? '';
    unsavedPanelIds.delete(panelId);
  } else {
    // The user is typing here. Keep their text, but do NOT immediately write it
    // back: that would silently overwrite the other tab's draft. The panel shows
    // as unsaved until the user reaches a deliberate save point.
    unsavedPanelIds.add(panelId);
  }

  syncPanelUI(runtime);
  renderTabs();
}

async function writePanelRecord(runtime: PanelRuntime, attempt = 0): Promise<void> {
  const panelId = runtime.state.panelId;

  // Taken before the round trip, and recorded only on success. Reading it back
  // afterwards would mark as written whatever the user typed while the write was
  // in flight, and the next write would then skip it: the last few characters of
  // a draft would silently never be saved.
  const signature = panelWriteSignature(runtime.state);
  if (attempt === 0 && !unsavedPanelIds.has(panelId) && lastWrittenSignatures.get(panelId) === signature) {
    return;
  }

  const response = await sendStoreMessage<PanelWriteResponse>({
    type: 'PANEL_UPSERT',
    panelId,
    scopeKey: runtime.state.rootConversationId,
    area: storageAreaForPanel(runtime.state),
    baseRev: panelRevisions.get(panelId) ?? 0,
    state: runtime.state
  });

  if (!response) {
    runtime.element.dataset.storeStatus = 'no-response';
    unsavedPanelIds.add(panelId);
    return;
  }

  // The last write outcome, on the element, so the saved/unsaved state is
  // inspectable rather than only inferable.
  runtime.element.dataset.storeStatus = response.status;
  runtime.element.dataset.storeRev = String(response.rev ?? panelRevisions.get(panelId) ?? 0);

  if (response.status === 'applied' && typeof response.rev === 'number') {
    panelRevisions.set(panelId, response.rev);
    lastWrittenSignatures.set(panelId, signature);
    unsavedPanelIds.delete(panelId);

    // Anything typed while that write was in flight is still unwritten.
    if (panelWriteSignature(runtime.state) !== signature) {
      markPanelDirty(panelId);
      persistPanelsSoon(panelId);
    }
    return;
  }

  if (response.status === 'conflict' && response.current) {
    const theirs = response.current;
    panelRevisions.set(panelId, theirs.rev);

    const localQuestion = runtime.questionInput.value;
    const decision = resolveWriteConflict({
      localQuestion,
      theirQuestion: theirs.state.initialQuestion,
      attempt
    });

    if (decision.action === 'rebase') {
      appendPanelLog(runtime, 'Another tab wrote first; re-basing this draft onto it', {
        theirRev: theirs.rev,
        attempt: attempt + 1
      });
      runtime.state = {
        ...mergePanelStateOnConflict({
          local: runtime.state,
          theirs: theirs.state,
          localQuestion: decision.question,
          localDrivesBranch: tabDrivesBranch(runtime)
        }),
        updatedAt: Date.now()
      };
      await writePanelRecord(runtime, attempt + 1);
      return;
    }

    if (decision.action === 'keep-local-unsaved') {
      appendPanelLog(runtime, 'Could not save this draft; another tab keeps writing first', {
        theirRev: theirs.rev
      });
      runtime.state = mergePanelStateOnConflict({
        local: runtime.state,
        theirs: theirs.state,
        localQuestion: decision.question,
        localDrivesBranch: tabDrivesBranch(runtime)
      });
      unsavedPanelIds.add(panelId);
      syncPanelUI(runtime);
      return;
    }

    appendPanelLog(runtime, 'Another tab wrote this panel; adopting its version', {
      theirRev: theirs.rev
    });
    adoptAuthoritativeState(panelId, theirs.state, theirs.rev);
    return;
  }

  if (response.status === 'rejected-deleted') {
    // Closed in another tab. Honour that here rather than resurrecting it.
    appendPanelLog(runtime, 'Panel was closed in another tab; removing it here');
    clearPanelWatchdog(runtime);
    runtime.iframeEl.src = 'about:blank';
    runtime.element.remove();
    panelRuntimes.delete(panelId);
    panelRevisions.delete(panelId);
    unsavedPanelIds.delete(panelId);
    renderTabs();
    return;
  }

  if (response.unsaved) {
    unsavedPanelIds.add(panelId);
    if (storageAreaForPanel(runtime.state) === 'session') {
      sessionStorageUsable = false;
    }
    syncPanelUI(runtime);
  }
}

async function flushPanelWrites(): Promise<void> {
  const pending = [...dirtyPanelIds];
  dirtyPanelIds.clear();

  for (const panelId of pending) {
    const runtime = panelRuntimes.get(panelId);
    if (!runtime) {
      continue;
    }
    await writePanelRecord(runtime);
  }
}

function queuePersistWrite(): Promise<void> {
  persistQueue = persistQueue.catch(() => {}).then(() => flushPanelWrites());
  return persistQueue;
}

function cancelPendingPersist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
}

/**
 * Structural changes (create, minimize, close, status transitions) are written
 * straight away, because the user may navigate immediately afterwards.
 */
function persistPanels(panelId?: string): void {
  if (!hasRuntimeAccess()) {
    return;
  }

  // Only the panel that changed is written. Marking every mounted panel dirty
  // meant a page with a full rail issued a write per panel on every interaction,
  // which is both wasteful and a reliable way to lose a race with another tab.
  if (panelId) {
    markPanelDirty(panelId);
  } else {
    markAllPanelsDirty();
  }

  cancelPendingPersist();
  void queuePersistWrite();
}

/** Typing and streaming diagnostics coalesce instead of writing per keystroke. */
function persistPanelsSoon(panelId?: string): void {
  if (!hasRuntimeAccess()) {
    return;
  }

  if (panelId) {
    markPanelDirty(panelId);
  } else {
    markAllPanelsDirty();
  }

  if (persistTimer !== undefined) {
    return;
  }

  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    void queuePersistWrite();
  }, PERSIST_DEBOUNCE_MS);
}

async function flushPersistedPanels(): Promise<void> {
  markAllPanelsDirty();
  cancelPendingPersist();
  await queuePersistWrite();
}

/** True when the deletion was recorded, so the panel will stay closed. */
async function deletePanelRecord(panelId: string): Promise<boolean> {
  const response = await sendStoreMessage<PanelWriteResponse>({
    type: 'PANEL_DELETE',
    panelId,
    baseRev: panelRevisions.get(panelId) ?? 0
  });

  // No tombstone means no deletion: the record is still in storage, and the next
  // reload — or any other tab, right now — will bring this panel back. Closing it
  // in the DOM here would only hide that until it reappeared.
  if (!response?.ok) {
    return false;
  }

  panelRevisions.delete(panelId);
  unsavedPanelIds.delete(panelId);
  dirtyPanelIds.delete(panelId);
  lastWrittenSignatures.delete(panelId);
  return true;
}

async function listPanelRecords(): Promise<PanelListedRecord[]> {
  const response = await sendStoreMessage<PanelListResponse>({ type: 'PANEL_LIST' });
  if (!response?.ok) {
    return [];
  }
  if (response.sessionUnavailable) {
    sessionStorageUsable = false;
  }
  return response.records;
}

/**
 * One-time migration from the previous whole-bucket format.
 *
 * Records are written through the authority first; the legacy keys are only
 * removed once every panel has been confirmed stored, so an interrupted or
 * repeated migration leaves the original data intact.
 */
async function migrateLegacyPanelStorage(): Promise<void> {
  if (!hasRuntimeAccess()) {
    return;
  }

  try {
    const stored = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const legacyKeys = Object.keys(stored).filter(
      (key) => isPanelStorageKey(key) || key.startsWith(LEGACY_PANEL_STORAGE_PREFIX)
    );

    if (!legacyKeys.length) {
      return;
    }

    const migrated: string[] = [];
    let allConfirmed = true;

    for (const key of legacyKeys) {
      const panels = Array.isArray(stored[key]) ? (stored[key] as BranchPanelState[]) : [];
      for (const panel of panels) {
        if (!panel?.panelId) {
          continue;
        }

        const response = await sendStoreMessage<PanelWriteResponse>({
          type: 'PANEL_UPSERT',
          panelId: panel.panelId,
          scopeKey: panel.rootConversationId || currentIdentity(panel.rootChatUrl).scopeKey,
          area: storageAreaForPanel(panel),
          baseRev: 0,
          state: panel
        });

        // 'rejected-deleted' and 'conflict' both mean the authority already knows
        // better than this legacy row, so they count as successfully handled.
        const settled =
          response?.status === 'applied' ||
          response?.status === 'conflict' ||
          response?.status === 'rejected-deleted' ||
          response?.status === 'noop';
        if (!settled) {
          allConfirmed = false;
        }
      }
      migrated.push(key);
    }

    if (allConfirmed && migrated.length) {
      await chrome.storage.local.remove(migrated);
      console.info('[Aside] Migrated legacy panel storage', { buckets: migrated.length });
    } else if (!allConfirmed) {
      console.warn('[Aside] Legacy panel storage was kept because migration was incomplete');
    }

    const legacyKindKey = LEGACY_LAST_BRANCH_KIND_STORAGE_KEY;
    if (legacyKindKey in stored && !(branchKindStorageKey() in stored)) {
      await chrome.storage.local.set({ [branchKindStorageKey()]: stored[legacyKindKey] });
    }
  } catch (error) {
    if (!isInvalidatedError(error)) {
      console.warn('[Aside] Legacy panel migration failed; existing data was left alone', error);
    }
  }
}

/**
 * Mode preference is per provider: "Temporary Chat" on ChatGPT and "Incognito" on
 * Claude are different features with different guarantees, and a choice made on one
 * must not silently become the default on the other.
 */
function branchKindStorageKey(): string {
  return `${LAST_BRANCH_KIND_STORAGE_KEY}:${provider.id}`;
}

async function loadLastUsedBranchKind(): Promise<void> {
  if (!hasRuntimeAccess()) {
    lastUsedBranchKind = 'persistent';
    return;
  }

  const key = branchKindStorageKey();
  try {
    const stored = (await chrome.storage.local.get(key)) as Record<string, unknown>;
    lastUsedBranchKind = stored[key] === 'temporary' ? 'temporary' : 'persistent';
  } catch (error) {
    if (!isInvalidatedError(error)) {
      throw error;
    }
    lastUsedBranchKind = 'persistent';
  }
}

function persistLastUsedBranchKind(kind: BranchKind): void {
  lastUsedBranchKind = kind;
  if (!hasRuntimeAccess()) {
    return;
  }

  void chrome.storage.local
    .set({ [branchKindStorageKey()]: kind })
    .catch((error) => {
      if (!isInvalidatedError(error)) {
        console.warn('[Aside] Failed to persist branch kind', error);
      }
    });
}

async function createNativeBranchWindow(options: {
  attempt: BranchAttemptRef;
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
  focusWindow?: boolean;
  arrangeSideBySide?: boolean;
}): Promise<CreateBranchWindowResponse> {
  if (!hasRuntimeAccess()) {
    return {
      ok: false,
      reason: 'Chrome extension runtime is unavailable.'
    };
  }

  try {
    return (await chrome.runtime.sendMessage({
      type: 'CREATE_BRANCH_WINDOW',
      ...options.attempt,
      prompt: options.prompt,
      launchUrl: options.launchUrl,
      branchKind: options.branchKind,
      focusWindow: options.focusWindow,
      arrangeSideBySide: options.arrangeSideBySide
    })) as CreateBranchWindowResponse;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function focusNativeBranchWindow(options: {
  panelId: string;
  launchTabId?: number;
  launchWindowId?: number;
  branchChatUrl?: string;
}): Promise<FocusBranchWindowResponse> {
  if (!hasRuntimeAccess()) {
    return {
      ok: false,
      reason: 'Chrome extension runtime is unavailable.'
    };
  }

  try {
    return (await chrome.runtime.sendMessage({
      type: 'FOCUS_BRANCH_WINDOW',
      panelId: options.panelId,
      launchTabId: options.launchTabId,
      launchWindowId: options.launchWindowId,
      branchChatUrl: options.branchChatUrl
    })) as FocusBranchWindowResponse;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function detectChatGptTheme(): ThemeMode {
  const themeCandidates = [document.documentElement, document.body].filter(
    (element): element is HTMLElement => element instanceof HTMLElement
  );

  for (const element of themeCandidates) {
    const dataTheme = element.dataset.theme?.toLowerCase();
    if (dataTheme === 'dark' || dataTheme === 'light') {
      return dataTheme;
    }

    const attrTheme = element.getAttribute('data-theme')?.toLowerCase();
    if (attrTheme === 'dark' || attrTheme === 'light') {
      return attrTheme;
    }

    if (element.classList.contains('dark')) {
      return 'dark';
    }
  }

  for (const element of themeCandidates) {
    const colorScheme = window.getComputedStyle(element).colorScheme.toLowerCase();
    if (colorScheme.includes('dark')) {
      return 'dark';
    }
    if (colorScheme.includes('light')) {
      return 'light';
    }
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme = detectChatGptTheme()): void {
  if (activeTheme === theme) {
    return;
  }

  activeTheme = theme;
  document.documentElement.dataset.asideTheme = theme;
}

function installThemeObserver(): void {
  applyTheme();

  themeObserver?.disconnect();
  themeObserver = new MutationObserver(() => {
    applyTheme();
  });

  const observerConfig: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style']
  };

  themeObserver.observe(document.documentElement, observerConfig);
  if (document.body) {
    themeObserver.observe(document.body, observerConfig);
  }

  const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  const colorSchemeListener = () => applyTheme();
  colorSchemeMedia.addEventListener('change', colorSchemeListener);

  cleanupFns.push(() => {
    themeObserver?.disconnect();
    themeObserver = null;
    colorSchemeMedia.removeEventListener('change', colorSchemeListener);
  });
}

function ensureStyles(): void {
  const css = `
    html[data-aside-theme="light"] {
      --sb-color-scheme: light;
      --sb-text: #111827;
      --sb-muted: #6b7280;
      --sb-border: rgba(15, 23, 42, 0.08);
      --sb-border-strong: rgba(15, 23, 42, 0.14);
      --sb-panel-bg: rgba(255, 255, 255, 0.98);
      --sb-panel-header-bg: rgba(249, 250, 251, 0.95);
      --sb-surface-bg: rgba(248, 250, 252, 0.96);
      --sb-input-bg: #ffffff;
      --sb-frame-bg: #ffffff;
      --sb-frame-overlay: rgba(249, 250, 251, 0.96);
      --sb-primary: #111827;
      --sb-primary-text: #ffffff;
      --sb-chip-bg: rgba(255, 255, 255, 0.98);
      --sb-shadow-chip: 0 10px 26px rgba(15, 23, 42, 0.12);
      --sb-shadow-panel: 0 28px 80px rgba(15, 23, 42, 0.16);
      --sb-danger: #991b1b;
      --sb-danger-muted: #4b5563;
    }

    html[data-aside-theme="dark"] {
      --sb-color-scheme: dark;
      --sb-text: #f3f4f6;
      --sb-muted: #9ca3af;
      --sb-border: rgba(148, 163, 184, 0.18);
      --sb-border-strong: rgba(148, 163, 184, 0.28);
      --sb-panel-bg: rgba(15, 23, 42, 0.94);
      --sb-panel-header-bg: rgba(17, 24, 39, 0.96);
      --sb-surface-bg: rgba(30, 41, 59, 0.9);
      --sb-input-bg: rgba(15, 23, 42, 0.82);
      --sb-frame-bg: rgba(15, 23, 42, 0.96);
      --sb-frame-overlay: rgba(15, 23, 42, 0.92);
      --sb-primary: #10a37f;
      --sb-primary-text: #f9fafb;
      --sb-chip-bg: rgba(17, 24, 39, 0.96);
      --sb-shadow-chip: 0 12px 26px rgba(0, 0, 0, 0.35);
      --sb-shadow-panel: 0 28px 80px rgba(0, 0, 0, 0.45);
      --sb-danger: #fca5a5;
      --sb-danger-muted: #d1d5db;
    }

    #${EXTENSION_HOST_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483643;
      pointer-events: none;
    }

    #${EXTENSION_HOST_ID} > * {
      pointer-events: auto;
    }

    html[data-aside-theme] #${SELECTION_TOOLBAR_ID},
    html[data-aside-theme] #${PANEL_TABBAR_ID},
    html[data-aside-theme] .${PANEL_CLASS} {
      color-scheme: var(--sb-color-scheme, light);
    }

    #${SELECTION_TOOLBAR_ID} {
      position: fixed;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      border-radius: 999px;
      padding: 8px;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
      backdrop-filter: blur(18px);
    }

    #${SELECTION_TOOLBAR_ID}[hidden] {
      display: none;
    }

    #${SELECTION_TOOLBAR_ID} button {
      border: none;
      border-radius: 999px;
      padding: 10px 14px;
      font: 600 13px/1.1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }

    #${ASK_BUTTON_ID} {
      background: var(--sb-primary, #111827);
      color: var(--sb-primary-text, #ffffff);
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.22);
    }

    #${WHY_BUTTON_ID},
    #${NEW_TAB_BUTTON_ID} {
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-text, #111827);
    }

    #${SELECTION_TOOLBAR_ID} button:hover,
    #${SELECTION_TOOLBAR_ID} button:focus-visible {
      transform: translateY(-1px);
    }

    .aside-toolbar-brand {
      display: inline-flex;
      align-items: center;
      padding-right: 2px;
      font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.62;
      user-select: none;
    }

    .aside-privacy-note {
      font-size: 11px;
      line-height: 1.45;
      color: var(--sb-muted, #6b7280);
      margin: 6px 0 0;
    }
    .aside-privacy-note summary {
      cursor: pointer;
    }
    .aside-privacy-warning {
      margin: 6px 0 0;
      color: var(--sb-text, #111827);
      font-weight: 600;
    }
    .aside-privacy-note ul {
      margin: 6px 0 0;
      padding-left: 16px;
      display: grid;
      gap: 4px;
    }
    .aside-kind-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      padding: 6px;
      border-radius: 999px;
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-kind-toggle button {
      border: none;
      border-radius: 999px;
      padding: 8px 12px;
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      background: transparent;
      color: var(--sb-muted, #6b7280);
    }

    .aside-kind-toggle button[data-selected="true"] {
      background: var(--sb-primary, #111827);
      color: var(--sb-primary-text, #ffffff);
    }

    #${PANEL_TABBAR_ID} {
      --sb-tab-width: 96px;
      position: fixed;
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: var(--sb-tab-width);
      overflow-y: auto;
      overflow-x: visible;
      overscroll-behavior: contain;
      padding-right: 0;
      align-items: stretch;
      pointer-events: none;
      scrollbar-width: none;
    }

    /* Geometry comes from findLeftGutterSlot; these are only the fallbacks used
       before the first measurement. */
    #${PANEL_TABBAR_ID}[data-placement="left-gutter"] {
      top: 96px;
      bottom: 20px;
      left: 12px;
    }

    #${ASIDE_LAUNCHER_ID} {
      position: fixed;
      z-index: 2147483645;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      background: var(--sb-chip-bg, rgba(255, 255, 255, 0.98));
      color: var(--sb-text, #111827);
      font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, sans-serif;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
    }

    #${ASIDE_LAUNCHER_ID}[hidden] {
      display: none;
    }

    #${PANEL_TABBAR_ID}[hidden] {
      display: none;
    }

    .aside-tab {
      display: flex;
      align-items: stretch;
      flex-direction: column;
      gap: 6px;
      width: var(--sb-tab-width);
      min-width: var(--sb-tab-width);
      box-sizing: border-box;
      padding: 10px 10px 12px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      border-radius: 18px;
      background: var(--sb-chip-bg, rgba(255, 255, 255, 0.98));
      box-shadow: var(--sb-shadow-chip, 0 10px 26px rgba(15, 23, 42, 0.12));
      color: var(--sb-text, #111827);
      font: 600 13px/1.1 ui-sans-serif, system-ui, sans-serif;
      transition:
        background 180ms ease,
        box-shadow 180ms ease;
      pointer-events: auto;
    }

    .aside-tab:hover,
    .aside-tab:focus-within {
      box-shadow: var(--sb-shadow-panel, 0 18px 48px rgba(15, 23, 42, 0.18));
    }

    .aside-tab button {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
    }

    .aside-tab button:first-child {
      display: -webkit-box;
      overflow: hidden;
      min-height: 30px;
      text-align: left;
      text-overflow: ellipsis;
      white-space: normal;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-height: 1.2;
    }

    .aside-tab small {
      display: inline-flex;
      align-self: flex-start;
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-muted, #6b7280);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
    }

    .aside-tab-close {
      align-self: flex-end;
      color: #9ca3af !important;
      font-size: 14px !important;
      line-height: 1 !important;
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }

    .aside-tab:hover .aside-tab-close,
    .aside-tab:focus-within .aside-tab-close {
      opacity: 1;
      pointer-events: auto;
    }

    .aside-tab button:first-child:focus-visible,
    .aside-tab-close:focus-visible {
      outline: 2px solid rgba(37, 99, 235, 0.45);
      outline-offset: 2px;
      border-radius: 10px;
    }

    .aside-tab small {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .${PANEL_CLASS} {
      position: fixed;
      top: 80px;
      right: 16px;
      width: min(460px, calc(100vw - 32px));
      max-height: min(82vh, 980px);
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
      box-shadow: var(--sb-shadow-panel, 0 28px 80px rgba(15, 23, 42, 0.16));
      backdrop-filter: blur(18px);
    }

    .${PANEL_CLASS}[hidden] {
      display: none;
    }

    .aside-panel-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-header-bg, rgba(249, 250, 251, 0.95));
    }

    .aside-panel-heading h2 {
      margin: 0;
      font: 700 18px/1.18 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-text, #111827);
    }

    .aside-panel-heading p {
      margin: 6px 0 0;
      font: 500 13px/1.4 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }

    .aside-panel-heading .aside-error-copy {
      margin-top: 8px;
      color: var(--sb-danger, #991b1b);
      white-space: pre-wrap;
    }

    .aside-panel-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .aside-panel-actions button,
    .aside-panel-primary,
    .aside-panel-secondary {
      border-radius: 999px;
      padding: 9px 12px;
      font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-text, #111827);
    }

    .aside-panel-primary {
      border: none;
      background: var(--sb-primary, #111827);
      color: var(--sb-primary-text, #ffffff);
    }

    .aside-panel-secondary {
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-panel-body {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-focus {
      padding: 14px 18px 16px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-focus small {
      display: block;
      margin-bottom: 8px;
      font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sb-muted, #6b7280);
    }

    .aside-focus p {
      margin: 0;
      color: var(--sb-text, #111827);
      font: 500 14px/1.45 ui-sans-serif, system-ui, sans-serif;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 5;
      overflow: hidden;
    }

    .aside-launcher {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-launcher textarea {
      width: 100%;
      min-height: 96px;
      resize: vertical;
      box-sizing: border-box;
      border-radius: 16px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      background: var(--sb-input-bg, #ffffff);
      color: var(--sb-text, #111827);
      padding: 14px 16px;
      font: 500 14px/1.45 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-launcher textarea:disabled {
      opacity: 0.7;
      cursor: default;
    }

    .aside-launcher-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .aside-launcher button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .aside-frame-shell {
      position: relative;
      min-height: 380px;
      flex: 1 1 auto;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-frame-shell[hidden] {
      display: none !important;
    }

    .aside-frame {
      display: block;
      width: 100%;
      min-height: 560px;
      height: min(72vh, 900px);
      border: 0;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-frame-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
      text-align: center;
      background:
        linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.78),
          rgba(255, 255, 255, 0.9)
        );
      backdrop-filter: blur(6px);
    }

    :root[data-aside-theme="dark"] .aside-frame-overlay {
      background:
        linear-gradient(
          180deg,
          rgba(15, 23, 42, 0.72),
          rgba(15, 23, 42, 0.88)
        );
    }

    .aside-frame-overlay[hidden] {
      display: none !important;
    }

    .aside-frame-overlay-card {
      max-width: 360px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .aside-frame-overlay-title {
      margin: 0;
      color: var(--sb-text, #111827);
      font: 700 15px/1.35 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-frame-overlay-text {
      margin: 0;
      color: var(--sb-muted, #6b7280);
      font: 500 13px/1.5 ui-sans-serif, system-ui, sans-serif;
      white-space: pre-wrap;
    }

    .aside-context {
      margin: 8px 0 4px;
      padding: 8px 10px;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.1));
      border-radius: 12px;
      background: var(--sb-subtle-bg, rgba(15, 23, 42, 0.03));
      font-size: 12px;
    }

    .aside-context > summary {
      cursor: pointer;
      font-weight: 600;
      user-select: none;
    }

    .aside-context-source {
      margin: 6px 0 4px;
      opacity: 0.7;
    }

    .aside-context-block {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      margin: 4px 0;
      line-height: 1.4;
    }

    .aside-context-limitation {
      display: block;
      width: 100%;
      opacity: 0.7;
    }

    .aside-context-background {
      display: block;
      margin: 8px 0 4px;
    }

    .aside-context-background textarea {
      width: 100%;
      margin-top: 4px;
      box-sizing: border-box;
      font: inherit;
    }

    .aside-context-size[data-over-budget="true"] {
      color: var(--sb-danger, #b91c1c);
      font-weight: 600;
    }

    .aside-context-preview-label {
      margin: 8px 0 4px;
      opacity: 0.7;
    }

    .aside-context-preview {
      max-height: 180px;
      overflow: auto;
      margin: 0;
      padding: 8px;
      border-radius: 8px;
      background: var(--sb-code-bg, rgba(15, 23, 42, 0.06));
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 11px;
      line-height: 1.45;
    }

    .aside-debug-log {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-debug-log[hidden] {
      display: none !important;
    }

    .aside-debug-log strong {
      color: var(--sb-text, #111827);
      font: 700 14px/1.35 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-debug-log p {
      margin: 0;
      color: var(--sb-muted, #6b7280);
      font: 500 13px/1.45 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-debug-log textarea {
      width: 100%;
      min-height: 180px;
      resize: vertical;
      box-sizing: border-box;
      border-radius: 14px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      background: var(--sb-input-bg, #ffffff);
      color: var(--sb-text, #111827);
      padding: 12px;
      font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre;
    }

    .aside-debug-log-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .aside-origin-outline {
      position: absolute;
      pointer-events: none;
      border-radius: 10px;
      outline: 3px solid rgba(16, 185, 129, 0.6);
      outline-offset: 6px;
    }

    #${HIGHLIGHT_OVERLAY_ID} {
      pointer-events: none;
      position: fixed;
      inset: 0;
      z-index: 2147483644;
    }

    #${HIGHLIGHT_OVERLAY_ID} .aside-highlight-rect {
      position: fixed;
      border-radius: 10px;
      background: rgba(16, 185, 129, 0.18);
      box-shadow: 0 0 0 2px rgba(5, 150, 105, 0.22);
    }
  `;

  const existing = document.getElementById(ROOT_STYLE_ID);
  if (existing instanceof HTMLStyleElement && existing.textContent === css) {
    return;
  }

  // A stylesheet left behind by a previous build of the extension, which an
  // in-place update does not remove: without this, the new content script finds
  // the old id, returns early, and runs against the old build's CSS for the life
  // of the tab.
  existing?.remove();

  const style = document.createElement('style');
  style.id = ROOT_STYLE_ID;
  style.textContent = css;
  document.head.append(style);
  cleanupFns.push(() => style.remove());
}

/**
 * Forces provider controls visible and clickable so automation can drive them.
 *
 * This is a blunt override of provider rendering, so it is installed ONLY in the
 * branch surface Aside is driving — never in the page the user is reading. It is
 * also removed on cleanup rather than left behind.
 */
function ensureFrameAutomationStyles(): void {
  if (document.getElementById(FRAME_AUTOMATION_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = FRAME_AUTOMATION_STYLE_ID;
  style.textContent = `
    article[data-message-author-role] [class*="opacity-0"],
    article[data-message-author-role] [class*="invisible"],
    article[data-message-author-role] [class*="pointer-events-none"],
    main [data-testid^="conversation-turn-"] [class*="opacity-0"],
    main [data-testid^="conversation-turn-"] [class*="invisible"],
    main [data-testid^="conversation-turn-"] [class*="pointer-events-none"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }

    article[data-message-author-role] button,
    article[data-message-author-role] [role="button"],
    main [data-testid^="conversation-turn-"] button,
    main [data-testid^="conversation-turn-"] [role="button"] {
      pointer-events: auto !important;
    }
  `;
  document.head.append(style);
  cleanupFns.push(() => style.remove());
}

function ensureExtensionHost(): HTMLDivElement {
  if (extensionHost?.isConnected && extensionHost.parentElement === document.documentElement) {
    return extensionHost;
  }

  if (!extensionHost) {
    const existing = document.getElementById(EXTENSION_HOST_ID);
    if (existing && !(existing instanceof HTMLDivElement)) {
      existing.remove();
    } else if (existing instanceof HTMLDivElement) {
      existing.replaceChildren();
    }
  }

  extensionHost = ensureExtensionHostElement(document, EXTENSION_HOST_ID);
  return extensionHost;
}

function mountInExtensionHost<T extends HTMLElement>(element: T): T {
  return attachElementToHost(ensureExtensionHost(), element);
}

function ensureSelectionToolbar(): HTMLDivElement {
  if (!selectionToolbar) {
    document.getElementById(SELECTION_TOOLBAR_ID)?.remove();

    selectionToolbar = document.createElement('div');
    selectionToolbar.id = SELECTION_TOOLBAR_ID;
    selectionToolbar.hidden = true;
    // The toolbar is Aside's, and says so: it sits next to the provider's own
    // selection actions rather than replacing them.
    selectionToolbar.setAttribute('role', 'toolbar');
    selectionToolbar.setAttribute('aria-label', 'Aside branch actions');

    const brand = document.createElement('span');
    brand.className = 'aside-toolbar-brand';
    brand.textContent = 'Aside';
    brand.setAttribute('aria-hidden', 'true');

    askButton = document.createElement('button');
    askButton.id = ASK_BUTTON_ID;
    askButton.type = 'button';
    askButton.textContent = 'Ask';
    askButton.setAttribute('aria-label', 'Ask in Aside about the selected passage');

    whyButton = document.createElement('button');
    whyButton.id = WHY_BUTTON_ID;
    whyButton.type = 'button';
    whyButton.textContent = 'Why';
    whyButton.setAttribute('aria-label', 'Ask in Aside why the selected passage holds');

    newTabButton = document.createElement('button');
    newTabButton.id = NEW_TAB_BUTTON_ID;
    newTabButton.type = 'button';
    newTabButton.textContent = 'New-tab';
    newTabButton.setAttribute('aria-label', 'Open an Aside branch in a new window');

    askButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftFromCurrentSelection('ask');
    });
    whyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftFromCurrentSelection('why');
    });
    newTabButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftFromCurrentSelection('new_tab');
    });

    selectionToolbar.append(brand, askButton, whyButton, newTabButton);
  }

  return mountInExtensionHost(selectionToolbar);
}

function hideSelectionToolbar(): void {
  if (selectionToolbar) {
    selectionToolbar.hidden = true;
  }
}

function hideAskButton(clearSelection = true): void {
  if (clearSelection) {
    currentSelectionDraft = null;
    currentSelectionPayload = null;
    currentSelectionRect = null;
  }
  hideSelectionToolbar();
}

function getSelectionDraftFromWindow(): SelectionDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  try {
    return captureSelectionDraftFromRange(selection.getRangeAt(0));
  } catch {
    return null;
  }
}

function materializeSelectionPayload(
  draft: SelectionDraft | null | undefined
): SelectionPayload | null {
  if (!draft) {
    return null;
  }

  try {
    return buildSelectionPayloadFromDraft(draft);
  } catch {
    return null;
  }
}

/**
 * A selection taken inside a private chat defaults to a private branch, whatever the
 * user last chose elsewhere. Inheriting a remembered "Persistent" default here is how
 * a passage the user deliberately kept out of history ends up saved to it.
 */
function getBranchKindForNewDraft(): BranchKind {
  if (currentIdentity().urlPrivacyHint === 'private') {
    return 'temporary';
  }
  return lastUsedBranchKind;
}

function openDraftFromCurrentSelection(entryAction: BranchEntryAction): void {
  const draft = currentSelectionDraft ?? getSelectionDraftFromWindow();
  const payload = currentSelectionPayload ?? materializeSelectionPayload(draft);
  if (!payload) {
    hideAskButton();
    return;
  }
  currentSelectionPayload = payload;

  const branchKind = getBranchKindForNewDraft();
  if (entryAction === 'new_tab') {
    void openSelectionInNewTab(payload, branchKind);
  } else if (entryAction === 'why') {
    createBranchDraft(payload, {
      entryAction,
      branchKind,
      initialQuestion: 'Why?',
      autoStart: true
    });
  } else {
    createBranchDraft(payload, {
      entryAction,
      branchKind
    });
  }
  // Deliberately does NOT clear the selection: the provider's native selection
  // options must remain usable after Aside has been invoked.
  hideAskButton(false);
}

function toRect(domRect: DOMRect | { top: number; left: number; width: number; height: number }): Rect {
  return { top: domRect.top, left: domRect.left, width: domRect.width, height: domRect.height };
}

/**
 * Measure — never modify — the provider rectangles Aside must stay clear of.
 *
 * Elements are read with getBoundingClientRect only. Nothing here changes styles,
 * attributes, event handlers or hit targets on provider DOM.
 */
function collectReservedRegions(includeSelectionToolbar = true): Rect[] {
  const selectors = provider.layout.reservedRegionSelectors.map((entry) => entry.selector);
  if (includeSelectionToolbar) {
    selectors.push(...provider.layout.nativeSelectionToolbarSelectors);
  }

  const seen = new Set<Element>();
  const rects: Rect[] = [];

  selectors.forEach((selector) => {
    let matches: HTMLElement[];
    try {
      matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    } catch {
      return;
    }

    matches.forEach((element) => {
      if (seen.has(element) || isAsideOwned(element)) {
        return;
      }
      seen.add(element);

      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        rects.push(toRect(rect));
      }
    });
  });

  return rects;
}

/** True for nodes inside Aside's own host, so shared logic never mistakes them for provider UI. */
function isAsideOwned(node: Node | null): boolean {
  if (!node) {
    return false;
  }
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(`#${EXTENSION_HOST_ID}`));
}

function positionSelectionToolbar(rect: DOMRect): void {
  const toolbar = ensureSelectionToolbar();
  currentSelectionRect = rect;

  // Make it measurable before deciding where it goes: guessing a width is how the
  // toolbar used to end up on top of the provider's own selection menu.
  toolbar.hidden = false;
  toolbar.style.visibility = 'hidden';
  const measured = toolbar.getBoundingClientRect();
  const size = {
    width: measured.width || 236,
    height: measured.height || 40
  };

  const placement = findSafePlacement({
    anchor: toRect(rect),
    size,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    reserved: collectReservedRegions()
  });

  if (!placement) {
    // No safe spot around the selection. Rather than covering a native control or
    // winning with z-index, collapse to the compact launcher in the left rail.
    toolbar.hidden = true;
    toolbar.style.visibility = '';
    setCompactLauncherVisible(true);
    return;
  }

  setCompactLauncherVisible(false);
  toolbar.style.top = `${placement.top}px`;
  toolbar.style.left = `${placement.left}px`;
  toolbar.dataset.side = placement.side;
  toolbar.style.visibility = '';
}

// The toolbar is positioned with viewport coordinates, so it has to be re-anchored
// whenever the passage moves under it.
function getLiveSelectionRect(): DOMRect | null {
  const draft = currentSelectionDraft;
  if (!draft) {
    return null;
  }

  try {
    const rect = Array.from(draft.range.getClientRects()).find(
      (candidate) => candidate.width > 0 || candidate.height > 0
    );
    return rect ? new DOMRect(rect.x, rect.y, rect.width, rect.height) : null;
  } catch {
    return null;
  }
}

// The scroll listener is capturing, so it sees every scrollable element on the page.
// Coalesce to one measurement per frame: getClientRects() forces layout.
function scheduleSelectionToolbarSync(): void {
  if (!selectionToolbar || selectionToolbar.hidden || toolbarSyncFrame !== undefined) {
    return;
  }

  toolbarSyncFrame = window.requestAnimationFrame(() => {
    toolbarSyncFrame = undefined;
    syncSelectionToolbarToViewport();
  });
}

function syncSelectionToolbarToViewport(): void {
  if (!selectionToolbar || selectionToolbar.hidden) {
    return;
  }

  const rect = getLiveSelectionRect();
  if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) {
    hideSelectionToolbar();
    return;
  }

  currentSelectionRect = rect;
  positionSelectionToolbar(rect);
}

function isElementVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity || '1') > 0.01
  );
}

function evaluateSelection(): void {
  if (isEvaluatingSelection) {
    return;
  }

  isEvaluatingSelection = true;
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideAskButton();
      return;
    }

    const anchorNode =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;

    if (anchorNode?.closest(`.${PANEL_CLASS}, #${PANEL_TABBAR_ID}`)) {
      hideAskButton();
      return;
    }

    const range = selection.getRangeAt(0);
    if (!rangeTouchesAssistantMessage(range)) {
      hideAskButton();
      return;
    }

    const draft = captureSelectionDraftFromRange(range);
    if (!draft || draft.selectedText.length < MIN_SELECTION_LENGTH) {
      hideAskButton();
      return;
    }

    currentSelectionDraft = draft;
    currentSelectionPayload = null;
    currentSelectionRect = draft.selectionRect;
    positionSelectionToolbar(draft.selectionRect);
  } catch {
    hideAskButton();
  } finally {
    isEvaluatingSelection = false;
  }
}

/**
 * Aside used to hide the provider's own selection actions to make room for itself.
 * That behaviour is gone. This only removes the class an older build may still have
 * left on a provider button, so an upgrade does not leave a native control hidden.
 * It touches nothing else and runs once per document.
 */
function undoLegacySelectionSuppression(): void {
  document
    .querySelectorAll<HTMLElement>('.aside-selection-suppressed')
    .forEach((element) => element.classList.remove('aside-selection-suppressed'));
}

/**
 * Watch for provider layout changes so Aside can re-measure and move itself.
 *
 * Deliberately observes only what affects geometry, never mutates what it sees, and
 * ignores mutations inside Aside's own host so it cannot retrigger itself.
 */
function installNativeLayoutObserver(): void {
  nativeLayoutObserver?.disconnect();
  nativeLayoutObserver = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (isAsideOwned(mutation.target)) {
        return false;
      }
      return (
        mutation.type === 'attributes' ||
        mutation.addedNodes.length > 0 ||
        mutation.removedNodes.length > 0
      );
    });

    if (relevant) {
      scheduleLayoutSync();
    }
  });

  nativeLayoutObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state'],
    childList: true,
    subtree: true
  });

  cleanupFns.push(() => {
    nativeLayoutObserver?.disconnect();
    nativeLayoutObserver = null;
    if (layoutSyncFrame !== undefined) {
      window.cancelAnimationFrame(layoutSyncFrame);
      layoutSyncFrame = undefined;
    }
  });
}

/** One measurement per frame, however many mutations arrive. */
function scheduleLayoutSync(): void {
  if (layoutSyncFrame !== undefined) {
    return;
  }

  layoutSyncFrame = window.requestAnimationFrame(() => {
    layoutSyncFrame = undefined;
    positionTabBar();
    syncSelectionToolbarToViewport();
  });
}

function ensureCompactLauncher(): HTMLButtonElement {
  if (!asideLauncher) {
    document.getElementById(ASIDE_LAUNCHER_ID)?.remove();
    asideLauncher = document.createElement('button');
    asideLauncher.id = ASIDE_LAUNCHER_ID;
    asideLauncher.type = 'button';
    asideLauncher.hidden = true;
    asideLauncher.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (currentSelectionDraft && currentSelectionRect) {
        openDraftFromCurrentSelection('ask');
        return;
      }
      const firstMinimized = sortPanels().find((runtime) => runtime.state.minimized);
      if (firstMinimized) {
        expandPanel(firstMinimized.state.panelId);
      }
    });
  }

  return mountInExtensionHost(asideLauncher);
}

/**
 * The compact entry used when there is no safe room for the full toolbar or rail.
 * It is placed in verified free space; it never covers an interactive native control.
 */
function setCompactLauncherVisible(visible: boolean): void {
  const launcher = ensureCompactLauncher();
  if (!visible) {
    launcher.hidden = true;
    return;
  }

  const minimizedCount = sortPanels().filter((runtime) => runtime.state.minimized).length;
  launcher.textContent = minimizedCount ? `Aside (${minimizedCount})` : 'Aside';
  launcher.setAttribute(
    'aria-label',
    minimizedCount ? `Aside: ${minimizedCount} minimized branches` : 'Aside branch actions'
  );
  launcher.hidden = false;

  const size = launcher.getBoundingClientRect();
  const slot = findLeftGutterSlot({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    readingColumn: readingColumnRect(),
    reserved: collectReservedRegions(false),
    size: { width: Math.max(size.width, 72), height: Math.max(size.height, 28) },
    minWidth: 64
  });

  if (slot) {
    launcher.style.left = `${slot.left}px`;
    launcher.style.top = `${slot.top}px`;
    return;
  }

  // No gutter. Try the corners, still refusing to overlap anything the provider
  // owns; if none is free, hide the on-page entry rather than dropping it on top
  // of native chrome. The extension action remains the guaranteed way in.
  const corner = findFreeCorner({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    size: { width: Math.max(size.width, 72), height: Math.max(size.height, 28) },
    reserved: collectReservedRegions(false)
  });

  if (!corner) {
    launcher.hidden = true;
    return;
  }

  launcher.style.left = `${corner.left}px`;
  launcher.style.top = `${corner.top}px`;
}

function readingColumnRect(): Rect | null {
  const rect = provider.layout.getReadingColumnRect(document);
  return rect && rect.width > 0 ? toRect(rect) : null;
}

/**
 * Put the minimized rail in free LEFT-side whitespace.
 *
 * The provider's left navigation is a reserved rectangle, so the rail starts to the
 * right of whatever chrome is present and shrinks to the space actually available.
 * When the gutter is too tight to be readable the rail is replaced by the compact
 * launcher rather than being forced back to the right edge over native controls.
 */
function positionTabBar(): void {
  if (!tabBar || tabBar.hidden) {
    return;
  }

  const minimizedCount = sortPanels().filter((runtime) => runtime.state.minimized).length;
  const reserved = collectReservedRegions(false);
  const slot = findLeftGutterSlot({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    readingColumn: readingColumnRect(),
    reserved,
    size: { width: RAIL_WIDTH_PX, height: window.innerHeight }
  });

  if (!slot) {
    tabBar.hidden = true;
    tabBar.dataset.placement = 'compact';
    setCompactLauncherVisible(minimizedCount > 0);
    return;
  }

  setCompactLauncherVisible(false);
  tabBar.dataset.placement = 'left-gutter';
  tabBar.style.left = `${slot.left}px`;
  tabBar.style.top = `${slot.top}px`;
  tabBar.style.height = `${slot.height}px`;
  tabBar.style.bottom = 'auto';
  tabBar.style.setProperty('--sb-tab-width', `${slot.width}px`);
}

function ensureTabBar(): HTMLDivElement {
  if (!tabBar) {
    document.getElementById(PANEL_TABBAR_ID)?.remove();
    tabBar = document.createElement('div');
    tabBar.id = PANEL_TABBAR_ID;
    tabBar.hidden = true;
  }

  return mountInExtensionHost(tabBar);
}

function sortPanels(): PanelRuntime[] {
  return [...panelRuntimes.values()].sort((left, right) => left.state.createdAt - right.state.createdAt);
}

function getVisiblePanels(): PanelRuntime[] {
  return sortPanels().filter((runtime) => !runtime.state.minimized);
}

function minimizeOtherPanels(exceptPanelId: string): void {
  sortPanels().forEach((runtime) => {
    if (runtime.state.panelId !== exceptPanelId && !runtime.state.minimized) {
      runtime.state.minimized = true;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
    }
  });
  persistPanels();
}

function getNonRootContainerUrl(url: string): string | undefined {
  return currentIdentity(url).containerUrl ?? undefined;
}

interface CreateDraftOptions {
  entryAction: BranchEntryAction;
  branchKind: BranchKind;
  initialQuestion?: string;
  autoStart?: boolean;
  hostChatUrl?: string;
}

/**
 * The single place a branch context is assembled, used by Ask, Why and New-tab on
 * both providers. Assistant answers the selection touched are included by default;
 * the preceding question is offered but off, because widening history is a choice
 * the user makes rather than one Aside makes for them.
 */
function createContextForSelection(selection: SelectionPayload): BranchContext {
  const blocks: ContextBlock[] = selection.selectedBlocks
    .filter((block) => block.role === 'assistant')
    .map((block) => ({
      id: block.messageId,
      role: block.role,
      text: block.structuredText || block.text,
      excerpt: block.excerpt,
      included: true,
      origin: 'touched' as const,
      limitation: block.structuredText ? undefined : 'structure could not be read; whitespace was normalized'
    }));

  if (selection.precedingQuestion) {
    const question = selection.precedingQuestion;
    blocks.push({
      id: question.messageId,
      role: question.role,
      text: question.structuredText || question.text,
      excerpt: question.excerpt,
      included: false,
      origin: 'preceding-question'
    });
  }

  const identity = currentIdentity(selection.rootChatUrl);
  return createContext({
    providerId: provider.id,
    selectedPassage: selection.structuredSelectedText || selection.selectedText,
    anchorText: selection.selectedText,
    sourceLabel: identity.conversationId
      ? `${provider.label} · conversation ${identity.conversationId}`
      : `${provider.label} · this page`,
    blocks
  });
}

function createDraftState(selection: SelectionPayload, options: CreateDraftOptions): BranchPanelState {
  const hostChatUrl = normalizeChatUrl(options.hostChatUrl ?? selection.rootChatUrl);
  return {
    panelId: randomId('panel'),
    rootConversationId: currentIdentity(hostChatUrl).scopeKey,
    rootChatUrl: hostChatUrl,
    rootProjectUrl: getNonRootContainerUrl(hostChatUrl),
    selection,
    context: createContextForSelection(selection),
    focusPreview: clipText(selection.selectedText, 280),
    branchKind: options.branchKind,
    entryAction: options.entryAction,
    surfaceMode: 'embedded',
    launchUrl: undefined,
    creationMode: 'pending',
    title: DEFAULT_BRANCH_TITLE,
    titleStatus: 'pending',
    minimized: false,
    status: 'draft',
    statusLabel: 'Ask a focused follow-up about this selected passage.',
    initialQuestion: options.initialQuestion,
    debugLog: [
      formatDebugLogEntry('Branch draft created', {
        rootChatUrl: selection.rootChatUrl,
        rootConversationId: selection.rootConversationId,
        selectedTextLength: selection.selectedText.length,
        branchKind: options.branchKind,
        entryAction: options.entryAction,
        selectedBlocks: selection.selectedBlocks.map((block) => ({
          role: block.role,
          turnIndex: block.turnIndex,
          messageId: block.messageId
        })),
        branchBaseMessageId: selection.branchBaseMessageId
      })
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function focusDraftQuestionInput(runtime: PanelRuntime): void {
  if (!runtime.questionInput.isConnected) {
    return;
  }
  if (runtime.state.status !== 'draft' && runtime.state.status !== 'failed') {
    return;
  }
  runtime.questionInput.click();
  runtime.questionInput.focus({ preventScroll: true });
  runtime.questionInput.setSelectionRange(
    runtime.questionInput.value.length,
    runtime.questionInput.value.length
  );
}

function scheduleDraftQuestionFocus(runtime: PanelRuntime): void {
  const deadline = Date.now() + 4_000;
  const focusUntilSettled = () => {
    if (!panelRuntimes.has(runtime.state.panelId)) {
      return;
    }

    if (runtime.state.status !== 'draft' && runtime.state.status !== 'failed') {
      return;
    }

    focusDraftQuestionInput(runtime);
    if (document.activeElement === runtime.questionInput || Date.now() >= deadline) {
      return;
    }

    window.requestAnimationFrame(focusUntilSettled);
  };

  window.requestAnimationFrame(focusUntilSettled);
  window.requestAnimationFrame(() => {
    focusDraftQuestionInput(runtime);
  });
  [0, 50, 150, 350, 750, 1500, 3000].forEach((delayMs) => {
    window.setTimeout(() => {
      focusDraftQuestionInput(runtime);
    }, delayMs);
  });
}

function focusPendingDraftQuestionInput(): void {
  if (!pendingDraftFocusPanelId) {
    return;
  }

  const runtime = panelRuntimes.get(pendingDraftFocusPanelId);
  if (!runtime || runtime.state.status !== 'draft') {
    pendingDraftFocusPanelId = null;
    return;
  }

  focusDraftQuestionInput(runtime);
  if (document.activeElement === runtime.questionInput) {
    pendingDraftFocusPanelId = null;
  }
}

function createBranchDraft(selection: SelectionPayload, options: CreateDraftOptions): PanelRuntime {
  const state = createDraftState(selection, options);
  minimizeOtherPanels(state.panelId);
  const runtime = createPanelRuntime(state);
  if (state.entryAction === 'new_tab' && state.status === 'draft') {
    pendingDraftFocusPanelId = state.panelId;
    focusDraftQuestionInput(runtime);
    scheduleDraftQuestionFocus(runtime);
  }
  renderTabs();
  persistPanels();

  if (options.initialQuestion) {
    runtime.questionInput.value = options.initialQuestion;
    runtime.state.initialQuestion = options.initialQuestion;
    syncPanelUI(runtime);
  }

  if (options.autoStart && options.initialQuestion?.trim()) {
    void startBranch(state.panelId, options.initialQuestion.trim());
  }

  return runtime;
}

function createPanelRuntime(state: BranchPanelState): PanelRuntime {
  const element = document.createElement('div');
  element.className = PANEL_CLASS;
  element.dataset.panelId = state.panelId;

  const header = document.createElement('div');
  header.className = 'aside-panel-header';

  const headingWrap = document.createElement('div');
  headingWrap.className = 'aside-panel-heading';
  const titleEl = document.createElement('h2');
  const statusEl = document.createElement('p');
  const errorEl = document.createElement('p');
  errorEl.className = 'aside-error-copy';
  headingWrap.append(titleEl, statusEl, errorEl);

  const actions = document.createElement('div');
  actions.className = 'aside-panel-actions';
  const jumpButton = document.createElement('button');
  jumpButton.type = 'button';
  jumpButton.textContent = 'Jump to origin';
  const openTabHeaderButton = document.createElement('button');
  openTabHeaderButton.type = 'button';
  openTabHeaderButton.textContent = 'Open branch';
  const copyLogButton = document.createElement('button');
  copyLogButton.type = 'button';
  copyLogButton.textContent = 'Copy log';
  copyLogButton.title =
    'Copy a redacted diagnostic report: URLs, status and automation steps, without your selected text or prompt.';
  const copyLogWithContentButton = document.createElement('button');
  copyLogWithContentButton.type = 'button';
  copyLogWithContentButton.textContent = 'Copy log + text';
  copyLogWithContentButton.title =
    'Copy the diagnostic report including your selected text and the generated prompt.';
  const minimizeButton = document.createElement('button');
  minimizeButton.type = 'button';
  minimizeButton.textContent = 'Minimize';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  actions.append(
    jumpButton,
    openTabHeaderButton,
    copyLogButton,
    copyLogWithContentButton,
    minimizeButton,
    closeButton
  );
  header.append(headingWrap, actions);

  const body = document.createElement('div');
  body.className = 'aside-panel-body';

  const focus = document.createElement('div');
  focus.className = 'aside-focus';
  const focusLabel = document.createElement('small');
  focusLabel.textContent = 'Selected local focus';
  const focusTextEl = document.createElement('p');
  focus.append(focusLabel, focusTextEl);

  const formEl = document.createElement('form');
  formEl.className = 'aside-launcher';
  const branchKindField = document.createElement('div');
  branchKindField.className = 'aside-kind-toggle';
  const persistentKindButton = document.createElement('button');
  persistentKindButton.type = 'button';
  persistentKindButton.textContent = 'Persistent';
  // Stable hook: the visible label is the provider's own word for the mode and
  // therefore differs per provider.
  persistentKindButton.dataset.asideRole = 'branch-kind-persistent';
  const temporaryKindButton = document.createElement('button');
  temporaryKindButton.type = 'button';
  // The provider's own name for the mode, not a word Aside invented: the user has
  // to recognise it in the provider's own interface to check it.
  temporaryKindButton.textContent = provider.privacy.label;
  temporaryKindButton.dataset.asideRole = 'branch-kind-temporary';
  temporaryKindButton.title = `Run this branch in ${provider.label}'s ${provider.privacy.label} mode`;

  // What the provider documents about its private mode, shown before a private
  // branch runs rather than described only in the README. Collapsed by default so
  // it does not shout, but present at the moment the choice is made.
  const privacyNoteEl = document.createElement('details');
  privacyNoteEl.className = 'aside-privacy-note';
  const privacyNoteSummary = document.createElement('summary');
  privacyNoteSummary.textContent = `What ${provider.privacy.label} does and does not do`;
  // Shown only when session storage is unavailable: a private branch still runs,
  // but Aside will not fall back to writing its content to disk, so the panel
  // cannot be kept. The user should hear that before choosing the mode, not after
  // the branch disappears.
  const privacyStorageWarning = document.createElement('p');
  privacyStorageWarning.className = 'aside-privacy-warning';
  privacyStorageWarning.textContent =
    'This browser did not make session storage available to Aside. A private branch will still run, but it cannot be kept when you leave the page: Aside will not write private branch content to disk instead.';
  privacyStorageWarning.hidden = true;
  const privacyNoteList = document.createElement('ul');
  provider.privacy.constraints.forEach((constraint) => {
    const item = document.createElement('li');
    item.textContent = constraint;
    privacyNoteList.append(item);
  });
  privacyNoteEl.append(privacyNoteSummary, privacyStorageWarning, privacyNoteList);
  const questionInput = document.createElement('textarea');
  // Stable hook: the panel has more than one textarea, and selectors that rely on
  // document order break the moment a section is added above this one.
  questionInput.dataset.asideRole = 'question';
  questionInput.placeholder = 'Ask a focused question about this passage';
  questionInput.autocomplete = 'off';
  questionInput.autocapitalize = 'sentences';
  questionInput.autofocus = state.entryAction === 'new_tab' && state.status === 'draft';
  const launcherActions = document.createElement('div');
  launcherActions.className = 'aside-launcher-actions';
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'aside-panel-primary';
  submitButton.textContent = 'Start branch';
  branchKindField.append(persistentKindButton, temporaryKindButton);
  launcherActions.append(submitButton);
  formEl.append(branchKindField, privacyNoteEl, questionInput, launcherActions);

  const iframeShell = document.createElement('div');
  iframeShell.className = 'aside-frame-shell';
  iframeShell.hidden = true;
  const iframeEl = document.createElement('iframe');
  iframeEl.className = 'aside-frame';
  iframeEl.title = `${provider.label} embedded branch`;
  iframeEl.setAttribute('loading', 'eager');
  iframeEl.referrerPolicy = 'strict-origin-when-cross-origin';
  iframeEl.src = 'about:blank';
  const iframeOverlay = document.createElement('div');
  iframeOverlay.className = 'aside-frame-overlay';
  const iframeOverlayCard = document.createElement('div');
  iframeOverlayCard.className = 'aside-frame-overlay-card';
  const iframeOverlayTitle = document.createElement('p');
  iframeOverlayTitle.className = 'aside-frame-overlay-title';
  const iframeOverlayText = document.createElement('p');
  iframeOverlayText.className = 'aside-frame-overlay-text';
  iframeOverlayCard.append(iframeOverlayTitle, iframeOverlayText);
  iframeOverlay.append(iframeOverlayCard);
  iframeShell.append(iframeEl, iframeOverlay);

  // Context: what will actually be submitted, inspectable and editable before it is.
  const contextShell = document.createElement('details');
  contextShell.className = 'aside-context';
  const contextSummary = document.createElement('summary');
  contextSummary.textContent = 'Context';
  const contextSource = document.createElement('p');
  contextSource.className = 'aside-context-source';
  const contextBlockList = document.createElement('div');
  contextBlockList.className = 'aside-context-blocks';
  const contextBackgroundLabel = document.createElement('label');
  contextBackgroundLabel.className = 'aside-context-background';
  contextBackgroundLabel.textContent = 'Background to add (optional)';
  const contextBackground = document.createElement('textarea');
  contextBackground.dataset.asideRole = 'context-background';
  contextBackground.rows = 2;
  contextBackground.placeholder = 'Anything the passage assumes but does not say';
  contextBackgroundLabel.append(contextBackground);
  const contextSizeEl = document.createElement('p');
  contextSizeEl.className = 'aside-context-size';
  const contextPreviewLabel = document.createElement('p');
  contextPreviewLabel.className = 'aside-context-preview-label';
  contextPreviewLabel.textContent = 'Exactly what will be sent:';
  const contextPreview = document.createElement('pre');
  contextPreview.className = 'aside-context-preview';
  contextShell.append(
    contextSummary,
    contextSource,
    contextBlockList,
    contextBackgroundLabel,
    contextSizeEl,
    contextPreviewLabel,
    contextPreview
  );

  const debugLogShell = document.createElement('div');
  debugLogShell.className = 'aside-debug-log';
  debugLogShell.hidden = true;
  const debugLogTitle = document.createElement('strong');
  debugLogTitle.textContent = 'Copyable debug log';
  const debugLogHelp = document.createElement('p');
  debugLogHelp.textContent =
    'Clipboard access was blocked, so select this log and paste it where you need it.';
  const debugLogTextarea = document.createElement('textarea');
  debugLogTextarea.dataset.asideRole = 'debug-log';
  debugLogTextarea.readOnly = true;
  debugLogTextarea.spellcheck = false;
  const debugLogActions = document.createElement('div');
  debugLogActions.className = 'aside-debug-log-actions';
  const selectDebugLogButton = document.createElement('button');
  selectDebugLogButton.type = 'button';
  selectDebugLogButton.className = 'aside-panel-secondary';
  selectDebugLogButton.textContent = 'Select log';
  const closeDebugLogButton = document.createElement('button');
  closeDebugLogButton.type = 'button';
  closeDebugLogButton.className = 'aside-panel-secondary';
  closeDebugLogButton.textContent = 'Hide log';
  debugLogActions.append(selectDebugLogButton, closeDebugLogButton);
  debugLogShell.append(debugLogTitle, debugLogHelp, debugLogTextarea, debugLogActions);

  body.append(focus, contextShell, formEl, iframeShell, debugLogShell);
  element.append(header, body);
  mountInExtensionHost(element);

  const runtime: PanelRuntime = {
    state,
    element,
    titleEl,
    statusEl,
    errorEl,
    focusTextEl,
    formEl,
    branchKindField,
    privacyNoteEl,
    privacyStorageWarning,
    persistentKindButton,
    temporaryKindButton,
    questionInput,
    submitButton,
    iframeShell,
    iframeEl,
    iframeOverlay,
    iframeOverlayTitle,
    iframeOverlayText,
    contextShell,
    contextBlockList,
    contextBackground,
    contextSizeEl,
    contextPreview,
    debugLogShell,
    debugLogTextarea,
    copyLogButton,
    openTabHeaderButton,
    frameReady: false,
    frameStartSent: false
  };

  questionInput.value = state.initialQuestion ?? '';
  contextSource.textContent = state.context?.sourceLabel ?? '';
  contextBackground.value = state.context?.userBackground ?? '';

  contextBackground.addEventListener('input', () => {
    if (!runtime.state.context) {
      return;
    }
    runtime.state.context = withUserBackground(runtime.state.context, contextBackground.value);
    runtime.state.updatedAt = Date.now();
    renderContextSection(runtime);
    persistPanelsSoon();
  });

  jumpButton.addEventListener('click', () => {
    scrollToOrigin(runtime.state.selection);
  });
  openTabHeaderButton.addEventListener('click', () => {
    void openBranchInNewTab(runtime.state.panelId);
  });
  copyLogButton.addEventListener('click', () => {
    void copyBranchDebugLog(runtime.state.panelId, false);
  });
  copyLogWithContentButton.addEventListener('click', () => {
    void copyBranchDebugLog(runtime.state.panelId, true);
  });
  selectDebugLogButton.addEventListener('click', () => {
    debugLogTextarea.focus();
    debugLogTextarea.select();
  });
  closeDebugLogButton.addEventListener('click', () => {
    debugLogShell.hidden = true;
  });
  minimizeButton.addEventListener('click', () => {
    minimizePanel(runtime.state.panelId);
  });
  closeButton.addEventListener('click', () => {
    closePanel(runtime.state.panelId);
  });
  iframeEl.addEventListener('load', () => {
    appendPanelLog(runtime, 'Embedded branch frame load event', {
      iframeSrc: iframeEl.src,
      panelStatus: runtime.state.status
    });
    syncPanelUI(runtime);
  });
  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = questionInput.value.trim();
    if (!question) {
      return;
    }
    await startBranch(runtime.state.panelId, question);
  });
  persistentKindButton.addEventListener('click', () => {
    runtime.state.branchKind = 'persistent';
    runtime.state.updatedAt = Date.now();
    persistLastUsedBranchKind('persistent');
    syncPanelUI(runtime);
    persistPanels();
  });
  temporaryKindButton.addEventListener('click', () => {
    runtime.state.branchKind = 'temporary';
    runtime.state.updatedAt = Date.now();
    persistLastUsedBranchKind('temporary');
    syncPanelUI(runtime);
    persistPanels();
  });
  questionInput.addEventListener('input', () => {
    runtime.state.initialQuestion = questionInput.value;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanelsSoon(runtime.state.panelId);
  });
  // Leaving the box is a deliberate save point, which is also how a panel that went
  // unsaved because another tab wrote first gets reconciled.
  questionInput.addEventListener('blur', () => {
    runtime.state.initialQuestion = questionInput.value;
    runtime.state.updatedAt = Date.now();
    persistPanels(runtime.state.panelId);
  });
  // Enter sends, Shift+Enter adds a line, matching the composer the user just came from.
  // isComposing keeps IME candidate selection from submitting a half-typed question.
  questionInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }

    event.preventDefault();
    if (submitButton.disabled) {
      return;
    }

    if (typeof formEl.requestSubmit === 'function') {
      formEl.requestSubmit();
      return;
    }

    formEl.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  });

  panelRuntimes.set(state.panelId, runtime);
  syncPanelUI(runtime);

  return runtime;
}

function getDisplayTitle(state: BranchPanelState): string {
  if (state.titleStatus === 'ready' && state.title.trim()) {
    return state.title.trim();
  }

  if (state.status === 'draft') {
    return 'New branch';
  }

  // The title comes from an instruction the model can simply ignore, so fall back to
  // something the user recognises instead of a placeholder that never resolves.
  if (state.status === 'live' || state.status === 'failed') {
    const fallback = compactWhitespace(state.initialQuestion || state.focusPreview);
    if (fallback) {
      return clipText(fallback, 48);
    }
  }

  return 'Naming branch...';
}

// A failed branch is the one state where the user most needs the form back, including a
// branch that was promoted to a native window or that failed after a URL appeared.
// Without this, "Close" was the only way out of a failure.
function canShowForm(state: BranchPanelState): boolean {
  return state.status === 'draft' || state.status === 'failed';
}

function canShowBranchKindToggle(state: BranchPanelState): boolean {
  return canShowForm(state) && (state.entryAction === 'ask' || state.entryAction === 'new_tab');
}

function canShowFrame(state: BranchPanelState): boolean {
  if (state.surfaceMode === 'native_window') {
    return false;
  }
  return state.status !== 'draft' || Boolean(state.branchChatUrl) || Boolean(state.launchUrl);
}

/**
 * Render the Context section from the panel's own context value. The preview shows
 * the exact string the prompt will carry, produced by the same function that builds
 * it, so the two cannot drift.
 */
function renderContextSection(runtime: PanelRuntime): void {
  const context = runtime.state.context;
  if (!context) {
    runtime.contextShell.hidden = true;
    return;
  }

  runtime.contextShell.hidden = false;
  runtime.contextBlockList.replaceChildren();

  context.blocks.forEach((block) => {
    const row = document.createElement('label');
    row.className = 'aside-context-block';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = block.included;
    toggle.addEventListener('change', () => {
      if (!runtime.state.context) {
        return;
      }
      runtime.state.context = withBlockIncluded(runtime.state.context, block.id, toggle.checked);
      runtime.state.updatedAt = Date.now();
      renderContextSection(runtime);
      syncPanelUI(runtime);
      persistPanels();
    });

    const label = document.createElement('span');
    const origin =
      block.origin === 'preceding-question'
        ? 'preceding question'
        : block.origin === 'user-added'
          ? 'added by you'
          : `${block.role} answer you selected in`;
    label.textContent = `${origin}: ${clipText(block.excerpt, 90)}`;

    row.append(toggle, label);

    if (block.limitation) {
      const limitation = document.createElement('small');
      limitation.className = 'aside-context-limitation';
      limitation.textContent = block.limitation;
      row.append(limitation);
    }

    runtime.contextBlockList.append(row);
  });

  const limits = measureContext(context);
  runtime.contextSizeEl.textContent = describeContextSize(limits);
  runtime.contextSizeEl.dataset.overBudget = String(limits.overBudget);
  runtime.contextPreview.textContent = renderContextText(context);
}

function syncPanelUI(runtime: PanelRuntime): void {
  const { state } = runtime;
  const showForm = canShowForm(state);
  const showFrame = canShowFrame(state);
  const showOpenBranch = Boolean(
    state.branchChatUrl || state.launchTabId || state.launchWindowId
  );
  const overlayVisible = state.status !== 'live';

  runtime.element.hidden = state.minimized;
  runtime.titleEl.textContent = getDisplayTitle(state);
  const unsaved = unsavedPanelIds.has(state.panelId);
  runtime.statusEl.textContent = unsaved
    ? `${state.statusLabel} (not saved — this branch is only in this tab)`
    : state.statusLabel;
  runtime.element.dataset.unsaved = String(unsaved);
  runtime.errorEl.textContent = state.status === 'failed' ? state.errorMessage ?? '' : '';
  runtime.errorEl.style.display = runtime.errorEl.textContent ? 'block' : 'none';
  runtime.focusTextEl.textContent = state.focusPreview;
  renderContextSection(runtime);

  // Over budget is a decision for the user, not a silent truncation, so the send
  // is blocked until they remove something.
  const contextLimits = state.context ? measureContext(state.context) : null;
  const contextOverBudget = Boolean(contextLimits?.overBudget);

  runtime.formEl.style.display = showForm ? 'flex' : 'none';
  runtime.branchKindField.style.display = canShowBranchKindToggle(state) ? 'inline-flex' : 'none';
  const privacyNoteVisible = showForm && state.branchKind === 'temporary';
  runtime.privacyNoteEl.hidden = !privacyNoteVisible;
  runtime.privacyStorageWarning.hidden = sessionStorageUsable;
  if (privacyNoteVisible && !sessionStorageUsable) {
    // A limitation the user needs before choosing, not one they have to open.
    runtime.privacyNoteEl.open = true;
  }
  runtime.persistentKindButton.dataset.selected = String(state.branchKind === 'persistent');
  runtime.temporaryKindButton.dataset.selected = String(state.branchKind === 'temporary');
  runtime.questionInput.disabled = !showForm;
  runtime.persistentKindButton.disabled = !showForm;
  runtime.temporaryKindButton.disabled = !showForm;
  runtime.submitButton.disabled =
    !runtime.questionInput.value.trim() ||
    contextOverBudget ||
    state.status === 'creating_branch' ||
    state.status === 'opening_branch';
  runtime.submitButton.title = contextOverBudget
    ? `The context is ${describeContextSize(contextLimits!)}. Open Context and remove some material.`
    : '';
  runtime.submitButton.textContent = state.status === 'failed' ? 'Try again' : 'Start branch';
  runtime.iframeShell.hidden = !showFrame;
  runtime.iframeOverlay.hidden = !overlayVisible;
  runtime.iframeOverlayTitle.textContent =
    state.surfaceMode === 'native_window'
      ? state.status === 'failed'
        ? `${provider.label} branch could not finish loading`
        : state.status === 'live'
          ? ''
          : `This branch runs in a ${provider.label} window`
      : state.status === 'failed'
      ? 'Branch could not finish loading'
      : state.status === 'live'
        ? ''
        : 'Opening branch in this window';
  runtime.iframeOverlayText.textContent =
    state.status === 'failed'
      ? state.errorMessage ?? state.statusLabel
      : state.statusLabel;
  runtime.openTabHeaderButton.style.display = showOpenBranch ? 'inline-flex' : 'none';
  if (state.status === 'live') {
    ensureLiveFrameLocation(runtime);
  }
}

function renderTabs(): void {
  const container = ensureTabBar();
  container.innerHTML = '';

  const minimized = sortPanels().filter((runtime) => runtime.state.minimized);
  container.hidden = minimized.length === 0;

  minimized.forEach((runtime) => {
    const tab = document.createElement('div');
    tab.className = 'aside-tab';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = clipText(getDisplayTitle(runtime.state), 28);

    const badge = document.createElement('small');
    if (runtime.state.status === 'draft') {
      badge.textContent = 'draft';
    } else if (runtime.state.status === 'failed') {
      badge.textContent = 'failed';
    } else if (runtime.state.status === 'live') {
      badge.textContent = 'live';
    } else {
      badge.textContent = 'opening';
    }

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'aside-tab-close';
    closeButton.textContent = '×';

    openButton.addEventListener('click', () => {
      expandPanel(runtime.state.panelId);
    });
    closeButton.addEventListener('click', () => {
      closePanel(runtime.state.panelId);
    });

    tab.append(openButton, badge, closeButton);
    container.append(tab);
  });

  positionTabBar();
}

function syncMountedUi(): void {
  ensureExtensionHost();

  if (selectionToolbar) {
    mountInExtensionHost(selectionToolbar);
    if (!selectionToolbar.hidden && currentSelectionRect) {
      positionSelectionToolbar(currentSelectionRect);
    }
  }

  sortPanels().forEach((runtime) => {
    mountInExtensionHost(runtime.element);
    syncPanelUI(runtime);
  });

  renderTabs();

  if (highlightOverlay?.childElementCount) {
    mountInExtensionHost(highlightOverlay);
  }

  focusPendingDraftQuestionInput();
}

function scheduleMountedUiSync(delayMs: number): void {
  const timer = window.setTimeout(() => {
    syncMountedUi();
  }, delayMs);
  cleanupFns.push(() => window.clearTimeout(timer));
}

function createStateFromRestore(raw: BranchPanelState): BranchPanelState | null {
  if (!raw?.panelId || !raw.selection?.selectedText) {
    return null;
  }

  const normalizedRootChatUrl = normalizeChatUrl(raw.rootChatUrl ?? raw.selection.rootChatUrl);
  const normalizedLaunchUrl = raw.launchUrl ? normalizeChatUrl(raw.launchUrl) : undefined;
  const normalizedBranchChatUrl = raw.branchChatUrl ? normalizeChatUrl(raw.branchChatUrl) : undefined;
  const branchKind: BranchKind = raw.branchKind === 'temporary' ? 'temporary' : 'persistent';
  const surfaceMode = raw.surfaceMode === 'native_window' ? 'native_window' : 'embedded';
  const entryAction: BranchEntryAction =
    raw.entryAction === 'why' || raw.entryAction === 'new_tab' ? raw.entryAction : 'ask';
  const rawStatus = String(raw.status ?? '');
  const allowedStatuses = new Set<string>([
    'draft',
    'creating_branch',
    'opening_branch',
    'live',
    'failed'
  ]);
  let status: BranchPanelStatus = allowedStatuses.has(rawStatus)
    ? (rawStatus as BranchPanelStatus)
    : rawStatus
      ? 'failed'
      : normalizedBranchChatUrl
        ? 'live'
        : 'draft';
  const rawCreationMode = String(raw.creationMode ?? '');
  let creationMode: BranchCreationMode =
    rawCreationMode === 'failed'
      ? 'failed'
      : rawCreationMode === 'local_temporary'
        ? 'local_temporary'
      : rawCreationMode === 'pending'
        ? 'pending'
        : normalizedBranchChatUrl
          ? 'local_persistent'
          : 'pending';
  let errorMessage = raw.errorMessage;

  if (
    (status === 'creating_branch' || status === 'opening_branch') &&
    !normalizedBranchChatUrl
  ) {
    status = 'failed';
    creationMode = 'failed';
    errorMessage = 'Branch creation was interrupted. Start it again.';
  }

  if (branchKind === 'temporary' && status === 'live' && !normalizedBranchChatUrl) {
    status = 'failed';
    creationMode = 'failed';
    errorMessage = 'Temporary branch ended after reload. Start it again.';
  }

  return {
    panelId: raw.panelId,
    rootConversationId: raw.rootConversationId ?? raw.selection.rootConversationId,
    rootChatUrl: normalizedRootChatUrl,
    rootProjectUrl: raw.rootProjectUrl ?? getNonRootContainerUrl(normalizedRootChatUrl),
    selection: raw.selection,
    // The context is a persisted field: without it the Context section is hidden
    // after a reload and the prompt is silently rebuilt from defaults, putting
    // back every block the user unticked.
    context: sanitizeStoredContext(raw.context),
    focusPreview: raw.focusPreview || clipText(raw.selection.selectedText, 280),
    branchKind,
    entryAction,
    surfaceMode,
    launchUrl: normalizedLaunchUrl,
    branchChatUrl: normalizedBranchChatUrl,
    launchTabId: typeof raw.launchTabId === 'number' ? raw.launchTabId : undefined,
    launchWindowId: typeof raw.launchWindowId === 'number' ? raw.launchWindowId : undefined,
    creationMode,
    title: raw.title || DEFAULT_BRANCH_TITLE,
    titleStatus: raw.titleStatus ?? 'pending',
    minimized: Boolean(raw.minimized),
    initialQuestion: raw.initialQuestion,
    initialPrompt: raw.initialPrompt,
    status,
    statusLabel:
      raw.statusLabel ||
      (status === 'live'
        ? 'Branch answer is ready in this window.'
        : status === 'failed'
          ? errorMessage ?? 'Branch creation failed.'
          : 'Ask a focused follow-up about this selected passage.'),
    errorMessage,
    debugLog: Array.isArray(raw.debugLog) ? raw.debugLog.slice(-250) : undefined,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now()
  };
}

async function restorePanels(): Promise<void> {
  const urlAtStart = lastKnownUrl;
  const currentScopeKey = currentIdentity(urlAtStart).scopeKey;
  const records = await listPanelRecords();
  if (urlAtStart !== lastKnownUrl) {
    return;
  }

  records
    // Another tab can write a panel back after this page closed it; do not bring it
    // back into a page the user already dismissed it from.
    .filter((record) => !closedPanelIds.has(record.panelId))
    // A panel belongs to this page if it shares the scope; otherwise only a
    // minimized one is offered, and only as a rail tab.
    .filter((record) => record.scopeKey === currentScopeKey || Boolean(record.state?.minimized))
    .forEach((record) => {
      const restoredState = createStateFromRestore(record.state);
      if (!restoredState) {
        return;
      }

      // Panels from another scope, and anything in the shared catch-all scope,
      // come back as rail tabs rather than reopening over the current page.
      if (
        record.scopeKey !== currentScopeKey ||
        isCatchAllPanelStorageKey(getPanelStorageKeyForConversationId(record.scopeKey))
      ) {
        restoredState.minimized = true;
      }

      panelRevisions.set(record.panelId, record.rev);
      if (!panelRuntimes.has(record.panelId)) {
        createPanelRuntime(restoredState);
      }
    });

  syncMountedUi();
  drainPendingPanelChanges();
}

function minimizePanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  runtime.state.minimized = true;
  runtime.state.updatedAt = Date.now();
  syncPanelUI(runtime);
  renderTabs();
  persistPanels(panelId);
}

function expandPanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  minimizeOtherPanels(panelId);
  runtime.state.minimized = false;
  runtime.state.updatedAt = Date.now();
  syncPanelUI(runtime);
  renderTabs();
  persistPanels(panelId);
  scrollToOrigin(runtime.state.selection);
}

function closePanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  clearPanelWatchdog(runtime);
  closedPanelIds.add(panelId);
  runtime.iframeEl.src = 'about:blank';
  runtime.element.remove();
  panelRuntimes.delete(panelId);
  renderTabs();

  // A close is a deletion with a tombstone, not the absence of a write: another
  // tab that still has this panel mounted must not write it back. If the tombstone
  // cannot be written, the branch is not closed — say so instead of letting it
  // reappear later with no explanation.
  void deletePanelRecord(panelId).then((deleted) => {
    if (deleted) {
      return;
    }

    closedPanelIds.delete(panelId);
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'This branch could not be closed.';
    runtime.state.errorMessage =
      'Aside could not record the deletion, so this branch would come back on the next reload. Try Close again.';
    runtime.state.updatedAt = Date.now();
    panelRuntimes.set(panelId, runtime);
    mountInExtensionHost(runtime.element);
    syncPanelUI(runtime);
    renderTabs();
  });
}

// Navigating away is not the same as closing: these panels stay in storage so the user
// can come back to the conversation and find them again.
function clearPanelsForCurrentConversation(): void {
  panelRuntimes.forEach((runtime) => {
    clearPanelWatchdog(runtime);
    runtime.iframeEl.src = 'about:blank';
    runtime.element.remove();
  });
  panelRuntimes.clear();
  renderTabs();
}

async function openBranchInNewTab(panelId: string): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  appendPanelLog(runtime, 'Open branch requested', {
    branchChatUrl: runtime.state.branchChatUrl,
    launchTabId: runtime.state.launchTabId,
    launchWindowId: runtime.state.launchWindowId,
    surfaceMode: runtime.state.surfaceMode
  });

  if (runtime.state.launchTabId || runtime.state.launchWindowId || runtime.state.branchChatUrl) {
    const response = await focusNativeBranchWindow({
      panelId,
      launchTabId: runtime.state.launchTabId,
      launchWindowId: runtime.state.launchWindowId,
      branchChatUrl: runtime.state.branchChatUrl
    });

    if (response.ok) {
      return;
    }
  }

  if (runtime.state.branchChatUrl) {
    window.open(runtime.state.branchChatUrl, '_blank', 'noopener,noreferrer');
  }
}

async function promotePersistentBranchToNativeWindow(runtime: PanelRuntime): Promise<void> {
  if (
    runtime.state.surfaceMode === 'native_window' ||
    runtime.state.branchKind !== 'persistent' ||
    !runtime.state.initialPrompt ||
    !runtime.state.launchUrl
  ) {
    return;
  }

  runtime.pendingFramePrompt = undefined;
  runtime.state.surfaceMode = 'native_window';
  runtime.state.status = 'opening_branch';
  runtime.state.statusLabel = `Continuing this branch in a native ${provider.label} window...`;
  runtime.state.errorMessage = undefined;
  runtime.state.updatedAt = Date.now();
  appendPanelLog(runtime, 'Promoting persistent branch to a native provider window', {
    launchUrl: runtime.state.launchUrl
  });
  syncPanelUI(runtime);
  persistPanels();

  // Promotion continues the same attempt, so it keeps the same attempt id: the
  // embedded frame that just failed is already identified by it and cannot come back.
  const attempt = currentAttemptRef(runtime);
  if (!attempt) {
    appendPanelLog(runtime, 'Refusing to promote a branch without an attempt id');
    return;
  }

  const response = await createNativeBranchWindow({
    attempt,
    prompt: runtime.state.initialPrompt,
    launchUrl: runtime.state.launchUrl,
    branchKind: runtime.state.branchKind,
    focusWindow: true,
    arrangeSideBySide: true
  });

  if (!response.ok) {
    appendPanelLog(runtime, 'Native branch window promotion failed', {
      reason: response.reason
    });
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'Native branch recovery failed.';
    runtime.state.errorMessage =
      response.reason ?? `The native ${provider.label} recovery window could not be opened.`;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels();
    return;
  }

  runtime.state.launchTabId = response.tabId;
  runtime.state.launchWindowId = response.windowId;
  runtime.state.updatedAt = Date.now();
  startPanelWatchdog(
    runtime,
    BRANCH_RESPONSE_TIMEOUT_MS,
    `The native ${provider.label} branch window stopped reporting back. Use Open branch to check it directly, or try again.`
  );
  appendPanelLog(runtime, 'Native branch recovery window created', {
    launchTabId: response.tabId,
    launchWindowId: response.windowId
  });
  syncPanelUI(runtime);
  persistPanels();
}

async function openSelectionInNewTab(
  selection: SelectionPayload,
  branchKind: BranchKind
): Promise<void> {
  const launchUrl = provider.normalizeUrl(currentIdentity(selection.rootChatUrl).launchUrl);

  // New-tab assembles its prompt exactly as Ask and Why do, from the structured
  // context rather than the normalized anchor text.
  const frozen = freezeContext(createContextForSelection(selection));
  if (frozen.limits.overBudget) {
    // Nothing is shown before a New-tab branch opens, so there is no preview in
    // which to trim. Fall back to an in-page draft, where the Context section is.
    const runtime = createBranchDraft(selection, { entryAction: 'ask', branchKind });
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'This branch was not sent.';
    runtime.state.errorMessage = `The context is ${describeContextSize(
      frozen.limits
    )}. Open Context, remove some material, then start the branch here.`;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    renderTabs();
    persistPanels();
    return;
  }

  const prompt = buildNativeBootstrapPromptFromContext(frozen.text).prompt;
  const panelId = randomId('native');
  const newTabAttempt = {
    providerId: provider.id,
    panelId,
    attemptId: createAttemptId()
  };
  startedAttemptIds.add(newTabAttempt.attemptId);
  persistLastUsedBranchKind(branchKind);
  const response = await createNativeBranchWindow({
    attempt: newTabAttempt,
    prompt,
    launchUrl,
    branchKind,
    focusWindow: true,
    arrangeSideBySide: true
  });

  if (!response.ok) {
    console.warn('[Aside] Failed to open native New-tab window', response.reason);
    // The selection has already been cleared by this point, so falling back to an
    // in-page draft is the only way the user keeps the passage they picked.
    const runtime = createBranchDraft(selection, {
      entryAction: 'ask',
      branchKind
    });
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = `New-tab could not open a ${provider.label} window.`;
    runtime.state.errorMessage = `${
      response.reason ?? 'The branch window could not be opened.'
    } Ask here instead, or try New-tab again.`;
    runtime.state.updatedAt = Date.now();
    appendPanelLog(runtime, 'New-tab branch window could not be opened', {
      reason: response.reason
    });
    syncPanelUI(runtime);
    renderTabs();
    persistPanels();
  }
}

const REDACTED = '(redacted — use "Copy log + text" to include it)';

/**
 * Diagnostics are redacted by default. The selected passage and the generated prompt
 * are the user's content — and for a private branch they are exactly the content that
 * must not leave the session — so including them takes a second, explicit action.
 */
function buildBranchDebugLogText(runtime: PanelRuntime, includeContent = false): string {
  const { state } = runtime;
  const redactable = (value: string | undefined | null): string =>
    includeContent ? (value ?? '(none)') : REDACTED;

  return [
    'Aside Debug Log',
    includeContent
      ? 'CONTAINS YOUR CONTENT: the selected text and the first prompt are included below.'
      : 'Content is redacted. Use "Copy log + text" if a maintainer needs the selected text and prompt.',
    `provider: ${provider.id}`,
    `branchPrivacy: ${state.branchKind === 'temporary' ? provider.privacy.label : 'persistent'}`,
    `generatedAt: ${new Date().toISOString()}`,
    `panelId: ${state.panelId}`,
    `rootChatUrl: ${state.rootChatUrl}`,
    `rootProjectUrl: ${state.rootProjectUrl ?? '(none)'}`,
    `branchKind: ${state.branchKind}`,
    `entryAction: ${state.entryAction}`,
    `surfaceMode: ${state.surfaceMode}`,
    `launchUrl: ${state.launchUrl ?? '(none)'}`,
    `branchChatUrl: ${state.branchChatUrl ?? '(none)'}`,
    `launchTabId: ${state.launchTabId ?? '(none)'}`,
    `launchWindowId: ${state.launchWindowId ?? '(none)'}`,
    `status: ${state.status}`,
    `statusLabel: ${state.statusLabel}`,
    `creationMode: ${state.creationMode}`,
    `title: ${state.title}`,
    `titleStatus: ${state.titleStatus}`,
    `createdAt: ${new Date(state.createdAt).toISOString()}`,
    `updatedAt: ${new Date(state.updatedAt).toISOString()}`,
    `focusPreview: ${redactable(state.focusPreview)}`,
    `selectedTextLength: ${state.selection.selectedText.length}`,
    `initialQuestion: ${redactable(state.initialQuestion)}`,
    `branchBaseMessageId: ${state.selection.branchBaseMessageId}`,
    `rangeQuotes: ${includeContent ? JSON.stringify(state.selection.rangeQuotes, null, 2) : REDACTED}`,
    `selectedBlocks: ${JSON.stringify(
      state.selection.selectedBlocks.map((block) => ({
        role: block.role,
        turnIndex: block.turnIndex,
        messageId: block.messageId,
        excerpt: includeContent ? block.excerpt : REDACTED
      })),
      null,
      2
    )}`,
    '',
    'SELECTED TEXT',
    redactable(state.selection.selectedText),
    '',
    `FIRST PROMPT SENT TO ${provider.label.toUpperCase()}`,
    redactable(state.initialPrompt),
    '',
    'AUTOMATION LOG',
    '',
    ...(state.debugLog ?? ['(no debug log entries)'])
  ].join('\n');
}

function showCopyableDebugLog(runtime: PanelRuntime, logText: string): void {
  runtime.debugLogTextarea.value = logText;
  runtime.debugLogShell.hidden = false;
  runtime.debugLogTextarea.focus();
  runtime.debugLogTextarea.select();
}

async function copyBranchDebugLog(panelId: string, includeContent = false): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  const logText = buildBranchDebugLogText(runtime, includeContent);
  try {
    await navigator.clipboard.writeText(logText);
    appendPanelLog(runtime, 'Debug log copied to clipboard');
    runtime.debugLogShell.hidden = true;
    const previousStatus = runtime.state.statusLabel;
    const copiedStatus =
      'Debug log copied. Paste it here so we can inspect selection, branch URL, and prompt submission.';
    runtime.state.statusLabel = copiedStatus;
    syncPanelUI(runtime);
    persistPanels();
    window.setTimeout(() => {
      // Only roll back if nothing newer has claimed the status line in the meantime.
      if (panelRuntimes.get(panelId) === runtime && runtime.state.statusLabel === copiedStatus) {
        runtime.state.statusLabel = previousStatus;
        syncPanelUI(runtime);
      }
    }, 2500);
  } catch (error) {
    const copyError = error instanceof Error ? error.message : String(error);
    appendPanelLog(runtime, 'Debug log copy failed', copyError);
    runtime.state.statusLabel = 'Clipboard copy was blocked. Select the diagnostic log below and paste it here.';
    showCopyableDebugLog(runtime, buildBranchDebugLogText(runtime, includeContent));
    syncPanelUI(runtime);
    persistPanels();
  }
}

function buildEmbeddedFrameUrl(launchUrl: string): string {
  try {
    const url = new URL(launchUrl);
    url.hash = `aside-${Date.now()}`;
    return url.toString();
  } catch {
    return launchUrl;
  }
}

function clearPanelWatchdog(runtime: PanelRuntime): void {
  if (runtime.watchdogId !== undefined) {
    window.clearTimeout(runtime.watchdogId);
    runtime.watchdogId = undefined;
  }
}

function startPanelWatchdog(runtime: PanelRuntime, timeoutMs: number, reason: string): void {
  clearPanelWatchdog(runtime);
  runtime.watchdogId = window.setTimeout(() => {
    runtime.watchdogId = undefined;

    if (panelRuntimes.get(runtime.state.panelId) !== runtime) {
      return;
    }

    if (
      runtime.state.status === 'live' ||
      runtime.state.status === 'failed' ||
      runtime.state.status === 'draft'
    ) {
      return;
    }

    appendPanelLog(runtime, 'Branch watchdog fired', {
      timeoutMs,
      panelStatus: runtime.state.status,
      frameReady: runtime.frameReady,
      frameStartSent: runtime.frameStartSent
    });
    applyBranchPanelEvent(runtime, { kind: 'failed', reason });
  }, timeoutMs);
}

function loadEmbeddedBranchFrame(runtime: PanelRuntime, launchUrl: string): void {
  runtime.frameReady = false;
  runtime.frameStartSent = false;
  startPanelWatchdog(
    runtime,
    FRAME_HANDSHAKE_TIMEOUT_MS,
    `The embedded ${provider.label} branch window did not finish loading. ${provider.label} may be refusing to be embedded here — try again, or use New-tab to run this branch in its own window.`
  );
  const iframeUrl = buildEmbeddedFrameUrl(launchUrl);
  const previousSrc = runtime.iframeEl.src;

  // Retrying reuses the same iframe, and the cache-busting differs only in the fragment.
  // A fragment-only src change is a same-document navigation: no load event, so the frame
  // never posts SB_FRAME_READY again and the retry would sit there until the watchdog.
  // Going through about:blank forces a real document load.
  if (previousSrc && previousSrc !== 'about:blank') {
    runtime.iframeEl.src = 'about:blank';
  }

  window.setTimeout(() => {
    if (panelRuntimes.get(runtime.state.panelId) !== runtime) {
      return;
    }
    runtime.iframeEl.src = iframeUrl;
  }, 0);

  appendPanelLog(runtime, 'Loading embedded branch frame', {
    targetUrl: launchUrl,
    iframeSrc: iframeUrl,
    previousSrc: previousSrc || null,
    panelStatus: runtime.state.status
  });
}

function ensureLiveFrameLocation(runtime: PanelRuntime): void {
  const desiredUrl = runtime.state.branchChatUrl;
  if (!desiredUrl || runtime.pendingFramePrompt) {
    return;
  }

  // Restoring a page used to give every minimized branch from every conversation its own
  // eagerly loading chatgpt.com iframe. Load the frame when the panel is actually shown.
  if (runtime.state.minimized) {
    return;
  }

  if (runtime.frameStartSent || runtime.frameReady) {
    return;
  }

  const currentSrc = runtime.iframeEl.src;
  if (!currentSrc || currentSrc === 'about:blank') {
    runtime.iframeEl.src = desiredUrl;
    return;
  }

  if (normalizeChatUrl(currentSrc) !== normalizeChatUrl(desiredUrl)) {
    runtime.iframeEl.src = desiredUrl;
  }
}

function postToEmbeddedFrame(runtime: PanelRuntime, message: FrameStartBranchMessage): void {
  const targetWindow = runtime.iframeEl.contentWindow;
  if (!targetWindow) {
    return;
  }

  let targetOrigin = '*';
  try {
    targetOrigin = new URL(runtime.state.launchUrl ?? runtime.state.rootChatUrl).origin;
  } catch {
    targetOrigin = '*';
  }

  targetWindow.postMessage(message, targetOrigin);
}

function tryDispatchPendingFrameStart(runtime: PanelRuntime): void {
  if (!runtime.pendingFramePrompt || runtime.frameStartSent || !runtime.frameReady || !runtime.state.launchUrl) {
    return;
  }

  const prompt = runtime.pendingFramePrompt;
  runtime.frameStartSent = true;
  runtime.state.status = 'opening_branch';
  runtime.state.statusLabel = 'Sending the local branch question inside the branch window...';
  runtime.state.updatedAt = Date.now();
  appendPanelLog(runtime, 'Dispatching embedded branch start command', {
    launchUrl: runtime.state.launchUrl,
    promptLength: prompt.length
  });
  startPanelWatchdog(
    runtime,
    BRANCH_RESPONSE_TIMEOUT_MS,
    `The branch window stopped responding before the answer was ready. Try again, or use Open branch to continue it directly in ${provider.label}.`
  );
  syncPanelUI(runtime);
  persistPanels();

  const attempt = currentAttemptRef(runtime);
  if (!attempt) {
    appendPanelLog(runtime, 'Refusing to dispatch a branch start without an attempt id');
    return;
  }

  postToEmbeddedFrame(runtime, {
    source: 'aside',
    target: 'frame',
    type: 'SB_FRAME_START_BRANCH',
    ...attempt,
    prompt,
    launchUrl: runtime.state.launchUrl,
    branchKind: runtime.state.branchKind
  });
}

function findRuntimeByFrameWindow(source: MessageEventSource | null): PanelRuntime | null {
  if (!source) {
    return null;
  }

  for (const runtime of panelRuntimes.values()) {
    if (runtime.iframeEl.contentWindow === source) {
      return runtime;
    }
  }

  return null;
}

function isTrustedBranchOrigin(origin: string, runtime?: PanelRuntime): boolean {
  if (!origin || origin === 'null') {
    return false;
  }

  if (origin === window.location.origin) {
    return true;
  }

  const launchUrl = runtime?.state.launchUrl ?? runtime?.state.branchChatUrl;
  if (!launchUrl) {
    return false;
  }

  try {
    return new URL(launchUrl).origin === origin;
  } catch {
    return false;
  }
}

function handleEmbeddedFrameMessage(event: MessageEvent<FrameIncomingMessage>): void {
  const data = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    data.source !== 'aside' ||
    data.target !== 'parent'
  ) {
    return;
  }

  const runtime = findRuntimeByFrameWindow(event.source);
  if (!runtime) {
    return;
  }

  // The window identity check above already rules out unrelated frames; the origin check
  // keeps a navigated-away branch frame from driving the panel.
  if (!isTrustedBranchOrigin(event.origin, runtime)) {
    appendPanelLog(runtime, 'Ignored branch frame message from an unexpected origin', {
      origin: event.origin
    });
    return;
  }

  if (data.type === 'SB_FRAME_READY') {
    runtime.frameReady = true;
    appendPanelLog(runtime, 'Embedded branch frame ready', {
      currentUrl: data.currentUrl,
      panelStatus: runtime.state.status,
      hasPendingPrompt: Boolean(runtime.pendingFramePrompt),
      iframeSrc: runtime.iframeEl.src
    });
    tryDispatchPendingFrameStart(runtime);
    return;
  }

  if (data.type === 'SB_FRAME_EVENT') {
    if (!isBranchAttemptRef(data) || !isBranchPanelEvent(data.event)) {
      return;
    }

    if (!ownsAttempt(data, currentAttemptRef(runtime))) {
      appendPanelLog(runtime, 'Ignored a branch frame event from a superseded attempt', {
        eventKind: data.event.kind,
        messageAttemptId: data.attemptId,
        currentAttemptId: runtime.state.attemptId ?? null
      });
      return;
    }

    // A panel that has moved on to a native window is no longer driven by its old frame;
    // a late event from that frame would otherwise overwrite the current branch state.
    if (runtime.state.surfaceMode !== 'embedded') {
      appendPanelLog(runtime, 'Ignored a branch frame event for a panel that is no longer embedded', {
        eventKind: data.event.kind,
        surfaceMode: runtime.state.surfaceMode
      });
      return;
    }

    applyBranchPanelEvent(runtime, data.event);
  }
}

/**
 * A write accepted by the authority, made anywhere. Keeps every open tab in step
 * instead of each one discovering the change on its next navigation.
 */
/**
 * Broadcasts that arrived before this page finished restoring its panels.
 *
 * A tab opened while another tab is writing is the ordinary case, not an edge
 * one: the two operations are concurrent by nature.
 */
const pendingPanelChanges = new Map<string, PanelChangedMessage>();

function handlePanelChanged(message: PanelChangedMessage): void {
  if (!message.panelId) {
    return;
  }

  if (message.deleted) {
    const runtime = panelRuntimes.get(message.panelId);
    if (runtime) {
      clearPanelWatchdog(runtime);
      runtime.iframeEl.src = 'about:blank';
      runtime.element.remove();
      panelRuntimes.delete(message.panelId);
      renderTabs();
    }
    panelRevisions.delete(message.panelId);
    unsavedPanelIds.delete(message.panelId);
    return;
  }

  const known = panelRevisions.get(message.panelId) ?? 0;
  if (message.rev <= known) {
    return;
  }

  if (panelRuntimes.has(message.panelId) && message.state) {
    adoptAuthoritativeState(message.panelId, message.state, message.rev);
    return;
  }

  // Not mounted yet. Recording the revision and dropping the state loses the
  // change for good: a restore already in flight lists an older snapshot, mounts
  // it, and the panel then sits at a revision it never actually holds. Hold the
  // change instead and apply it once this page knows its own panels.
  pendingPanelChanges.set(message.panelId, message);
}

function drainPendingPanelChanges(): void {
  if (!pendingPanelChanges.size) {
    return;
  }

  const changes = [...pendingPanelChanges.values()];
  pendingPanelChanges.clear();

  const currentScopeKey = currentIdentity(lastKnownUrl).scopeKey;

  changes.forEach((change) => {
    if (change.deleted) {
      handlePanelChanged(change);
      return;
    }

    if (panelRuntimes.has(change.panelId)) {
      handlePanelChanged(change);
      return;
    }

    if (!change.state || closedPanelIds.has(change.panelId)) {
      return;
    }

    // A panel created in another tab for this same conversation: mount it here
    // rather than waiting for a reload to notice it.
    const restoredState = createStateFromRestore(change.state);
    if (!restoredState) {
      return;
    }
    if (change.scopeKey !== currentScopeKey) {
      if (!restoredState.minimized) {
        return;
      }
      restoredState.minimized = true;
    }

    panelRevisions.set(change.panelId, change.rev);
    createPanelRuntime(restoredState);
  });

  syncMountedUi();
}

function handleForwardedBranchPanelEvent(message: ForwardBranchPanelEventMessage): void {
  if (!isBranchAttemptRef(message) || !isBranchPanelEvent(message.event)) {
    return;
  }

  const runtime = panelRuntimes.get(message.panelId);
  if (!runtime) {
    return;
  }

  if (!ownsAttempt(message, currentAttemptRef(runtime))) {
    appendPanelLog(runtime, 'Ignored a background branch event from a superseded attempt', {
      eventKind: message.event.kind,
      messageAttemptId: message.attemptId,
      currentAttemptId: runtime.state.attemptId ?? null
    });
    return;
  }

  // Only a native-window branch reports through the background. Retrying a failed native
  // branch switches the panel back to an embedded frame and leaves the old window open;
  // without this guard a late event from that orphan could mark the new branch live with
  // the previous conversation's URL.
  if (runtime.state.surfaceMode !== 'native_window') {
    appendPanelLog(runtime, 'Ignored a background branch event for an embedded panel', {
      eventKind: message.event.kind,
      surfaceMode: runtime.state.surfaceMode
    });
    return;
  }

  applyBranchPanelEvent(runtime, message.event);
}

function installRuntimeMessageListener(): void {
  if (!hasRuntimeAccess()) {
    return;
  }

  const runtimeMessageListener = (
    message: RunBranchPromptInTabMessage | ForwardBranchPanelEventMessage | PanelChangedMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (!isTopFrame() || !message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    if (message.type === 'PANEL_CHANGED') {
      handlePanelChanged(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'BRANCH_PANEL_EVENT') {
      handleForwardedBranchPanelEvent(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'RUN_BRANCH_PROMPT_IN_TAB') {
      if (!isRunBranchPromptRequest(message)) {
        sendResponse({
          ok: false,
          reason: 'The branch run request was malformed and was not started.'
        });
        return false;
      }

      if (automationTaskRunning) {
        sendResponse({
          ok: false,
          reason: `Another branch automation is already running in this ${provider.label} window.`
        });
        return false;
      }

      void runBranchPromptAutomation(message, 'background');
      sendResponse({ ok: true });
      return false;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(runtimeMessageListener);
  cleanupFns.push(() => {
    chrome.runtime.onMessage.removeListener(runtimeMessageListener);
  });
}

async function startBranch(panelId: string, question: string): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  // Freeze the context now: a later edit, or the source answer still streaming,
  // must not change a prompt that is already in flight.
  // A context rebuilt here must be kept, or the preview the user is told to open
  // stays empty and the same error repeats with nothing they can do about it.
  const context = runtime.state.context ?? createContextForSelection(runtime.state.selection);
  runtime.state.context = context;
  const limits = measureContext(context);
  if (limits.overBudget) {
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'This branch was not sent.';
    runtime.state.errorMessage = `The context is ${describeContextSize(limits)}. Open Context and remove some material, then try again.`;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels();
    return;
  }

  const frozen = freezeContext(context);
  const prompt = buildBranchPrompt({ contextText: frozen.text, question }).prompt;
  const launchUrl = provider.normalizeUrl(currentIdentity(runtime.state.rootChatUrl).launchUrl);

  if (!launchUrl) {
    runtime.state.initialQuestion = question;
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'Local branch creation failed.';
    runtime.state.errorMessage = `Could not determine a launch URL for this ${provider.label} branch.`;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels();
    return;
  }

  appendPanelLog(runtime, 'Start branch requested', {
    questionLength: question.length,
    rootChatUrl: runtime.state.rootChatUrl,
    launchUrl,
    branchKind: runtime.state.branchKind,
    entryAction: runtime.state.entryAction,
    selectedTextLength: runtime.state.selection.selectedText.length,
    selectedAssistantBlockIds: runtime.state.selection.selectedBlocks
      .filter((block) => block.role === 'assistant')
      .map((block) => block.messageId),
    promptLength: prompt.length
  });
  if (runtime.state.branchChatUrl) {
    // The previous attempt already created a conversation. Keep the link in the log so a
    // retry does not erase the only way back to something the user may need to delete.
    appendPanelLog(runtime, 'Replacing a branch that already has a conversation URL', {
      previousBranchChatUrl: runtime.state.branchChatUrl
    });
  }

  // A fresh attempt id per try. Anything still running from the previous attempt —
  // an orphaned native window, a frame that has not been torn down yet — is
  // identified by the old id and can no longer touch this panel.
  runtime.state.attemptId = createAttemptId();
  startedAttemptIds.add(runtime.state.attemptId);
  // Some providers refuse to be framed. Where that is the case the branch opens in
  // a window Aside drives instead — a real fallback with the same context and the
  // same state safety, not an embedded pass reported under another name.
  const canEmbed = surfaceIsAvailable(provider.surfaces.embedded);
  if (!canEmbed && !surfaceIsAvailable(provider.surfaces.nativeWindow)) {
    // Neither surface is available: say so rather than opening a window that
    // cannot be driven and timing out on the watchdog.
    runtime.state.initialQuestion = question;
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'This branch was not started.';
    runtime.state.errorMessage = provider.surfaces.detail;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels(runtime.state.panelId);
    return;
  }
  runtime.state.initialQuestion = question;
  runtime.state.initialPrompt = prompt;
  runtime.state.surfaceMode = canEmbed ? 'embedded' : 'native_window';
  runtime.state.launchUrl = launchUrl;
  runtime.state.branchChatUrl = undefined;
  runtime.state.launchTabId = undefined;
  runtime.state.launchWindowId = undefined;
  runtime.state.creationMode =
    runtime.state.branchKind === 'temporary' ? 'local_temporary' : 'local_persistent';
  runtime.state.title = DEFAULT_BRANCH_TITLE;
  runtime.state.titleStatus = 'pending';
  runtime.state.status = 'creating_branch';
  runtime.state.statusLabel = canEmbed
    ? `Loading the embedded ${provider.label} branch window...`
    : `Opening a ${provider.label} window for this branch...`;
  runtime.state.errorMessage = undefined;
  runtime.state.updatedAt = Date.now();
  persistLastUsedBranchKind(runtime.state.branchKind);
  runtime.pendingFramePrompt = canEmbed ? prompt : undefined;
  runtime.frameReady = false;
  runtime.frameStartSent = false;

  minimizeOtherPanels(panelId);
  if (canEmbed) {
    loadEmbeddedBranchFrame(runtime, launchUrl);
  }
  syncPanelUI(runtime);
  renderTabs();
  persistPanels();

  if (!canEmbed) {
    await openBranchInDrivenWindow(runtime, prompt, launchUrl);
  }
}

/**
 * Run a branch in a window Aside opens, for providers that cannot be embedded.
 * Same attempt id, same watchdog, same failure reporting as the embedded path.
 */
async function openBranchInDrivenWindow(
  runtime: PanelRuntime,
  prompt: string,
  launchUrl: string
): Promise<void> {
  const attempt = currentAttemptRef(runtime);
  if (!attempt) {
    appendPanelLog(runtime, 'Refusing to open a branch window without an attempt id');
    return;
  }

  startPanelWatchdog(
    runtime,
    BRANCH_RESPONSE_TIMEOUT_MS,
    `The ${provider.label} branch window stopped reporting back. Use Open branch to check it directly, or try again.`
  );

  const response = await createNativeBranchWindow({
    attempt,
    prompt,
    launchUrl,
    branchKind: runtime.state.branchKind,
    focusWindow: true,
    arrangeSideBySide: true
  });

  if (!response.ok) {
    clearPanelWatchdog(runtime);
    appendPanelLog(runtime, 'Branch window could not be opened', { reason: response.reason });
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = `${provider.label} branch creation failed.`;
    runtime.state.errorMessage =
      response.reason ?? `The ${provider.label} branch window could not be opened.`;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels();
    return;
  }

  runtime.state.launchTabId = response.tabId;
  runtime.state.launchWindowId = response.windowId;
  runtime.state.updatedAt = Date.now();
  syncPanelUI(runtime);
  persistPanels();
}

function applyBranchPanelEvent(runtime: PanelRuntime, event: BranchPanelEvent): void {
  switch (event.kind) {
    case 'status':
      appendPanelLog(runtime, 'Embedded branch status', {
        status: event.status,
        statusLabel: event.statusLabel
      });
      runtime.state.status = event.status;
      runtime.state.statusLabel = event.statusLabel;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      persistPanels();
      return;

    case 'debug-log':
      appendPanelLogEntries(runtime, [event.message]);
      syncPanelUI(runtime);
      persistPanelsSoon(runtime.state.panelId);
      return;

    case 'title':
      appendPanelLog(runtime, 'Branch title detected', event.title);
      runtime.state.title = event.title;
      runtime.state.titleStatus = 'ready';
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      renderTabs();
      persistPanels();
      return;

    case 'live':
      clearPanelWatchdog(runtime);
      runtime.pendingFramePrompt = undefined;
      runtime.state.launchTabId = event.launchTabId ?? runtime.state.launchTabId;
      runtime.state.launchWindowId = event.launchWindowId ?? runtime.state.launchWindowId;
      runtime.state.branchChatUrl = event.branchChatUrl
        ? normalizeChatUrl(event.branchChatUrl)
        : runtime.state.branchChatUrl;
      appendPanelLog(runtime, 'Branch is live', {
        branchChatUrl: runtime.state.branchChatUrl,
        launchTabId: runtime.state.launchTabId,
        launchWindowId: runtime.state.launchWindowId,
        surfaceMode: runtime.state.surfaceMode
      });
      runtime.state.status = 'live';
      runtime.state.creationMode =
        runtime.state.branchKind === 'temporary' ? 'local_temporary' : 'local_persistent';
      runtime.state.statusLabel =
        runtime.state.surfaceMode === 'native_window'
          ? `Branch answer is ready in its ${provider.label} window.`
          : 'Branch answer is ready in this window.';
      runtime.state.errorMessage = undefined;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      renderTabs();
      persistPanels();
      return;

    case 'failed':
      clearPanelWatchdog(runtime);
      appendPanelLog(runtime, 'Branch reported failure', {
        reason: event.reason,
        branchChatUrl: event.branchChatUrl,
        launchTabId: event.launchTabId,
        launchWindowId: event.launchWindowId,
        surfaceMode: runtime.state.surfaceMode
      });
      runtime.state.launchTabId = event.launchTabId ?? runtime.state.launchTabId;
      runtime.state.launchWindowId = event.launchWindowId ?? runtime.state.launchWindowId;
      runtime.state.branchChatUrl = event.branchChatUrl
        ? normalizeChatUrl(event.branchChatUrl)
        : runtime.state.branchChatUrl;
      if (
        runtime.state.branchKind === 'persistent' &&
        runtime.state.surfaceMode === 'embedded' &&
        /never became a persistent chat url/i.test(event.reason)
      ) {
        // If the URL turned up late, the branch really did succeed. Re-sending here
        // would post the same question a second time and leave two conversations.
        if (runtime.state.branchChatUrl) {
          appendPanelLog(runtime, 'Persistent branch URL arrived late; keeping the existing branch', {
            branchChatUrl: runtime.state.branchChatUrl
          });
          applyBranchPanelEvent(runtime, {
            kind: 'live',
            branchChatUrl: runtime.state.branchChatUrl
          });
          return;
        }

        void promotePersistentBranchToNativeWindow(runtime);
        return;
      }

      runtime.pendingFramePrompt = undefined;
      runtime.state.status = 'failed';
      runtime.state.creationMode = 'failed';
      runtime.state.statusLabel =
        runtime.state.surfaceMode === 'native_window'
          ? `${provider.label} branch creation failed.`
          : 'Local branch creation failed.';
      runtime.state.errorMessage = event.reason;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      persistPanels();
  }
}

function clearHighlightOverlay(): void {
  window.clearTimeout(highlightOverlayTimer);
  highlightOverlay?.remove();
  document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
  highlightOverlay = null;
  highlightOverlayTimer = undefined;
}

/**
 * Draw the origin highlight in Aside's own overlay.
 *
 * `outlineRect` used to be a class added to the provider's own message element —
 * a write to a provider-owned node, on an attribute the layout observer watches,
 * undone by a bare timer that a cleanup within the next 2.2s would leave behind
 * on the page permanently.
 */
function renderHighlightRects(rects: DOMRect[], outlineRect?: DOMRect): void {
  clearHighlightOverlay();
  highlightOverlay = document.createElement('div');
  highlightOverlay.id = HIGHLIGHT_OVERLAY_ID;
  rects.forEach((rect) => {
    const highlight = document.createElement('div');
    highlight.className = 'aside-highlight-rect';
    highlight.style.top = `${rect.top}px`;
    highlight.style.left = `${rect.left}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlightOverlay?.append(highlight);
  });

  if (outlineRect) {
    const outline = document.createElement('div');
    outline.className = 'aside-origin-outline';
    outline.style.top = `${outlineRect.top}px`;
    outline.style.left = `${outlineRect.left}px`;
    outline.style.width = `${outlineRect.width}px`;
    outline.style.height = `${outlineRect.height}px`;
    highlightOverlay.append(outline);
  }

  mountInExtensionHost(highlightOverlay);
  highlightOverlayTimer = window.setTimeout(clearHighlightOverlay, 2200);
}

function getFirstRangeRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (!rects.length) {
    return null;
  }

  rects.sort((left, right) => {
    if (left.top !== right.top) {
      return left.top - right.top;
    }
    return left.left - right.left;
  });

  return rects[0] ?? null;
}

function getScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY.toLowerCase();
    const isScrollable = /(auto|scroll|overlay)/.test(overflowY);
    if (isScrollable && current.scrollHeight > current.clientHeight + 4) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function scrollRectIntoView(rect: DOMRect, anchorElement: HTMLElement): void {
  const topOffset = Math.max(96, Math.round(window.innerHeight * 0.18));
  const scrollParent = getScrollableAncestor(anchorElement);

  if (!scrollParent) {
    const absoluteTop = window.scrollY + rect.top;
    window.scrollTo({
      top: Math.max(0, absoluteTop - topOffset),
      behavior: 'smooth'
    });
    return;
  }

  const parentRect = scrollParent.getBoundingClientRect();
  const delta = rect.top - parentRect.top - topOffset;
  scrollParent.scrollTo({
    top: Math.max(0, scrollParent.scrollTop + delta),
    behavior: 'smooth'
  });
}

// getClientRects() during a smooth scroll returns coordinates that are stale by the time
// the fixed-position overlay is painted, so wait for the scroll to finish first.
function afterScrollSettles(callback: () => void): void {
  let done = false;
  const run = () => {
    if (done) {
      return;
    }
    done = true;
    window.removeEventListener('scrollend', run, true);
    window.clearTimeout(fallbackTimer);
    callback();
  };

  const fallbackTimer = window.setTimeout(run, 900);
  if ('onscrollend' in window) {
    window.addEventListener('scrollend', run, true);
  }
}

function scrollToOrigin(selection: SelectionPayload): void {
  const target = findTurnElementByAnchor(selection);
  if (!target) {
    window.scrollTo({ top: selection.fallbackScrollY, behavior: 'smooth' });
    return;
  }

  const exactRange = findQuotedTextRangeInElement(target, {
    selectedText: selection.selectedText,
    rangeQuotes: selection.rangeQuotes
  });

  if (exactRange) {
    const firstRect = getFirstRangeRect(exactRange);
    if (firstRect) {
      scrollRectIntoView(firstRect, target);
      afterScrollSettles(() => {
        renderHighlightRects(
          Array.from(exactRange.getClientRects()).map((rect) => rect as DOMRect),
          target.getBoundingClientRect()
        );
      });
      return;
    }
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  afterScrollSettles(() => {
    renderHighlightRects([target.getBoundingClientRect()]);
  });
}

async function handleUrlChange(): Promise<void> {
  const nextUrl = normalizeChatUrl(window.location.href);
  if (nextUrl === lastKnownUrl) {
    return;
  }

  // Each await below is a chance for a newer navigation to start. Without this token the
  // older run resumes afterwards and restores the previous conversation's panels over it.
  const token = ++pendingUrlChangeToken;
  const isStale = () => token !== pendingUrlChangeToken;

  const currentConversationId = currentIdentity(lastKnownUrl).scopeKey;
  const nextConversationId = currentIdentity(nextUrl).scopeKey;

  if (nextConversationId === currentConversationId) {
    lastKnownUrl = nextUrl;
    panelRuntimes.forEach((runtime) => {
      if (runtime.state.rootConversationId === currentConversationId) {
        runtime.state.rootChatUrl = nextUrl;
        runtime.state.rootProjectUrl = getNonRootContainerUrl(nextUrl);
        runtime.state.updatedAt = Date.now();
      }
    });
    persistPanels();
    syncMountedUi();
    return;
  }

  if (
    nextConversationId === 'chat-home' &&
    currentConversationId !== 'chat-home' &&
    panelRuntimes.size > 0
  ) {
    // ChatGPT briefly routes through "/" while switching chats; wait for it to settle.
    await sleep(1200);
    if (isStale()) {
      return;
    }

    const settledUrl = normalizeChatUrl(window.location.href);
    if (settledUrl !== nextUrl) {
      await handleUrlChange();
      return;
    }
  }

  await flushPersistedPanels();
  if (isStale()) {
    return;
  }

  clearPanelsForCurrentConversation();
  hideAskButton();
  lastKnownUrl = nextUrl;
  await restorePanels();
  if (isStale()) {
    return;
  }

  syncMountedUi();
  scheduleMountedUiSync(350);
}

const URL_POLL_INTERVAL_MS = 400;

function installUrlObservers(): void {
  // A content script runs in an isolated world, so patching history.pushState here only
  // replaces this world's copy — ChatGPT's router calls the real one and never triggers
  // the patch. The patch is kept as a fast path; polling is what actually catches SPA
  // navigation between conversations.
  const urlPollTimer = window.setInterval(() => {
    if (normalizeChatUrl(window.location.href) !== lastKnownUrl) {
      pendingUrlChangeToken += 1;
      void handleUrlChange();
    }
  }, URL_POLL_INTERVAL_MS);
  cleanupFns.push(() => window.clearInterval(urlPollTimer));

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    const result = originalPushState(...args);
    queueMicrotask(() => {
      pendingUrlChangeToken += 1;
      void handleUrlChange();
    });
    return result;
  };

  history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    queueMicrotask(() => {
      pendingUrlChangeToken += 1;
      void handleUrlChange();
    });
    return result;
  };

  const popstateListener = () => {
    pendingUrlChangeToken += 1;
    void handleUrlChange();
  };

  window.addEventListener('popstate', popstateListener);

  cleanupFns.push(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener('popstate', popstateListener);
  });
}

function initTopFrame(): void {
  installThemeObserver();
  ensureStyles();
  // Deliberately NOT ensureFrameAutomationStyles(): the page the user is reading
  // keeps the provider's own rendering exactly as the provider authored it.
  installRuntimeMessageListener();
  syncMountedUi();
  void (async () => {
    await migrateLegacyPanelStorage();
    await loadLastUsedBranchKind();
    await restorePanels();
    syncMountedUi();
    scheduleMountedUiSync(350);
    scheduleMountedUiSync(1500);
  })();
  undoLegacySelectionSuppression();
  installNativeLayoutObserver();

  const selectionListener = () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(evaluateSelection, 120);
  };
  const mouseupListener = () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(evaluateSelection, 80);
  };
  const scrollListener = () => {
    scheduleSelectionToolbarSync();
  };
  const resizeListener = () => {
    syncMountedUi();
    syncSelectionToolbarToViewport();
  };
  const pageshowListener = () => {
    syncMountedUi();
    scheduleMountedUiSync(350);
  };
  const focusListener = () => {
    focusPendingDraftQuestionInput();
  };
  const visibilityListener = () => {
    if (document.visibilityState === 'visible') {
      focusPendingDraftQuestionInput();
      return;
    }

    // Debounced writes would otherwise be lost if the tab is discarded while hidden.
    void flushPersistedPanels();
  };
  const pagehideListener = () => {
    void flushPersistedPanels();
  };
  const keydownListener = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }

    // Escape belongs to whatever the user is actually in. Only act when focus is
    // inside Aside's own UI, and never preventDefault: the provider still needs
    // Escape to dismiss its menus, cancel IME composition and blur its composer.
    const target = event.target;
    const insideAside =
      target instanceof Node && Boolean(extensionHost && extensionHost.contains(target));
    if (!insideAside) {
      return;
    }

    const latestVisible = getVisiblePanels().at(-1);
    if (latestVisible) {
      minimizePanel(latestVisible.state.panelId);
    }
  };

  document.addEventListener('selectionchange', selectionListener);
  document.addEventListener('mouseup', mouseupListener);
  // ChatGPT scrolls an inner container, and scroll events from it never reach window
  // without capture, which used to leave the toolbar stranded over unrelated text.
  const scrollListenerOptions: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('scroll', scrollListener, scrollListenerOptions);
  window.addEventListener('resize', resizeListener);
  window.addEventListener('pageshow', pageshowListener);
  window.addEventListener('focus', focusListener);
  document.addEventListener('visibilitychange', visibilityListener);
  window.addEventListener('pagehide', pagehideListener);
  document.addEventListener('keydown', keydownListener);
  installUrlObservers();

  const frameMessageListener = (event: MessageEvent<FrameIncomingMessage>) => {
    handleEmbeddedFrameMessage(event);
  };
  window.addEventListener('message', frameMessageListener);
  cleanupFns.push(() => {
    window.removeEventListener('message', frameMessageListener);
  });

  cleanupFns.push(() => document.removeEventListener('selectionchange', selectionListener));
  cleanupFns.push(() => document.removeEventListener('mouseup', mouseupListener));
  cleanupFns.push(() => {
    window.removeEventListener('scroll', scrollListener, scrollListenerOptions);
    if (toolbarSyncFrame !== undefined) {
      window.cancelAnimationFrame(toolbarSyncFrame);
      toolbarSyncFrame = undefined;
    }
  });
  cleanupFns.push(() => window.removeEventListener('resize', resizeListener));
  cleanupFns.push(() => window.removeEventListener('pageshow', pageshowListener));
  cleanupFns.push(() => window.removeEventListener('focus', focusListener));
  cleanupFns.push(() => document.removeEventListener('visibilitychange', visibilityListener));
  cleanupFns.push(() => window.removeEventListener('pagehide', pagehideListener));
  cleanupFns.push(() => document.removeEventListener('keydown', keydownListener));
}

function getDeepQueryRoots(root: ParentNode = document): ParentNode[] {
  const roots: ParentNode[] = [];
  const seen = new Set<Node>();

  const visit = (candidate: ParentNode | null | undefined): void => {
    if (!candidate) {
      return;
    }

    const node = candidate as unknown as Node;
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    roots.push(candidate);

    const traversalRoot =
      candidate instanceof Document
        ? candidate.documentElement
        : candidate instanceof ShadowRoot || candidate instanceof Element
          ? candidate
          : null;
    if (!traversalRoot) {
      return;
    }

    const walker = document.createTreeWalker(traversalRoot, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = traversalRoot;
    while (current) {
      if (current instanceof HTMLElement && current.shadowRoot?.mode === 'open') {
        visit(current.shadowRoot);
      }
      current = walker.nextNode();
    }
  };

  visit(root);
  return roots;
}

function queryOne<T extends Element = HTMLElement>(selectors: string[], root: ParentNode = document): T | null {
  const searchRoots = getDeepQueryRoots(root);
  for (const selector of selectors) {
    for (const searchRoot of searchRoots) {
      const match = searchRoot.querySelector<T>(selector);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

function queryMany<T extends Element = HTMLElement>(selectors: string[], root: ParentNode = document): T[] {
  const results: T[] = [];
  const seen = new Set<Element>();
  const searchRoots = getDeepQueryRoots(root);
  selectors.forEach((selector) => {
    searchRoots.forEach((searchRoot) => {
      Array.from(searchRoot.querySelectorAll<T>(selector)).forEach((match) => {
        if (seen.has(match)) {
          return;
        }
        seen.add(match);
        results.push(match);
      });
    });
  });
  return results;
}

function getComposerCandidates(): Array<HTMLElement | HTMLTextAreaElement> {
  const selectors = provider.composer.composerSelectors;
  const seen = new Set<Element>();
  const candidates: Array<HTMLElement | HTMLTextAreaElement> = [];

  queryMany<HTMLElement | HTMLTextAreaElement>(selectors).forEach((candidate) => {
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  });
  return candidates;
}

function isDisabledElement(element: Element): boolean {
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.disabled;
  }

  return element.getAttribute('aria-disabled') === 'true';
}

function scoreComposerCandidate(candidate: HTMLElement | HTMLTextAreaElement): number {
  if (!isElementVisible(candidate) || isDisabledElement(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (candidate.getAttribute('readonly') === 'true' || candidate.hasAttribute('readonly')) {
    return Number.NEGATIVE_INFINITY;
  }

  const rect = candidate.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 24) {
    return Number.NEGATIVE_INFINITY;
  }

  const label = compactWhitespace(
    [
      candidate.id,
      candidate.getAttribute('name'),
      candidate.getAttribute('placeholder'),
      candidate.getAttribute('aria-label'),
      candidate.getAttribute('data-testid'),
      candidate.getAttribute('role')
    ]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  let score = 0;
  if (candidate.id === 'prompt-textarea') {
    score += 500;
  }
  if (candidate.closest('form')) {
    score += 120;
  }
  if (candidate instanceof HTMLTextAreaElement) {
    score += 80;
  }
  if (candidate.matches('div[contenteditable="true"]')) {
    score += 40;
  }
  if (candidate.getAttribute('role') === 'textbox') {
    score += 40;
  }
  if (/prompt|message|ask|chatgpt|question|send|发送|提问|问题|消息/.test(label)) {
    score += 140;
  }
  if (candidate.getAttribute('placeholder')) {
    score += 30;
  }

  score += Math.min(200, Math.round(rect.width / 4));
  score += Math.min(120, Math.round(rect.height * 2));
  score += Math.max(0, Math.round(rect.top / 3));
  score += Math.max(0, Math.round((window.innerHeight - Math.max(0, window.innerHeight - rect.bottom)) / 6));

  return score;
}

function describeComposerCandidate(candidate: HTMLElement | HTMLTextAreaElement): Record<string, unknown> {
  const rect = candidate.getBoundingClientRect();
  return {
    tag: candidate.tagName,
    id: candidate.id || null,
    name: candidate.getAttribute('name'),
    placeholder: candidate.getAttribute('placeholder'),
    ariaLabel: candidate.getAttribute('aria-label'),
    dataTestId: candidate.getAttribute('data-testid'),
    role: candidate.getAttribute('role'),
    hasForm: Boolean(candidate.closest('form')),
    rect: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    score: scoreComposerCandidate(candidate)
  };
}

function findComposer(): HTMLElement | HTMLTextAreaElement | null {
  const candidates = getComposerCandidates()
    .map((candidate) => ({
      candidate,
      score: scoreComposerCandidate(candidate)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.candidate ?? null;
}

async function waitForComposer(timeoutMs = 20_000): Promise<HTMLElement | HTMLTextAreaElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) {
      return composer;
    }
    await sleep(250);
  }

  throw new Error(`The ${provider.label} composer did not appear in time.`);
}

function getComposerValueLength(composer: HTMLElement | HTMLTextAreaElement): number {
  return composer instanceof HTMLTextAreaElement
    ? composer.value.length
    : compactWhitespace(composer.textContent || '').length;
}

function refreshComposerReference(
  composer: HTMLElement | HTMLTextAreaElement
): HTMLElement | HTMLTextAreaElement {
  return findComposer() ?? composer;
}

async function focusComposerForFollowUp(timeoutMs = 5_000): Promise<void> {
  const composer = await waitForComposer(timeoutMs);
  composer.click();
  composer.focus();

  if (composer instanceof HTMLTextAreaElement) {
    const nextPosition = composer.value.length;
    composer.setSelectionRange(nextPosition, nextPosition);
  }

  recordAutomationLog('Composer focused for manual follow-up', {
    composerCandidate: describeComposerCandidate(composer)
  });
}

function describeComposerCandidateForLog(
  composer: HTMLElement | HTMLTextAreaElement,
  fallback?: Record<string, unknown>
): Record<string, unknown> {
  if (composer.isConnected) {
    const description = describeComposerCandidate(composer);
    const rect = description.rect as Record<string, number> | undefined;
    if (rect && ((rect.width ?? 0) > 0 || (rect.height ?? 0) > 0)) {
      return description;
    }
  }

  return fallback ?? describeComposerCandidate(composer);
}

function fillComposer(
  composer: HTMLElement | HTMLTextAreaElement,
  prompt: string,
  inputType: 'insertText' | 'insertFromPaste' = 'insertText'
): void {
  composer.click();
  composer.focus();

  if (composer instanceof HTMLTextAreaElement) {
    composer.setSelectionRange(0, composer.value.length);
    composer.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: prompt,
        inputType
      })
    );
    try {
      composer.setRangeText(prompt, 0, composer.value.length, 'end');
    } catch {
      // Fall back to the native setter below if setRangeText is unavailable.
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(composer, prompt);
    composer.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: prompt,
        inputType
      })
    );
    composer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA' }));
    composer.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', code: 'KeyA' }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  try {
    if (prompt) {
      document.execCommand('insertText', false, prompt);
    } else {
      // insertText with an empty string is a no-op, so deleting the selection is the
      // only way to actually empty a contenteditable composer.
      document.execCommand('delete');
    }
  } catch {
    composer.textContent = prompt;
  }

  composer.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: prompt,
      inputType
    })
  );
}

function countSignificantChars(value: string): number {
  return value.replace(/\s+/g, '').length;
}

// A ProseMirror composer renders the prompt's blank lines as separate paragraphs, so its
// textContent has no separator at all where the prompt had a newline. Comparing raw or
// whitespace-collapsed lengths therefore always came up short and the composer was filled
// twice on every branch. Compare the characters that actually matter instead.
function getComposerSignificantLength(composer: HTMLElement | HTMLTextAreaElement): number {
  return countSignificantChars(
    composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent ?? ''
  );
}

async function fillComposerWithStrategies(
  composer: HTMLElement | HTMLTextAreaElement,
  prompt: string
): Promise<{
  composer: HTMLElement | HTMLTextAreaElement;
  strategy: 'insertText' | 'insertFromPaste';
  valueLength: number;
}> {
  const strategies: Array<'insertText' | 'insertFromPaste'> = ['insertText', 'insertFromPaste'];
  let activeComposer = composer;
  let bestResult = {
    composer: activeComposer,
    strategy: strategies[0],
    valueLength: getComposerValueLength(activeComposer)
  };

  for (const strategy of strategies) {
    fillComposer(activeComposer, prompt, strategy);
    await sleep(120);
    activeComposer = refreshComposerReference(activeComposer);
    const valueLength = getComposerValueLength(activeComposer);
    recordAutomationLog('Composer fill strategy attempted', {
      strategy,
      valueLength,
      significantLength: getComposerSignificantLength(activeComposer),
      expectedSignificantLength: countSignificantChars(prompt),
      composerCandidate: describeComposerCandidateForLog(activeComposer)
    });

    if (valueLength >= bestResult.valueLength) {
      bestResult = {
        composer: activeComposer,
        strategy,
        valueLength
      };
    }

    if (getComposerSignificantLength(activeComposer) >= countSignificantChars(prompt)) {
      return {
        composer: activeComposer,
        strategy,
        valueLength
      };
    }
  }

  return bestResult;
}

function getSendButtonCandidates(scope: ParentNode): HTMLElement[] {
  return queryMany<HTMLElement>(provider.composer.sendButtonSelectors, scope);
}

function describeSendButtonCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null,
  score = scoreSendButtonCandidate(candidate, composer)
): Record<string, unknown> {
  const rect = candidate.getBoundingClientRect();
  const profile = getSendCandidateProfile(candidate, composer);
  return {
    tag: candidate.tagName,
    role: candidate.getAttribute('role'),
    type: candidate instanceof HTMLButtonElement ? candidate.type : null,
    ariaLabel: candidate.getAttribute('aria-label'),
    title: candidate.getAttribute('title'),
    dataTestId: candidate.getAttribute('data-testid'),
    label: getActionLabel(candidate),
    disabled: isDisabledElement(candidate),
    explicitSend: profile.explicitSend,
    negative: profile.negative,
    temporaryChat: profile.temporaryChat,
    submitLike: profile.submitLike,
    sameForm: profile.sameForm,
    rect: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    score
  };
}

function getTemporaryChatControlCandidates(scope: ParentNode): HTMLElement[] {
  const selectors = provider.composer.privacyControlSelectors;
  const seen = new Set<HTMLElement>();
  const matches = queryMany<HTMLElement>(selectors, scope);
  const buttons = getSendButtonCandidates(scope).filter((candidate) => isTemporaryChatControl(candidate));

  return [...matches, ...buttons].filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function getComposerSearchScopes(
  composer?: HTMLElement | HTMLTextAreaElement | null
): ParentNode[] {
  const scopes: ParentNode[] = [];
  const localScope = composer?.closest('form') ?? composer?.parentElement ?? null;
  if (localScope) {
    scopes.push(localScope);
  }
  scopes.push(document);
  return scopes;
}

function findDirectTemporaryChatControl(
  composer?: HTMLElement | HTMLTextAreaElement | null,
  targetState: 'active' | 'any' = 'any'
): HTMLElement | null {
  const anySelectors = provider.composer.privacyControlSelectors;
  // An explicitly pressed/checked control is the strongest signal available, so look
  // for that form of each selector first.
  const activeSelectors = anySelectors.flatMap((selector) => [
    `${selector}[aria-pressed="true"]`,
    `${selector}[aria-checked="true"]`
  ]);

  for (const scope of getComposerSearchScopes(composer)) {
    const direct =
      targetState === 'active'
        ? queryOne<HTMLElement>(activeSelectors, scope)
        : queryOne<HTMLElement>(anySelectors, scope);
    if (direct) {
      return direct;
    }
  }

  return null;
}

function scoreTemporaryChatCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null
): number {
  if (isDisabledElement(candidate) || !isTemporaryChatControl(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }

  const rect = candidate.getBoundingClientRect();
  const composerRect = composer?.getBoundingClientRect();
  const inferredState = inferTemporaryChatState(candidate);
  let score = 0;

  if (isElementVisible(candidate)) {
    score += 120;
  }
  if (composer?.closest('form') && candidate.closest('form') === composer.closest('form')) {
    score += 250;
  }
  if (candidate instanceof HTMLButtonElement && candidate.type === 'submit') {
    score += 120;
  }
  if (inferredState === 'active') {
    score += 180;
  }
  if (inferredState === 'inactive') {
    score += 60;
  }
  if (composerRect) {
    const horizontalGap = Math.abs(rect.left - composerRect.right);
    const verticalGap = Math.abs(rect.top - composerRect.top);
    score += Math.max(0, 200 - Math.round(horizontalGap));
    score += Math.max(0, 140 - Math.round(verticalGap));
  }

  return score;
}

function describeTemporaryChatCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null,
  score = scoreTemporaryChatCandidate(candidate, composer)
): Record<string, unknown> {
  return {
    ...describeSendButtonCandidate(candidate, composer, score),
    inferredState: inferTemporaryChatState(candidate)
  };
}

function activateControl(candidate: HTMLElement): void {
  candidate.focus();
  const rect = candidate.getBoundingClientRect();
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2)
  };

  if (window.PointerEvent) {
    ['pointerdown', 'pointerup'].forEach((type) => {
      candidate.dispatchEvent(
        new window.PointerEvent(type, {
          ...eventInit,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true
        })
      );
    });
  }

  ['mousedown', 'mouseup', 'click'].forEach((type) => {
    candidate.dispatchEvent(new MouseEvent(type, eventInit));
  });
}

function getRankedTemporaryChatControls(
  composer?: HTMLElement | HTMLTextAreaElement | null
): Array<{ candidate: HTMLElement; score: number }> {
  const seen = new Set<HTMLElement>();
  return getComposerSearchScopes(composer)
    .flatMap((scope) => getTemporaryChatControlCandidates(scope))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    })
    .map((candidate) => ({
      candidate,
      score: scoreTemporaryChatCandidate(candidate, composer)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
}

async function ensurePersistentChatMode(
  composer: HTMLElement | HTMLTextAreaElement
): Promise<void> {
  const directActiveControl = findDirectTemporaryChatControl(composer, 'active');
  const directAnyControl = directActiveControl ?? findDirectTemporaryChatControl(composer, 'any');
  const candidates = getRankedTemporaryChatControls(composer);
  recordAutomationLog('Detected temporary chat controls', {
    directActiveControl: directActiveControl
      ? describeTemporaryChatCandidate(directActiveControl, composer)
      : null,
    directAnyControl: directAnyControl ? describeTemporaryChatCandidate(directAnyControl, composer) : null,
    candidates: candidates
      .slice(0, 8)
      .map((entry) => describeTemporaryChatCandidate(entry.candidate, composer, entry.score))
  });

  const primaryCandidate = directActiveControl ?? directAnyControl ?? candidates[0]?.candidate ?? null;
  const primaryScore = primaryCandidate ? scoreTemporaryChatCandidate(primaryCandidate, composer) : undefined;

  if (!primaryCandidate) {
    return;
  }

  const primaryState = inferTemporaryChatState(primaryCandidate);

  if (primaryState === 'inactive') {
    recordAutomationLog('Temporary chat control is present but inactive', {
      control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore),
      toggledOff: false
    });
    return;
  }

  if (primaryState === 'unknown') {
    // Clicking a toggle whose state we cannot read could switch temporary chat ON, which
    // is the outcome this function exists to avoid. Leave it alone and let the missing
    // /c/ URL downstream be the signal if the chat really was temporary.
    recordAutomationLog('Temporary chat control state is unreadable; leaving it untouched', {
      control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore)
    });
    return;
  }

  recordAutomationLog('Temporary chat mode appears active; disabling it before send', {
    control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore),
    toggledOff: false
  });
  // A bare .click() is ignored by toggles that listen for pointer events, which is why
  // the temporary-chat path already uses the full synthetic activation sequence.
  activateControl(primaryCandidate);

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const refreshedActive = findDirectTemporaryChatControl(composer, 'active');
    const refreshedAny = refreshedActive ?? findDirectTemporaryChatControl(composer, 'any');
    if (!refreshedAny) {
      recordAutomationLog('Temporary chat control disappeared after toggle', {
        toggledOff: true
      });
      return;
    }

    const nextState = inferTemporaryChatState(refreshedAny);
    if (nextState === 'inactive') {
      recordAutomationLog('Temporary chat mode disabled successfully', {
        control: describeTemporaryChatCandidate(refreshedAny, composer),
        toggledOff: true
      });
      return;
    }

    await sleep(200);
  }

  throw new Error(
    `${provider.label} is in ${provider.privacy.label} mode; persistent branch creation cannot continue.`
  );
}

async function ensureTemporaryChatMode(
  composer: HTMLElement | HTMLTextAreaElement
): Promise<void> {
  const label = provider.privacy.label;
  const directActiveControl = findDirectTemporaryChatControl(composer, 'active');
  const directAnyControl = directActiveControl ?? findDirectTemporaryChatControl(composer, 'any');
  const candidates = getRankedTemporaryChatControls(composer);
  recordAutomationLog('Detected private-mode controls for private branch', {
    privacyLabel: label,
    directActiveControl: directActiveControl
      ? describeTemporaryChatCandidate(directActiveControl, composer)
      : null,
    directAnyControl: directAnyControl ? describeTemporaryChatCandidate(directAnyControl, composer) : null,
    candidates: candidates
      .slice(0, 8)
      .map((entry) => describeTemporaryChatCandidate(entry.candidate, composer, entry.score))
  });

  const primaryCandidate = directActiveControl ?? directAnyControl ?? candidates[0]?.candidate ?? null;
  const primaryScore = primaryCandidate ? scoreTemporaryChatCandidate(primaryCandidate, composer) : undefined;

  if (!primaryCandidate) {
    throw new PrivacyNotVerifiedError(
      `Aside could not find ${provider.label}'s ${label} control, so nothing was typed or sent. Turn ${label} on yourself and try again, or switch this branch to Persistent.`
    );
  }

  if (isDisabledElement(primaryCandidate)) {
    throw new PrivacyNotVerifiedError(
      `${provider.label}'s ${label} control is disabled here, so nothing was typed or sent. This often means the current project or workspace does not allow it.`
    );
  }

  const primaryState = inferTemporaryChatState(primaryCandidate);
  if (primaryState === 'active') {
    recordAutomationLog('Private mode already active', {
      control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore)
    });
    return;
  }

  if (primaryState === 'unknown') {
    throw new PrivacyNotVerifiedError(
      `${provider.label} did not report whether ${label} is on, so nothing was typed or sent. Turn ${label} on yourself and try again, or switch this branch to Persistent.`
    );
  }

  recordAutomationLog('Private mode inactive; enabling it before anything is typed', {
    control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore)
  });
  activateControl(primaryCandidate);

  // Only a control we can still see, reporting active, counts as verification. A
  // control that vanished, never flipped, or timed out is not evidence of anything,
  // and this is the decision that determines whether private text is saved.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const refreshedActive = findDirectTemporaryChatControl(composer, 'active');
    const refreshedAny = refreshedActive ?? findDirectTemporaryChatControl(composer, 'any');

    if (refreshedAny && inferTemporaryChatState(refreshedAny) === 'active') {
      recordAutomationLog('Private mode verified active', {
        control: describeTemporaryChatCandidate(refreshedAny, composer)
      });
      return;
    }

    await sleep(200);
  }

  throw new PrivacyNotVerifiedError(
    `Aside turned on ${provider.label}'s ${label} but ${provider.label} never confirmed it, so nothing was typed or sent. Check ${label} yourself and try again, or switch this branch to Persistent.`
  );
}

/**
 * Re-check that the mode still holds after the prompt has been typed. The composer
 * can remount and a provider can drop out of private mode between the two steps.
 */
async function assertPrivateModeStillActive(
  composer: HTMLElement | HTMLTextAreaElement,
  prompt: string,
  options: { clearComposer?: boolean } = {}
): Promise<void> {
  const control =
    findDirectTemporaryChatControl(composer, 'active') ??
    findDirectTemporaryChatControl(composer, 'any') ??
    getRankedTemporaryChatControls(composer)[0]?.candidate ??
    null;

  const state = control ? inferTemporaryChatState(control) : 'missing';
  if (state === 'active') {
    return;
  }

  recordAutomationLog('Private mode stopped being verifiable after the prompt was typed', {
    state,
    control: control ? describeTemporaryChatCandidate(control, composer) : null
  });
  if (options.clearComposer === false) {
    // Nothing has been typed yet, so there is nothing to take back.
    throw new PrivacyNotVerifiedError(
      `${provider.label} stopped reporting ${provider.privacy.label} while the branch was being prepared, so nothing was typed or sent.`
    );
  }

  clearComposerAfterFailure(prompt);
  throw new PrivacyNotVerifiedError(
    `${provider.label} stopped reporting ${provider.privacy.label} while the branch was being prepared, so it was not sent. The text was removed from the composer.`
  );
}

async function ensureBranchKindMode(
  branchKind: BranchKind,
  composer: HTMLElement | HTMLTextAreaElement
): Promise<void> {
  if (branchKind === 'temporary') {
    await ensureTemporaryChatMode(composer);
    return;
  }

  await ensurePersistentChatMode(composer);
}

function scoreSendButtonCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null
): number {
  if (!isElementVisible(candidate) || isDisabledElement(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }

  const profile = getSendCandidateProfile(candidate, composer);
  const rect = candidate.getBoundingClientRect();
  const composerRect = composer?.getBoundingClientRect();
  let score = 0;

  if (!isAcceptableSendControl(profile)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (candidate.getAttribute('data-testid') === 'send-button') {
    score += 900;
  }
  if (profile.submitLike) {
    score += 500;
  }
  if (profile.explicitSend) {
    score += 400;
  }
  if (profile.sameForm) {
    score += 200;
  }
  if (!profile.label && candidate.querySelector('svg')) {
    score += 60;
  }
  if (composerRect) {
    const horizontalGap = Math.abs(rect.left - composerRect.right);
    const verticalGap = Math.abs(rect.top - composerRect.top);
    score += Math.max(0, 220 - Math.round(horizontalGap));
    score += Math.max(0, 140 - Math.round(verticalGap));
    if (profile.sameForm) {
      score += Math.max(0, 180 - Math.round(horizontalGap * 1.4));
    }
  }

  return score;
}

function getRankedSendButtons(
  composer?: HTMLElement | HTMLTextAreaElement | null
): Array<{ candidate: HTMLElement; score: number }> {
  const scopes: ParentNode[] = [];
  const localScope = composer?.closest('form') ?? composer?.parentElement ?? null;
  if (localScope) {
    scopes.push(localScope);
  }
  scopes.push(document);

  const seen = new Set<HTMLElement>();
  const ranked = scopes
    .flatMap((scope) => getSendButtonCandidates(scope))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    })
    .map((candidate) => ({
      candidate,
      score: scoreSendButtonCandidate(candidate, composer)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);

  const sameForm = ranked.filter((entry) => getSendCandidateProfile(entry.candidate, composer).sameForm);
  if (sameForm.length) {
    const nonSameForm = ranked.filter((entry) => !getSendCandidateProfile(entry.candidate, composer).sameForm);
    return [...sameForm, ...nonSameForm];
  }

  return ranked;
}

async function waitForAcceptedGenerationSignalOrNull(
  baselineTurnCount: number,
  initialUrl: string,
  timeoutMs = 2_500
): Promise<'persistent_url' | 'stop_button' | 'transcript_growth' | null> {
  try {
    return await waitForAcceptedGenerationSignal(baselineTurnCount, initialUrl, timeoutMs);
  } catch {
    return null;
  }
}

function findStopButton(): HTMLButtonElement | null {
  return queryOne<HTMLButtonElement>(provider.composer.stopButtonSelectors);
}

function isPersistentConversationUrl(url: string): boolean {
  return provider.isConversationUrl(url);
}

async function waitForAcceptedGenerationSignal(
  baselineTurnCount: number,
  initialUrl: string,
  timeoutMs = 12_000
): Promise<'persistent_url' | 'stop_button' | 'transcript_growth'> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentUrl = normalizeChatUrl(window.location.href);
    if (currentUrl !== initialUrl && isPersistentConversationUrl(currentUrl)) {
      return 'persistent_url';
    }

    if (findStopButton()) {
      return 'stop_button';
    }

    if (countTranscriptTurns(document) > baselineTurnCount) {
      return 'transcript_growth';
    }

    await sleep(250);
  }

  throw new Error(
    `${provider.label} did not start generating the branch question. No persistent chat URL, stop button, or new transcript turn appeared.`
  );
}

async function submitComposer(
  prompt: string,
  branchKind: BranchKind
): Promise<{
  acceptedSignal: 'persistent_url' | 'stop_button' | 'transcript_growth';
}> {
  recordAutomationLog('Preparing first branch prompt', {
    promptLength: prompt.length,
    branchKind,
    currentUrl: normalizeChatUrl(window.location.href)
  });
  const initialUrl = normalizeChatUrl(window.location.href);
  const baselineTurnCount = countTranscriptTurns(document);

  // Order matters and is the whole point of this sequence:
  //   surface -> activate the requested mode -> verify it -> acquire composer ->
  //   fill -> recheck the mode -> submit once.
  // Filling first, as this used to, means the selected passage is already sitting
  // in the composer when a mode control that might itself submit gets clicked.
  let composer = await waitForComposer();
  await ensureBranchKindMode(branchKind, composer);

  // The mode toggle can navigate and remount the composer, so acquire it again
  // rather than typing into a detached node.
  composer = await waitForComposer();

  // That re-acquire can take up to 20 s, during which the verification above goes
  // stale. Re-check against the composer that is actually about to be typed into,
  // so private text is never typed on the strength of a check made before a
  // navigation.
  if (branchKind === 'temporary') {
    await assertPrivateModeStillActive(composer, prompt, { clearComposer: false });
  }

  let composerSnapshot = describeComposerCandidate(composer);
  let form = composer.closest('form');
  recordAutomationLog('Composer acquired after the chat mode was verified', {
    composerTag: composer.tagName,
    composerCandidate: composerSnapshot,
    baselineTurnCount,
    branchKind,
    hasForm: form instanceof HTMLFormElement
  });

  const fillResult = await fillComposerWithStrategies(composer, prompt);
  composer = fillResult.composer;
  composerSnapshot = describeComposerCandidateForLog(composer, composerSnapshot);
  form = composer.closest('form');
  recordAutomationLog('Composer filled for first branch prompt', {
    strategy: fillResult.strategy,
    valueLength: fillResult.valueLength,
    composerCandidate: composerSnapshot
  });

  // The mode can change between typing and sending; check again before submitting.
  if (branchKind === 'temporary') {
    await assertPrivateModeStillActive(composer, prompt);
  }

  /**
   * Every submit attempt is guarded, not just the first.
   *
   * The fallback chain below spans roughly thirteen seconds of further attempts.
   * A single check before the first click would let a mode change part-way
   * through that window produce a persistent send, which is detectable only
   * afterwards.
   */
  const assertStillPrivateBeforeSend = async (): Promise<void> => {
    if (branchKind !== 'temporary') {
      return;
    }
    await assertPrivateModeStillActive(refreshComposerReference(composer), prompt);
  };

  const logVisibleButtonContext = (label: string) => {
    const currentComposer = refreshComposerReference(composer);
    const currentSnapshot = describeComposerCandidateForLog(currentComposer, composerSnapshot);
    recordAutomationLog(label, {
      composerCandidate: currentSnapshot,
      buttonCandidates: getSendButtonCandidates(document)
        .filter((candidate) => isElementVisible(candidate))
        .slice(0, 16)
        .map((candidate) => describeSendButtonCandidate(candidate, currentComposer)),
      temporaryChatCandidates: getRankedTemporaryChatControls(currentComposer)
        .slice(0, 8)
        .map((entry) => describeTemporaryChatCandidate(entry.candidate, currentComposer, entry.score))
    });
  };

  let significantLengthBeforeSend = 0;

  const attemptClickSendButton = async (
    stage: 'primary' | 'final_rescan',
    timeoutMs = 3_500
  ): Promise<'persistent_url' | 'stop_button' | 'transcript_growth' | null> => {
    composer = refreshComposerReference(composer);
    composerSnapshot = describeComposerCandidateForLog(composer, composerSnapshot);
    form = composer.closest('form');
    const rankedSendButtons = getRankedSendButtons(composer);
    const sendButton = rankedSendButtons[0]?.candidate ?? null;
    recordAutomationLog(
      stage === 'primary'
        ? 'Resolved send button for first branch prompt'
        : 'Resolved send button after fallback re-scan',
      {
        found: Boolean(sendButton),
        sendButtonLabel: sendButton ? getActionLabel(sendButton) : '(none)',
        sendButton: sendButton
          ? describeSendButtonCandidate(sendButton, composer, rankedSendButtons[0]?.score)
          : null,
        composerCandidate: composerSnapshot,
        sendButtonCandidates: rankedSendButtons
          .slice(0, 8)
          .map((entry) => describeSendButtonCandidate(entry.candidate, composer, entry.score))
      }
    );

    if (!sendButton) {
      return null;
    }

    recordAutomationLog(
      stage === 'primary'
        ? 'Clicking the provider send button for the first branch prompt'
        : 'Clicking send button after fallback re-scan',
      {
        sendButtonLabel: getActionLabel(sendButton),
        sendButton: describeSendButtonCandidate(sendButton, composer, rankedSendButtons[0]?.score)
      }
    );
    significantLengthBeforeSend = getComposerSignificantLength(composer);
    activateControl(sendButton);

    const signal = await waitForAcceptedGenerationSignalOrNull(
      baselineTurnCount,
      initialUrl,
      timeoutMs
    );
    if (signal) {
      recordAutomationLog('Provider accepted the prompt after send button click', {
        stage,
        acceptedSignal: signal,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      return signal;
    }

    recordAutomationLog('No generation signal appeared after send button click', {
      stage,
      timeoutMs,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    return null;
  };

  // ChatGPT clears the composer as soon as it accepts a prompt. If that already happened,
  // every remaining fallback would post the same question a second time. Requiring that
  // the composer held the prompt immediately before the click keeps a composer that was
  // merely remounted from looking like a successful send.
  const promptLooksAccepted = (): boolean =>
    significantLengthBeforeSend > 0 &&
    getComposerSignificantLength(refreshComposerReference(composer)) === 0;

  const waitOutAcceptedPrompt = async (
    stage: string
  ): Promise<{
    acceptedSignal: 'persistent_url' | 'stop_button' | 'transcript_growth';
  }> => {
    recordAutomationLog('Composer was cleared after submit; waiting instead of resending', {
      stage,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    const acceptedSignal = await waitForAcceptedGenerationSignal(baselineTurnCount, initialUrl);
    return { acceptedSignal };
  };

  const primarySendSignal = await attemptClickSendButton('primary');
  if (primarySendSignal) {
    return { acceptedSignal: primarySendSignal };
  }

  if (promptLooksAccepted()) {
    return waitOutAcceptedPrompt('after_send_button');
  }

  logVisibleButtonContext('No enabled send button produced a generation signal near the composer');
  await assertStillPrivateBeforeSend();
  recordAutomationLog('Dispatching Enter key fallback for first branch prompt', {
    hasForm: form instanceof HTMLFormElement
  });
  // Record what the composer held before each attempt, not just before the button click:
  // on a page where Enter is the only way to send, this is the signal that tells the next
  // fallback the prompt is already gone.
  significantLengthBeforeSend = getComposerSignificantLength(composer);
  ['keydown', 'keypress', 'keyup'].forEach((eventType) => {
    composer.dispatchEvent(
      new KeyboardEvent(eventType, {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter'
      })
    );
  });

  const enterSignal = await waitForAcceptedGenerationSignalOrNull(
    baselineTurnCount,
    initialUrl,
    2_500
  );
  if (enterSignal) {
    recordAutomationLog('Provider accepted the prompt after Enter fallback', {
      acceptedSignal: enterSignal,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    return { acceptedSignal: enterSignal };
  }

  recordAutomationLog('No generation signal appeared after Enter fallback', {
    currentUrl: normalizeChatUrl(window.location.href)
  });

  if (promptLooksAccepted()) {
    return waitOutAcceptedPrompt('after_enter_fallback');
  }

  if (form instanceof HTMLFormElement) {
    await assertStillPrivateBeforeSend();
    recordAutomationLog('Attempting guarded synthetic submit fallback for first branch prompt', {
      action: 'dispatch-submit-event'
    });
    significantLengthBeforeSend = getComposerSignificantLength(refreshComposerReference(composer));
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    const syntheticSignal = await waitForAcceptedGenerationSignalOrNull(
      baselineTurnCount,
      initialUrl,
      2_500
    );
    if (syntheticSignal) {
      recordAutomationLog('Provider accepted the prompt after guarded synthetic submit', {
        acceptedSignal: syntheticSignal,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      return { acceptedSignal: syntheticSignal };
    }

    recordAutomationLog('No generation signal appeared after guarded synthetic submit', {
      currentUrl: normalizeChatUrl(window.location.href)
    });
  }

  if (promptLooksAccepted()) {
    return waitOutAcceptedPrompt('after_synthetic_submit');
  }

  await assertStillPrivateBeforeSend();
  const rescannedSignal = await attemptClickSendButton('final_rescan', 4_500);
  if (rescannedSignal) {
    return { acceptedSignal: rescannedSignal };
  }

  logVisibleButtonContext('All embedded submit strategies were attempted without a generation signal');

  const acceptedSignal = await waitForAcceptedGenerationSignal(baselineTurnCount, initialUrl);
  recordAutomationLog('Provider accepted first branch prompt', {
    baselineTurnCount,
    currentTurnCount: countTranscriptTurns(document),
    acceptedSignal,
    currentUrl: normalizeChatUrl(window.location.href),
    stopButtonVisible: Boolean(findStopButton())
  });
  return { acceptedSignal };
}

// A temporary chat never gets a /c/<id> URL. ChatGPT rewrites the URL a beat after it
// starts generating, so sampling it the instant submitComposer returns cannot see a leak.
async function watchForPersistentConversationUrl(timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = normalizeChatUrl(window.location.href);
    if (isPersistentConversationUrl(currentUrl)) {
      return currentUrl;
    }
    await sleep(250);
  }

  return undefined;
}

async function waitForConversationUrlAfterSubmit(launchUrl: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = normalizeChatUrl(window.location.href);
    if (isPersistentConversationUrl(currentUrl)) {
      recordAutomationLog('Persistent branch conversation URL detected', { branchChatUrl: currentUrl });
      return currentUrl;
    }
    await sleep(300);
  }

  const currentUrl = normalizeChatUrl(window.location.href) || launchUrl;
  recordAutomationLog('Persistent branch conversation URL was not detected before timeout', {
    launchUrl,
    currentUrl
  });
  throw new Error(
    `${provider.label} started responding, but the branch never became a persistent chat URL. It stayed at ${currentUrl}.`
  );
}

let activeAttempt: BranchAttemptRef | undefined;
let activeAutomationTransport: AutomationTransport | undefined;
let automationTaskRunning = false;
let titleWatcherId: number | undefined;
let observedBranchTitle = '';

// Only ever removes our own prompt. By the time a branch fails the user may already be
// typing in that window, and wiping their text would be far worse than the stray prompt.
// A temporary branch that produced a /c/ URL is in the user's permanent history. Report
// the URL rather than a bare failure, so the panel can offer to open and delete it.
async function reportTemporaryBranchLeak(branchChatUrl: string): Promise<void> {
  recordAutomationLog('Private branch landed in a persistent conversation', {
    privacyLabel: provider.privacy.label,
    branchChatUrl
  });

  await sendAutomationEvent({
    kind: 'failed',
    reason: `${provider.label} saved this branch as a normal conversation even though ${provider.privacy.label} was verified before sending. Open the branch to review or delete it.`,
    branchChatUrl
  });
}

function clearComposerAfterFailure(prompt: string): void {
  try {
    const marker = compactWhitespace(prompt).slice(0, 60);
    if (!marker) {
      return;
    }

    const composer = findComposer();
    if (!composer) {
      return;
    }

    const current = compactWhitespace(
      composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent ?? ''
    );
    if (!current.startsWith(marker)) {
      return;
    }

    fillComposer(composer, '');
    recordAutomationLog('Cleared the unsent branch prompt out of the composer after a failure');
  } catch {
    // Never let cleanup mask the original failure.
  }
}

async function sendAutomationEvent(event: BranchPanelEvent): Promise<void> {
  if (!activeAttempt || !activeAutomationTransport) {
    return;
  }

  if (activeAutomationTransport === 'frame') {
    if (isTopFrame()) {
      return;
    }

    window.parent.postMessage(
      {
        source: 'aside',
        target: 'parent',
        type: 'SB_FRAME_EVENT',
        ...activeAttempt,
        event
      } satisfies FrameBranchEventMessage,
      window.location.origin
    );
    return;
  }

  if (!hasRuntimeAccess()) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: 'BRANCH_AUTOMATION_EVENT',
      ...activeAttempt,
      event
    });
  } catch (error) {
    if (!isInvalidatedError(error)) {
      console.warn('[Aside] Failed to forward automation event', error);
    }
  }
}

function findBranchTitleFromTranscript(): string | null {
  // The envelope is always on the branch's own answer, so there is no reason to rebuild
  // the text of every turn on a 1.2s interval.
  for (const text of getRecentAssistantTexts(3)) {
    const parsed = stripHiddenTitle(text);
    if (parsed.title) {
      return parsed.title;
    }
  }

  return null;
}

const TITLE_MARKER_PATTERN = /\[\[BRANCH_TITLE:.*?\]\]\s*/i;
const TITLE_MARKER_OPENING = '[[BRANCH_TITLE:';

// The envelope can arrive split across text nodes while the answer streams, and React
// re-renders the message afterwards and puts it straight back. So this handles the split
// case and is safe to call repeatedly.
function stripTitleEnvelopeFromVisibleMessage(): void {
  const candidates = queryMany<HTMLElement>([
    '[data-message-author-role="assistant"] [data-message-content]',
    'article[data-message-author-role="assistant"] [data-message-content]',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .prose'
  ]);

  candidates.forEach((candidate) => {
    if (!candidate.textContent?.includes(TITLE_MARKER_OPENING)) {
      return;
    }

    const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode as Text);
    }

    const combined = nodes.map((node) => node.nodeValue ?? '').join('');
    const match = combined.match(TITLE_MARKER_PATTERN);
    if (!match || match.index === undefined) {
      return;
    }

    const markerStart = match.index;
    const markerEnd = markerStart + match[0].length;

    let cursor = 0;
    nodes.forEach((node) => {
      const value = node.nodeValue ?? '';
      const nodeStart = cursor;
      const nodeEnd = cursor + value.length;
      cursor = nodeEnd;

      if (nodeEnd <= markerStart || nodeStart >= markerEnd) {
        return;
      }

      const from = Math.max(0, markerStart - nodeStart);
      const to = Math.min(value.length, markerEnd - nodeStart);
      node.nodeValue = value.slice(0, from) + value.slice(to);
    });
  });
}

function stopTitleWatcher(): void {
  if (titleWatcherId) {
    window.clearInterval(titleWatcherId);
    titleWatcherId = undefined;
  }
}

function startTitleWatcher(): void {
  if (titleWatcherId) {
    return;
  }

  const startedAt = Date.now();
  titleWatcherId = window.setInterval(() => {
    const title = findBranchTitleFromTranscript();
    if (title && title !== observedBranchTitle) {
      observedBranchTitle = title;
      void sendAutomationEvent({ kind: 'title', title });
    }

    // Keep stripping: the marker is detected in the first streamed chunk, and every
    // later re-render of that message re-inserts it.
    stripTitleEnvelopeFromVisibleMessage();

    if (Date.now() - startedAt > TITLE_MARKER_WATCH_TIMEOUT_MS) {
      stopTitleWatcher();
    }
  }, 1200);
}

async function runBranchPromptAutomation(
  message: FrameStartBranchMessage | RunBranchPromptInTabMessage,
  transport: AutomationTransport
): Promise<void> {
  if (automationTaskRunning) {
    return;
  }
  activeAttempt = {
    providerId: message.providerId,
    panelId: message.panelId,
    attemptId: message.attemptId
  };
  activeAutomationTransport = transport;
  observedBranchTitle = '';
  automationTaskRunning = true;
  recordAutomationLog('Resuming frame task', {
    taskStatus: 'submitting-prompt',
    branchKind: message.branchKind,
    launchUrl: message.launchUrl,
    currentUrl: normalizeChatUrl(window.location.href)
  });

  try {
    await sendAutomationEvent({
      kind: 'status',
      status: 'opening_branch',
      statusLabel:
        transport === 'background'
          ? `Sending the local branch question in a native ${provider.label} window...`
          : 'Sending the local branch question in this branch window...'
    });

    if (transport === 'background') {
      recordAutomationLog('Allowing the native provider window to settle before submit', {
        delayMs: 1200,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      await sleep(1200);
    }

    const { acceptedSignal } = await submitComposer(
      message.prompt,
      message.branchKind
    );
    const immediateBranchUrl = isPersistentConversationUrl(normalizeChatUrl(window.location.href))
      ? normalizeChatUrl(window.location.href)
      : undefined;

    if (message.branchKind === 'temporary') {
      if (immediateBranchUrl) {
        await reportTemporaryBranchLeak(immediateBranchUrl);
        return;
      }

      recordAutomationLog('Private branch accepted generation signal', {
        acceptedSignal,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      // Go live now and keep watching: ChatGPT rewrites the URL a beat after it starts
      // generating, and holding the panel behind the loading overlay for that whole
      // window would tax every temporary branch that works fine.
      await sendAutomationEvent({ kind: 'live' });
      startTitleWatcher();
      void (async () => {
        const leakedUrl = await watchForPersistentConversationUrl(TEMPORARY_LEAK_WATCH_MS);
        if (leakedUrl) {
          await reportTemporaryBranchLeak(leakedUrl);
        }
      })();

      if (transport === 'background') {
        try {
          await focusComposerForFollowUp();
        } catch (error) {
          recordAutomationLog('Follow-up composer focus did not complete', {
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return;
    }

    await sendAutomationEvent({
      kind: 'status',
      status: 'opening_branch',
      statusLabel: `Waiting for ${provider.label} to create a persistent branch URL...`
    });
    recordAutomationLog('Waiting for persistent branch URL after accepted generation signal', {
      acceptedSignal,
      launchUrl: message.launchUrl,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    const branchChatUrl = await waitForConversationUrlAfterSubmit(
      message.launchUrl ?? normalizeChatUrl(window.location.href)
    );
    await sendAutomationEvent({ kind: 'live', branchChatUrl });
    startTitleWatcher();
    if (transport === 'background') {
      try {
        await focusComposerForFollowUp();
      } catch (error) {
        recordAutomationLog('Follow-up composer focus did not complete', {
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown frame error';
    const currentUrl = normalizeChatUrl(window.location.href);
    const branchChatUrl = isPersistentConversationUrl(currentUrl) ? currentUrl : undefined;
    recordAutomationLog('Frame task failed', {
      reason,
      branchChatUrl: branchChatUrl ?? null
    });

    // Leaving the prompt sitting in the user's real composer is worse than useless: the
    // next thing they type appends to a 3KB machine prompt they never wrote.
    clearComposerAfterFailure(message.prompt);

    await sendAutomationEvent({
      kind: 'failed',
      reason,
      branchChatUrl
    });
  } finally {
    automationTaskRunning = false;
  }
}

function cleanup(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  stopTitleWatcher();

  // Everything Aside put on the page goes, including the iframes inside the host:
  // an in-place extension update runs this and then a new content script, and a
  // surviving host would leave dead panels the new one does not own.
  panelRuntimes.forEach((runtime) => {
    clearPanelWatchdog(runtime);
    runtime.iframeEl.src = 'about:blank';
  });
  panelRuntimes.clear();
  extensionHost?.remove();
  document.getElementById(EXTENSION_HOST_ID)?.remove();
  extensionHost = null;
  delete document.documentElement.dataset.asideTheme;
}

function initEmbeddedFrame(): void {
  ensureFrameAutomationStyles();

  const postReady = () => {
    window.parent.postMessage(
      {
        source: 'aside',
        target: 'parent',
        type: 'SB_FRAME_READY',
        currentUrl: normalizeChatUrl(window.location.href)
      } satisfies FrameReadyMessage,
      window.location.origin
    );
  };

  const frameMessageListener = (event: MessageEvent<FrameStartBranchMessage>) => {
    // Only the embedding page may start a branch here, and only from our own origin.
    if (event.source !== window.parent || event.origin !== window.location.origin) {
      return;
    }

    const data = event.data;
    if (
      !data ||
      typeof data !== 'object' ||
      data.source !== 'aside' ||
      data.target !== 'frame' ||
      data.type !== 'SB_FRAME_START_BRANCH' ||
      !isBranchAttemptRef(data)
    ) {
      return;
    }

    void runBranchPromptAutomation(data, 'frame');
  };

  window.addEventListener('message', frameMessageListener);
  window.addEventListener('pageshow', postReady);
  cleanupFns.push(() => window.removeEventListener('message', frameMessageListener));
  cleanupFns.push(() => window.removeEventListener('pageshow', postReady));

  postReady();
}

/**
 * Bind every provider-specific module to the adapter that owns this document.
 * Returns false when Aside must not run here at all — a marketing page, the auth
 * flow, or settings — so no UI is mounted and no listeners are installed.
 */
function bindProviderForDocument(): boolean {
  const adapter = findChatAdapterForUrl(window.location.href);
  if (!adapter) {
    return false;
  }

  provider = adapter;
  setActiveTranscriptAdapter(adapter.transcript);
  setActiveComposerAdapter(adapter.composer);
  setActiveScopeResolver(() => {
    const url = adapter.normalizeUrl(window.location.href);
    return {
      rootConversationId: adapter.identify(url, sessionDiscriminator).scopeKey,
      rootChatUrl: url
    };
  });

  return true;
}

function init(): void {
  window.__asideCleanup?.();
  window.__asideCleanup = cleanup;

  if (!bindProviderForDocument()) {
    return;
  }

  if (isTopFrame()) {
    initTopFrame();
    return;
  }

  initEmbeddedFrame();
}

init();
