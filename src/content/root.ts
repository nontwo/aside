import {
  ASK_BUTTON_ID,
  WHY_BUTTON_ID,
  NEW_TAB_BUTTON_ID,
  SELECTION_TOOLBAR_ID,
  DEFAULT_BRANCH_TITLE,
  HIGHLIGHT_OVERLAY_ID,
  LEGACY_LAST_BRANCH_KIND_STORAGE_KEY,
  LEGACY_PANEL_STORAGE_PREFIX,
  ROOT_STYLE_ID,
  LAST_BRANCH_KIND_STORAGE_KEY
} from '../shared/constants';
import { mergePanelStateOnConflict, resolveWriteConflict } from '../shared/panel-store';
import {
  getPanelStorageKeyForConversationId,
  isCatchAllPanelStorageKey,
  isPanelStorageKey,
} from '../shared/panel-storage';
import type {
  PanelChangedMessage,
  PanelListResponse,
  PanelListedRecord,
  PanelWriteResponse,
  BranchCreationMode,
  BranchEntryAction,
  BranchKind,
  BranchPanelState,
  BranchPanelStatus,
  CapturedMessage,
  SelectionPayload
} from '../shared/types';
import {
  buildSelectionPayloadFromDraft,
  captureSelectionDraftFromRange,
  locatePassage,
  rangeTouchesAssistantMessage,
  setActiveScopeResolver,
  setActiveTranscriptAdapter
} from '../shared/dom';
import type { SelectionDraft } from '../shared/dom';
import { createContext, sanitizeStoredContext } from '../shared/context';
import type { BranchContext, ContextBlock } from '../shared/context';
import { attachElementToHost, ensureExtensionHostElement } from './ui-host';
import { findFreeCorner, findLeftGutterSlot, findSafePlacement } from '../shared/placement';
import type { Rect } from '../shared/placement';
import { exportSourceMarkdown, fetchBundle, listQuestionsForScope, runCommand } from '../ui/question-client';
import { renderQuestionList } from '../ui/question-list';
import type { ListFilter } from '../ui/question-list';
import { BUILD_ID } from '../shared/build-info';
import type { QuestionBundle, QuestionListEntry } from '../storage/repository';
import type { QuestionChangedMessage } from '../storage/protocol';
import { clipText, compactWhitespace, normalizeChatUrl, randomId, sleep } from '../shared/utils';
import { findChatAdapterForUrl, getAdapter } from '../shared/providers';
import type { ConversationIdentity, ProviderAdapter } from '../shared/providers';
import { HANDOFF_CARD_CSS, HandoffCard, writeClipboardText } from './handoff-card';
import type { HandoffCardDeps } from './handoff-card';
import { WHY_QUESTION, routeFor } from '../handoff/routes';
import type {
  AnchorResult,
  HandoffChangedMessage,
  HandoffDraft,
  HandoffEntry,
  HandoffRequest,
  HandoffResponse,
  HandoffScrollToAnchorMessage,
  ScratchHandoff
} from '../handoff/types';

interface PanelRuntime {
  state: BranchPanelState;
  element: HTMLDivElement;
  titleEl: HTMLElement;
  statusEl: HTMLElement;
  errorEl: HTMLElement;
  focusTextEl: HTMLElement;
  promptShell: HTMLDetailsElement;
  promptPre: HTMLPreElement;
  archiveEl: HTMLDivElement;
  debugLogShell: HTMLDivElement;
  debugLogTextarea: HTMLTextAreaElement;
  copyLogButton: HTMLButtonElement;
  openTabHeaderButton: HTMLButtonElement;
  moreDetails: HTMLDetailsElement;
}

type ThemeMode = 'light' | 'dark';

declare global {
  interface Window {
    __asideCleanup?: () => void;
  }
}

const PANEL_CLASS = 'aside-panel';
const PANEL_TABBAR_ID = 'aside-tabbar';
const ASIDE_LAUNCHER_ID = 'aside-launcher';
const RAIL_WIDTH_PX = 96;
const EXTENSION_HOST_ID = 'aside-root';
const MIN_SELECTION_LENGTH = 4;
const PERSIST_DEBOUNCE_MS = 300;
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

/* ---------------------------------------------------------------- *
 * Canonical question records live in the worker's database. The panel is a
 * view/run projection; these maps hold the revisions this tab last saw.
 * ---------------------------------------------------------------- */
const questionRevs = new Map<string, number>();
const draftRevs = new Map<string, number>();
const linkRevs = new Map<string, number>();

let questionListEl: HTMLDivElement | null = null;
let questionListFilter: ListFilter = 'active';
let questionListEntries: QuestionListEntry[] = [];
let questionListSourceId: string | null = null;
let questionListOpen = false;
let nativeLayoutObserver: MutationObserver | null = null;
let layoutSyncFrame: number | undefined;
let asideLauncher: HTMLButtonElement | null = null;
let themeObserver: MutationObserver | null = null;
let activeTheme: ThemeMode | null = null;
let pendingUrlChangeToken = 0;
let isEvaluatingSelection = false;
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
 * Two builds talking to each other — a content script left over from a previous
 * install, a frame loaded before an update — explain a whole class of "it does
 * nothing" reports. Said once per pair, in the log and on screen.
 */
const staleClientReports = new Set<string>();
let workerBuildId: string | undefined;

function reportStaleClient(runtime: PanelRuntime | null, source: string, otherBuild: string): void {
  const key = `${source}:${otherBuild}`;
  if (staleClientReports.has(key)) {
    return;
  }
  staleClientReports.add(key);
  const entry = `stale-client: ${source} build ${otherBuild} differs from this page's build ${BUILD_ID}`;
  console.warn('[Aside]', entry);
  if (runtime) {
    appendPanelLog(runtime, entry);
  }
  notifyAside('Aside was updated. Reload this page so it runs the current build.');
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

function appendPanelLog(runtime: PanelRuntime, message: string, details?: unknown): void {
  const entry = formatDebugLogEntry(message, details);
  runtime.state.debugLog = [...(runtime.state.debugLog ?? []), entry].slice(-250);
  runtime.state.updatedAt = Date.now();
  console.info('[Aside]', entry);
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
/**
 * The stored form of each legacy record, exactly as read. A saved-record view
 * writes back only its per-tab view state onto this, never the normalized
 * projection it displays — reading a record must not rewrite it.
 */
const legacyRawStates = new Map<string, BranchPanelState>();

function writableStateFor(runtime: PanelRuntime): BranchPanelState {
  const raw = legacyRawStates.get(runtime.state.panelId);
  if (!raw) {
    return runtime.state;
  }
  return {
    ...raw,
    minimized: runtime.state.minimized,
    closedView: runtime.state.closedView,
    updatedAt: runtime.state.updatedAt
  };
}

function adoptAuthoritativeState(panelId: string, state: BranchPanelState, rev: number): void {
  const runtime = panelRuntimes.get(panelId);
  panelRevisions.set(panelId, rev);
  legacyRawStates.set(panelId, state);
  if (!runtime) {
    return;
  }

  // Saved-record views are read-only, so there is no local text to protect: the
  // authoritative record wins, except for this tab's own view state.
  runtime.state = mergePanelStateOnConflict({
    local: runtime.state,
    theirs: state,
    localQuestion: state.initialQuestion ?? '',
    localDrivesBranch: false
  });
  lastWrittenSignatures.set(panelId, panelWriteSignature(runtime.state));
  unsavedPanelIds.delete(panelId);

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
    state: writableStateFor(runtime)
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

    const localQuestion = runtime.state.initialQuestion ?? '';
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
          localDrivesBranch: false
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
        localDrivesBranch: false
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
  }
  if (response.buildId) {
    workerBuildId = response.buildId;
    if (response.buildId !== BUILD_ID) {
      reportStaleClient(null, 'service worker', response.buildId);
    }
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
      padding: 12px 16px 10px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-header-bg, rgba(249, 250, 251, 0.95));
    }

    .aside-panel-heading h2 {
      margin: 0;
      font: 700 16px/1.2 ui-sans-serif, system-ui, sans-serif;
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
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    /* Diagnostics live behind one disclosure so a failed panel is not a wall of buttons. */
    .aside-panel-more {
      position: relative;
    }
    .aside-panel-more summary {
      list-style: none;
      cursor: pointer;
      border-radius: 999px;
      padding: 9px 12px;
      font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-text, #111827);
      user-select: none;
    }
    .aside-panel-more summary::-webkit-details-marker {
      display: none;
    }
    .aside-panel-more-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 2;
      display: grid;
      gap: 6px;
      min-width: 170px;
      padding: 8px;
      border-radius: 12px;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
    }
    .aside-panel-more-menu button {
      width: 100%;
      text-align: left;
    }

    /* Recovery for a private mode that could not be verified: near the question, short. */
    .aside-recovery {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 18px 0;
    }
    .aside-recovery[hidden],
    .aside-recovery-confirm[hidden] {
      display: none !important;
    }
    .aside-recovery p {
      margin: 0;
      font: 500 13px/1.45 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }
    .aside-recovery-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .aside-recovery-confirm {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border-radius: 12px;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }
    .aside-recovery-confirm p {
      color: var(--sb-text, #111827);
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
      /* Structured text: equation source and code keep their line breaks. */
      white-space: pre-wrap;
      word-break: break-word;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 5;
      overflow: hidden;
      cursor: pointer;
    }
    .aside-focus p[data-expanded="true"] {
      display: block;
      -webkit-line-clamp: unset;
      max-height: 40vh;
      overflow: auto;
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

    .aside-notice {
      position: fixed;
      right: 16px;
      bottom: 16px;
      max-width: 360px;
      padding: 10px 12px;
      border-radius: 12px;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
      color: var(--sb-text, #111827);
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
      font-size: 12px;
      z-index: 2147483647;
    }
    .aside-archive {
      margin: 8px 0 4px;
      padding: 8px 10px;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.1));
      border-radius: 12px;
      background: var(--sb-subtle-bg, rgba(15, 23, 42, 0.03));
      font-size: 12px;
      display: grid;
      gap: 6px;
      max-height: 40vh;
      overflow: auto;
    }
    .aside-archive-status {
      color: var(--sb-muted, #6b7280);
    }
    .aside-archive-message {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 6px 8px;
      border-left: 3px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
    }
    .aside-archive-message[data-role="user"] {
      border-left-color: var(--sb-text, #111827);
    }
    .aside-archive-message[data-partial="true"]::after {
      content: ' (partial)';
      color: var(--sb-muted, #6b7280);
    }
    .aside-qlist-panel {
      padding: 12px 14px;
      display: grid;
      gap: 8px;
      font-size: 12px;
    }
    .aside-qlist-header {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      justify-content: space-between;
    }
    .aside-qlist-filters {
      display: inline-flex;
      gap: 4px;
    }
    .aside-qlist-filters button,
    .aside-qlist-actions button,
    .aside-qlist-footer button {
      font: inherit;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.1));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-text, #111827);
      cursor: pointer;
    }
    .aside-qlist-filters button[data-selected="true"] {
      background: var(--sb-text, #111827);
      color: var(--sb-primary-text, #ffffff);
    }
    .aside-qlist-row {
      display: grid;
      gap: 4px;
      padding: 8px 10px;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.1));
      border-radius: 10px;
      background: var(--sb-subtle-bg, rgba(15, 23, 42, 0.03));
    }
    .aside-qlist-open {
      font: inherit;
      font-weight: 600;
      text-align: left;
      background: none;
      border: 0;
      padding: 0;
      color: var(--sb-text, #111827);
      cursor: pointer;
    }
    .aside-qlist-meta {
      color: var(--sb-muted, #6b7280);
    }
    .aside-qlist-actions,
    .aside-qlist-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .aside-qlist-empty {
      color: var(--sb-muted, #6b7280);
      margin: 0;
    }
    .aside-tab-questions button[data-selected="true"] {
      background: var(--sb-text, #111827);
      color: var(--sb-primary-text, #ffffff);
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
  ${HANDOFF_CARD_CSS}
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
    askButton.setAttribute('aria-label', 'Prepare a temporary handoff about the selected passage');

    whyButton = document.createElement('button');
    whyButton.id = WHY_BUTTON_ID;
    whyButton.type = 'button';
    whyButton.textContent = 'Why';
    whyButton.setAttribute('aria-label', 'Prepare a temporary handoff asking why the selected passage holds');

    newTabButton = document.createElement('button');
    newTabButton.id = NEW_TAB_BUTTON_ID;
    newTabButton.type = 'button';
    newTabButton.textContent = 'New-tab';
    newTabButton.setAttribute('aria-label', 'Prepare a temporary handoff that opens in a new tab');

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

/**
 * True while the toolbar is hidden because nothing fitted — not because there is
 * no selection.
 *
 * `hidden` alone cannot tell those apart, and every re-entry path was gated on it,
 * so a collapse was a one-way latch: the obstruction is usually the provider's own
 * selection popup, which disappears on the very next click, and Aside stayed
 * collapsed anyway until the user selected again.
 */
let selectionToolbarCollapsed = false;

function selectionToolbarNeedsSync(): boolean {
  if (!selectionToolbar) {
    return false;
  }
  if (!selectionToolbar.hidden) {
    return true;
  }
  return selectionToolbarCollapsed && Boolean(currentSelectionDraft);
}

function hideSelectionToolbar(): void {
  if (selectionToolbar) {
    selectionToolbar.hidden = true;
  }
  selectionToolbarCollapsed = false;
}

function hideAskButton(clearSelection = true): void {
  if (clearSelection) {
    currentSelectionDraft = null;
    currentSelectionPayload = null;
    currentSelectionRect = null;
    // What was in the way of the last selection says nothing about the next one.
    dodgedProviderNodes = [];
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

function openDraftFromCurrentSelection(entryAction: BranchEntryAction): void {
  const draft = currentSelectionDraft ?? getSelectionDraftFromWindow();
  const payload = currentSelectionPayload ?? materializeSelectionPayload(draft);
  if (!payload) {
    hideAskButton();
    return;
  }
  currentSelectionPayload = payload;

  // Ask, Why and New-tab share one path: a scratch handoff that is temporary-
  // intended and session-only whatever mode an earlier branch used. Nothing is
  // copied, opened or saved until the Owner clicks in the card.
  void openHandoff(entryAction, payload);
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

/**
 * The largest share of the viewport an occluding element may take and still be
 * treated as something to dodge. A full-page overlay or a scroll container is not
 * a popup, and reserving one would collapse Aside on every page.
 */
const MAX_OCCLUDER_VIEWPORT_FRACTION = 0.6;

/**
 * The floating container an occluding node belongs to.
 *
 * A hit test lands on whatever leaf is painted at that point — a label, an icon,
 * a text node's span. Reserving that leaf would leave Aside overlapping the rest
 * of the popup around it.
 */
function nearestPositionedAncestor(element: Element): HTMLElement | null {
  let current: HTMLElement | null =
    element instanceof HTMLElement ? element : element.parentElement;

  while (current && current !== document.body && current !== document.documentElement) {
    const position = window.getComputedStyle(current).position;
    if (position === 'fixed' || position === 'absolute' || position === 'sticky') {
      return current;
    }
    current = current.parentElement;
  }

  return element instanceof HTMLElement ? element : null;
}

/**
 * What is actually painted on top of Aside's own controls.
 *
 * Selectors are a guess about a provider's markup; paint order is a fact about
 * the page. Aside's toolbar overlapped ChatGPT's real selection popup because
 * none of the three selectors written for it matched — and no wider guess would
 * have been safer, because a selector that over-matches reserves a band the size
 * of the reading column and collapses Aside for no reason.
 *
 * So: place first, then ask the page whether anything is covering us, and reserve
 * only what genuinely is. This needs no provider knowledge and survives a
 * redesign.
 */
/**
 * Things a provider renders that a user is meant to be able to click.
 *
 * The harm being detected is "a provider control is unreachable because Aside is
 * on top of it", so a control is exactly the right granularity to reserve: never
 * a wrapper, which could be the size of the reading column.
 */
const CONFLICT_CONTROL_SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="option"], [role="tab"], a[href], input, select, textarea';

/** Points across an element's own rect. A centre-only probe misses a partial cover. */
function gridProbePoints(box: DOMRect, columns = 7, rows = 3): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const x = box.left + (box.width * (column + 0.5)) / columns;
      const y = box.top + (box.height * (row + 0.5)) / rows;
      if (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) {
        points.push([x, y]);
      }
    }
  }
  return points;
}

/**
 * The provider control Aside is sitting on top of at this point, if any.
 *
 * The stack at a point inside Aside reads [aside button, aside toolbar, aside host,
 * ...page..., main, body, html]. Skipping Aside's own entries and looking for a
 * control answers "am I covering something clickable" without knowing anything
 * about the provider's markup. Ordinary page content — the message being read,
 * the scroll container, body — contains no control at that point and yields
 * nothing, so a normal selection produces no conflict at all.
 */
function coveredControlAt(stack: Element[]): HTMLElement | null {
  let index = 0;
  while (index < stack.length && isAsideOwned(stack[index])) {
    index += 1;
  }

  // Nothing of Aside's was on top here, so this point belongs to the
  // over-direction branch instead.
  if (index === 0) {
    return null;
  }

  for (let cursor = index; cursor < stack.length; cursor += 1) {
    const element = stack[cursor];
    if (isAsideOwned(element)) {
      continue;
    }
    if (element === document.body || element === document.documentElement) {
      break;
    }
    const control = element.closest<HTMLElement>(CONFLICT_CONTROL_SELECTOR);
    if (control && !isAsideOwned(control)) {
      return control;
    }
  }

  return null;
}

/**
 * Everything Aside is in visual conflict with, in both directions.
 *
 * The first version of this only looked upwards — "is something painted over
 * me?" — which is the rarer case. `#aside-root` is fixed at z-index 2147483643
 * and creates a stacking context, so against any realistic provider z-index it is
 * Aside that ends up on top. On claude.ai that silenced the probe completely: it
 * found Aside's own button topmost at every point, concluded all was well, and
 * left Aside sitting over Claude's selection popup.
 *
 * Paint order answers both questions from the same hit test.
 */
function findLayoutConflicts(element: HTMLElement): HTMLElement[] {
  if (typeof document.elementsFromPoint !== 'function') {
    return [];
  }

  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) {
    return [];
  }

  const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
  const seen = new Set<Element>();
  const found: HTMLElement[] = [];

  gridProbePoints(box).forEach(([x, y]) => {
    const stack = document.elementsFromPoint(x, y);
    if (!stack.length) {
      return;
    }

    let candidate: HTMLElement | null;
    if (!isAsideOwned(stack[0])) {
      // Something is painted over Aside. Reserve the floating container it
      // belongs to, not the leaf that happened to be hit.
      candidate = nearestPositionedAncestor(stack[0]) ?? (stack[0] as HTMLElement);
      const rect = candidate.getBoundingClientRect();
      // A full-page overlay or a scroll container is not a popup, and dodging one
      // is impossible by definition.
      if (rect.width * rect.height > viewportArea * MAX_OCCLUDER_VIEWPORT_FRACTION) {
        return;
      }
    } else {
      candidate = coveredControlAt(stack);
    }

    if (!candidate || seen.has(candidate) || isAsideOwned(candidate)) {
      return;
    }

    const rect = candidate.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    seen.add(candidate);
    found.push(candidate);
  });

  return found;
}

/**
 * Provider nodes this selection has already been moved out of the way of.
 *
 * Elements, not rectangles, and remembered rather than recomputed per placement.
 * Every re-entry path — scroll, resize, the layout observer — rebuilds `reserved`
 * from `collectReservedRegions()`, which is selector-driven and by definition
 * cannot see these (that is why the probe exists). Without a memory the toolbar is
 * put straight back where it was just moved from, the probe moves it again, and
 * the two take turns forever. Elements also re-measure themselves correctly after
 * a scroll and report their own removal, which a stored rectangle cannot.
 */
let dodgedProviderNodes: HTMLElement[] = [];

const MAX_REMEMBERED_CONFLICTS = 8;

function liveRectsFor(nodes: HTMLElement[]): { rects: Rect[]; live: HTMLElement[] } {
  const rects: Rect[] = [];
  const live: HTMLElement[] = [];

  nodes.forEach((node) => {
    // A popup that closed stops being reserved. `isConnected` plus a non-zero box
    // is the cheap liveness test; this runs on every scroll frame, so it
    // deliberately avoids getComputedStyle.
    if (!node.isConnected) {
      return;
    }
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      return;
    }
    live.push(node);
    rects.push(toRect(box));
  });

  return { rects, live };
}

function liveDodgedRects(): Rect[] {
  const { rects, live } = liveRectsFor(dodgedProviderNodes);
  dodgedProviderNodes = live;
  return rects;
}

function rememberConflicts(into: HTMLElement[], found: HTMLElement[]): HTMLElement[] {
  const merged = [...into];
  found.forEach((node) => {
    if (!merged.includes(node)) {
      merged.push(node);
    }
  });
  return merged.slice(-MAX_REMEMBERED_CONFLICTS);
}

let occlusionRecheckFrame: number | undefined;

/**
 * One re-place, on the frame after painting, if anything covered us.
 *
 * Exactly one: if the provider repositions its own popup in response to ours,
 * a second pass would chase it around the screen.
 */
function scheduleOcclusionRecheck(anchor: DOMRect): void {
  if (occlusionRecheckFrame !== undefined) {
    return;
  }

  occlusionRecheckFrame = window.requestAnimationFrame(() => {
    occlusionRecheckFrame = undefined;
    if (!selectionToolbar || selectionToolbar.hidden) {
      return;
    }

    const found = findLayoutConflicts(selectionToolbar);
    if (!found.length) {
      return;
    }

    dodgedProviderNodes = rememberConflicts(dodgedProviderNodes, found);
    positionSelectionToolbar(anchor, true);
  });
}

function positionSelectionToolbar(rect: DOMRect, isRetry = false): void {
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
    // Remembered conflicts are seeded on EVERY placement, not just the retry:
    // otherwise the next scroll or provider mutation re-derives the position from
    // selectors alone and undoes the dodge.
    reserved: [...collectReservedRegions(), ...liveDodgedRects()],
    // Both providers put their own selection popup above the selection. That is a
    // convention this repo cannot verify, not a fact — so 'above' stays reachable
    // and the detector still runs there; preferring 'below' just means the common
    // case does not need detecting at all.
    order: ['below', 'right', 'left', 'above']
  });

  if (!placement) {
    // No safe spot around the selection. Rather than covering a native control or
    // winning with z-index, collapse to the compact launcher in the left rail.
    toolbar.hidden = true;
    toolbar.style.visibility = '';
    selectionToolbarCollapsed = true;
    setCompactLauncherVisible(true);
    return;
  }

  selectionToolbarCollapsed = false;
  setCompactLauncherVisible(false);
  toolbar.style.top = `${placement.top}px`;
  toolbar.style.left = `${placement.left}px`;
  toolbar.dataset.side = placement.side;
  // Restore visibility BEFORE the hit test: elementsFromPoint skips a
  // visibility:hidden element, so a recheck run inline with the measurement above
  // would always report Aside itself on top and never see the occluder.
  toolbar.style.visibility = '';

  // Only the first pass re-checks; the retry must not schedule another, or a
  // provider that repositions its popup in response would be chased forever.
  if (!isRetry) {
    scheduleOcclusionRecheck(rect);
  }
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
  if (!selectionToolbarNeedsSync() || toolbarSyncFrame !== undefined) {
    return;
  }

  toolbarSyncFrame = window.requestAnimationFrame(() => {
    toolbarSyncFrame = undefined;
    syncSelectionToolbarToViewport();
  });
}

function syncSelectionToolbarToViewport(): void {
  if (!selectionToolbarNeedsSync()) {
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
    if (occlusionRecheckFrame !== undefined) {
      window.cancelAnimationFrame(occlusionRecheckFrame);
      occlusionRecheckFrame = undefined;
    }
    if (railConflictFrame !== undefined) {
      window.cancelAnimationFrame(railConflictFrame);
      railConflictFrame = undefined;
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
      const hiddenCard = [...handoffCards.values()].find((card) => card.hidden && !card.ended);
      if (hiddenCard) {
        showHandoffCard(hiddenCard);
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

  const minimizedCount =
    sortPanels().filter((runtime) => runtime.state.minimized).length +
    [...handoffCards.values()].filter((card) => card.hidden && !card.ended).length;
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
    // Including the selection toolbar's obstruction: the launcher is often shown
    // *because* of it, so it must not be placed on top of it.
    reserved: collectReservedRegions(true),
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
    reserved: collectReservedRegions(true)
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
/**
 * Provider nodes the rail has been moved out of the way of.
 *
 * Kept separately from the selection toolbar's: the rail is persistent UI in the
 * gutter, the toolbar is transient and sits next to the text. What obstructs one
 * says nothing about the other.
 */
let dodgedRailNodes: HTMLElement[] = [];

let railConflictFrame: number | undefined;

/**
 * Is this point in the gutter genuinely empty?
 *
 * Stricter than the selection toolbar's test, and deliberately so. The toolbar is
 * meant to sit beside the text, so only a covered *control* is a problem. The rail
 * is meant to sit in whitespace outside the reading column, so anything the
 * provider rendered there — a conversation title, a label, a heading, not just a
 * control — means this is not whitespace.
 *
 * Free means: nothing but the document, or a layout wrapper the conversation
 * itself lives inside. A sibling subtree is provider chrome.
 */
function railPointIsFree(element: Element, conversationContainer: HTMLElement | null): boolean {
  if (element === document.body || element === document.documentElement) {
    return true;
  }
  if (!conversationContainer) {
    // With no conversation container to reason about, fall back to the weaker
    // test rather than refusing every slot.
    return !element.closest(CONFLICT_CONTROL_SELECTOR);
  }
  return element === conversationContainer || element.contains(conversationContainer);
}

function findRailConflicts(rail: HTMLElement): HTMLElement[] {
  if (typeof document.elementsFromPoint !== 'function') {
    return [];
  }

  const box = rail.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) {
    return [];
  }

  const conversationContainer = provider.layout.getConversationScrollContainer(document);
  const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
  const seen = new Set<Element>();
  const found: HTMLElement[] = [];

  gridProbePoints(box, 2, 5).forEach(([x, y]) => {
    const stack = document.elementsFromPoint(x, y);
    const beneath = stack.find((element) => !isAsideOwned(element));
    if (!beneath || railPointIsFree(beneath, conversationContainer)) {
      return;
    }

    const candidate = nearestPositionedAncestor(beneath) ?? (beneath as HTMLElement);
    if (seen.has(candidate) || isAsideOwned(candidate)) {
      return;
    }

    const rect = candidate.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    if (rect.width * rect.height > viewportArea * MAX_OCCLUDER_VIEWPORT_FRACTION) {
      return;
    }

    seen.add(candidate);
    found.push(candidate);
  });

  return found;
}

function scheduleRailConflictRecheck(): void {
  if (railConflictFrame !== undefined) {
    return;
  }

  railConflictFrame = window.requestAnimationFrame(() => {
    railConflictFrame = undefined;
    if (!tabBar || tabBar.hidden) {
      return;
    }

    const found = findRailConflicts(tabBar);
    if (!found.length) {
      return;
    }

    dodgedRailNodes = rememberConflicts(dodgedRailNodes, found);
    positionTabBar(true);
  });
}

function positionTabBar(isRetry = false): void {
  if (!tabBar || tabBar.hidden) {
    return;
  }

  const minimizedCount =
    sortPanels().filter((runtime) => runtime.state.minimized).length +
    [...handoffCards.values()].filter((card) => card.hidden && !card.ended).length;
  const { rects: railDodged, live } = liveRectsFor(dodgedRailNodes);
  dodgedRailNodes = live;

  const slot = findLeftGutterSlot({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    readingColumn: readingColumnRect(),
    // Claude's left chrome matches none of the adapter's sidebar selectors on the
    // live site, so without the measured conflicts the gutter calculation treats
    // the whole left side as free whitespace and drops the rail onto it.
    reserved: [...collectReservedRegions(false), ...railDodged],
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

  if (!isRetry) {
    scheduleRailConflictRecheck();
  }
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

/**
 * The legacy branch context shape, kept so a record opened from the question
 * database still has the fields older code paths read.
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

/**
 * A saved record from an earlier version of Aside, shown read-only.
 *
 * Nothing here sends, loads a provider frame or opens a window on its own. The
 * two ways forward are explicit: open the saved provider conversation as plain
 * navigation, or ask about the same passage as a new temporary handoff — which
 * leaves this record untouched.
 */
function createPanelRuntime(state: BranchPanelState): PanelRuntime {
  const element = document.createElement('div');
  element.className = `${PANEL_CLASS} aside-legacy-panel`;
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
  openTabHeaderButton.textContent = 'Open conversation';
  openTabHeaderButton.dataset.asideRole = 'legacy-open-conversation';
  openTabHeaderButton.title = `Open the saved ${provider.label} conversation in a new tab. Nothing is sent.`;
  const moreDetails = document.createElement('details');
  moreDetails.className = 'aside-panel-more';
  const moreSummary = document.createElement('summary');
  moreSummary.textContent = 'More';
  const moreMenu = document.createElement('div');
  moreMenu.className = 'aside-panel-more-menu';
  const copyLogButton = document.createElement('button');
  copyLogButton.type = 'button';
  copyLogButton.textContent = 'Copy log';
  copyLogButton.title =
    'Copy a redacted diagnostic report: URLs, status and steps, without your selected text or prompt.';
  const copyLogWithContentButton = document.createElement('button');
  copyLogWithContentButton.type = 'button';
  copyLogWithContentButton.textContent = 'Copy log + text';
  copyLogWithContentButton.title = 'Copy the diagnostic report including your selected text and the prompt.';
  const selectLogMenuButton = document.createElement('button');
  selectLogMenuButton.type = 'button';
  selectLogMenuButton.textContent = 'Select log';
  moreMenu.append(copyLogButton, copyLogWithContentButton, selectLogMenuButton);
  moreDetails.append(moreSummary, moreMenu);
  const minimizeButton = document.createElement('button');
  minimizeButton.type = 'button';
  minimizeButton.textContent = 'Minimize';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  actions.append(jumpButton, openTabHeaderButton, minimizeButton, moreDetails, closeButton);
  header.append(headingWrap, actions);

  const body = document.createElement('div');
  body.className = 'aside-panel-body';

  const legacyNote = document.createElement('p');
  legacyNote.className = 'aside-legacy-note';
  legacyNote.textContent = 'Saved record from an earlier version of Aside. Read-only: nothing here is sent automatically.';

  const focus = document.createElement('div');
  focus.className = 'aside-focus';
  const focusLabel = document.createElement('small');
  focusLabel.textContent = 'Selected passage';
  const focusTextEl = document.createElement('p');
  focusTextEl.title = 'Click to expand or collapse the selected passage';
  focusTextEl.addEventListener('click', () => {
    focusTextEl.dataset.expanded = focusTextEl.dataset.expanded === 'true' ? 'false' : 'true';
  });
  focus.append(focusLabel, focusTextEl);

  const promptShell = document.createElement('details');
  promptShell.className = 'aside-context';
  const promptSummary = document.createElement('summary');
  promptSummary.textContent = 'Prompt that was prepared for this branch';
  const promptPre = document.createElement('pre');
  promptPre.className = 'aside-context-preview';
  promptShell.append(promptSummary, promptPre);

  // Saved thread: what was read back from the branch conversation. Read-only
  // evidence; opening it never opens a provider tab or sends anything.
  const archiveEl = document.createElement('div');
  archiveEl.className = 'aside-archive';
  archiveEl.hidden = true;

  const legacyActions = document.createElement('div');
  legacyActions.className = 'aside-launcher-actions aside-legacy-actions';
  const askAgainButton = document.createElement('button');
  askAgainButton.type = 'button';
  askAgainButton.className = 'aside-panel-primary';
  askAgainButton.textContent = 'Ask about this passage (temporary handoff)';
  askAgainButton.dataset.asideRole = 'legacy-ask-handoff';
  legacyActions.append(askAgainButton);

  const debugLogShell = document.createElement('div');
  debugLogShell.className = 'aside-debug-log';
  debugLogShell.hidden = true;
  const debugLogTitle = document.createElement('strong');
  debugLogTitle.textContent = 'Copyable debug log';
  const debugLogHelp = document.createElement('p');
  debugLogHelp.textContent = 'Select this log and paste it where you need it.';
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

  body.append(legacyNote, focus, promptShell, archiveEl, legacyActions, debugLogShell);
  element.append(header, body);
  mountInExtensionHost(element);

  const runtime: PanelRuntime = {
    state,
    element,
    titleEl,
    statusEl,
    errorEl,
    focusTextEl,
    promptShell,
    promptPre,
    archiveEl,
    debugLogShell,
    debugLogTextarea,
    copyLogButton,
    openTabHeaderButton,
    moreDetails
  };

  jumpButton.addEventListener('click', () => {
    scrollToOrigin(runtime.state.selection);
  });
  openTabHeaderButton.addEventListener('click', () => {
    void openSavedConversation(runtime.state.panelId);
  });
  copyLogButton.addEventListener('click', () => {
    moreDetails.open = false;
    void copyBranchDebugLog(runtime.state.panelId, false);
  });
  copyLogWithContentButton.addEventListener('click', () => {
    moreDetails.open = false;
    void copyBranchDebugLog(runtime.state.panelId, true);
  });
  selectLogMenuButton.addEventListener('click', () => {
    moreDetails.open = false;
    showCopyableDebugLog(runtime, buildBranchDebugLogText(runtime, false));
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
  askAgainButton.addEventListener('click', () => {
    // A new scratch session from the saved passage; the record is not changed.
    minimizePanel(runtime.state.panelId);
    void openHandoff('ask', runtime.state.selection, runtime.state.initialQuestion ?? '');
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

function captureLabelForState(state: BranchPanelState): string {
  const archive = state.archive;
  if (!archive || !archive.messages.length) {
    return state.branchChatUrl ? 'Link only — nothing captured yet.' : '';
  }
  const complete = archive.messages.filter((message) => !message.partial);
  const last = complete.at(-1);
  if (archive.capture === 'captured-through' && last) {
    return `Captured through message ${last.ordinal + 1} of ${archive.messages.length}. Later changes at the provider are not guaranteed.`;
  }
  return `Partially captured: ${complete.length} complete of ${archive.messages.length} read.`;
}

/** The saved thread, read-only. */
function renderArchiveSection(runtime: PanelRuntime): void {
  const { state } = runtime;
  const archive = state.archive;
  const show = Boolean(archive && archive.messages.length) || Boolean(state.archiveOnly);
  runtime.archiveEl.hidden = !show;
  if (!show) {
    return;
  }
  runtime.archiveEl.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = state.archiveOnly ? 'Saved thread' : 'Saved so far';
  runtime.archiveEl.append(heading);
  const status = document.createElement('small');
  status.className = 'aside-archive-status';
  status.textContent = captureLabelForState(state);
  runtime.archiveEl.append(status);
  (archive?.messages ?? []).forEach((message) => {
    const node = document.createElement('div');
    node.className = 'aside-archive-message';
    node.dataset.role = message.role;
    node.dataset.partial = String(message.partial);
    node.textContent = message.text;
    runtime.archiveEl.append(node);
  });
  if (state.archiveOnly && !(archive?.messages.length)) {
    const empty = document.createElement('p');
    empty.textContent = state.branchChatUrl
      ? 'No messages were captured for this question; only the provider conversation link was kept.'
      : 'This question was never sent.';
    runtime.archiveEl.append(empty);
  }
}

/** One status line for a saved record, by what it is — never a live state. */
function legacyStatusLine(state: BranchPanelState): string {
  if (state.status === 'live' || state.branchChatUrl) {
    return state.branchChatUrl
      ? `Saved branch. Open its ${provider.label} conversation, or read what was saved below.`
      : 'Saved branch.';
  }
  if (state.status === 'draft') {
    return 'Unsent draft. Ask about it as a temporary handoff, or close it.';
  }
  return 'This branch was not completed.';
}

function syncPanelUI(runtime: PanelRuntime): void {
  const { state } = runtime;
  runtime.element.hidden = state.minimized;
  runtime.titleEl.textContent = getDisplayTitle(state);
  const unsaved = unsavedPanelIds.has(state.panelId);
  runtime.statusEl.textContent = unsaved
    ? `${legacyStatusLine(state)} (not saved — this view is only in this tab)`
    : legacyStatusLine(state);
  runtime.element.dataset.unsaved = String(unsaved);
  runtime.errorEl.textContent = state.status === 'failed' ? state.errorMessage ?? '' : '';
  runtime.errorEl.style.display = runtime.errorEl.textContent ? 'block' : 'none';
  runtime.focusTextEl.textContent = state.focusPreview;
  runtime.promptPre.textContent = state.initialPrompt ?? '';
  runtime.promptShell.hidden = !state.initialPrompt;
  renderArchiveSection(runtime);
  runtime.openTabHeaderButton.style.display = state.branchChatUrl ? 'inline-flex' : 'none';
}

function renderTabs(): void {
  const container = ensureTabBar();
  container.innerHTML = '';

  const minimized = sortPanels().filter((runtime) => runtime.state.minimized && !runtime.state.closedView);
  const questionCount = questionListCount();
  const hiddenHandoffs = [...handoffCards.values()].filter((card) => card.hidden && !card.ended);
  container.hidden = minimized.length === 0 && questionCount === 0 && hiddenHandoffs.length === 0;

  if (questionCount > 0 || questionListEntries.length > 0) {
    const listTab = document.createElement('div');
    listTab.className = 'aside-tab aside-tab-questions';
    const listButton = document.createElement('button');
    listButton.type = 'button';
    listButton.textContent = `Questions (${questionCount})`;
    listButton.title = 'Questions asked from this page';
    listButton.dataset.selected = String(questionListOpen);
    listButton.addEventListener('click', () => toggleQuestionList());
    listTab.append(listButton);
    container.append(listTab);
  }

  // Scratch handoffs: session-only entries, never written to the panel store.
  hiddenHandoffs.forEach((card) => {
    const tab = document.createElement('div');
    tab.className = 'aside-tab aside-tab-handoff';
    tab.dataset.sessionId = card.sessionId;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = card.railLabel();
    openButton.title = 'Temporary handoff (not saved in Aside)';
    const badge = document.createElement('small');
    badge.textContent = 'temporary';
    openButton.addEventListener('click', () => showHandoffCard(card));
    tab.append(openButton, badge);
    container.append(tab);
  });

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

/**
 * The panel slot sits at the right of the viewport. Where the provider's
 * composer (or a tool pane) is below it on the same side, the slot stops short
 * of it instead of painting over a native control; the card's body scrolls.
 */
function fitSlotToFreeSpace(element: HTMLElement): void {
  if (element.hidden) {
    return;
  }
  element.style.maxHeight = '';
  const card = element.getBoundingClientRect();
  if (card.width <= 0 || card.height <= 0) {
    return;
  }
  const blocking = provider.layout.reservedRegionSelectors
    .filter((entry) => entry.kind === 'composer' || entry.kind === 'tool-panel')
    .flatMap((entry) => {
      try {
        return Array.from(document.querySelectorAll<HTMLElement>(entry.selector));
      } catch {
        return [];
      }
    })
    .filter((node) => !isAsideOwned(node))
    .map((node) => node.getBoundingClientRect())
    .filter(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < card.right &&
        rect.right > card.left &&
        rect.top > card.top + 120 &&
        rect.top < card.bottom
    );
  if (!blocking.length) {
    return;
  }
  const limit = Math.floor(Math.min(...blocking.map((rect) => rect.top)) - card.top - 12);
  if (limit < 160) {
    // No room above the composer for a usable card: step aside to the rail
    // rather than paint over the provider's control.
    const handoffCard = [...handoffCards.values()].find((candidate) => candidate.element === element);
    if (handoffCard) {
      handoffCard.yieldSlot();
      notifyAside('Not enough room to show the Aside card without covering the page. Make the window taller, then open it from the rail.');
    } else {
      element.style.maxHeight = `${Math.max(120, limit)}px`;
    }
    return;
  }
  element.style.maxHeight = `${limit}px`;
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
    fitSlotToFreeSpace(runtime.element);
  });
  handoffCards.forEach((card) => {
    if (!card.ended) {
      mountInExtensionHost(card.element);
      fitSlotToFreeSpace(card.element);
    }
  });

  renderTabs();

  if (highlightOverlay?.childElementCount) {
    mountInExtensionHost(highlightOverlay);
  }
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
  legacyRawStates.set(raw.panelId, raw);

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
    questionId: typeof raw.questionId === 'string' ? raw.questionId : undefined,
    linkId: typeof raw.linkId === 'string' ? raw.linkId : undefined,
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId : undefined,
    preferredSurface: raw.preferredSurface === 'native_window' ? 'native_window' : undefined,
    excludedPlanIds: Array.isArray(raw.excludedPlanIds) ? raw.excludedPlanIds.filter((id) => typeof id === 'string') : undefined,
    closedView: raw.closedView === true,
    archiveOnly: raw.archiveOnly === true,
    archive: sanitizeArchive(raw.archive),
    focusPreview:
      raw.focusPreview || clipText(raw.selection.structuredSelectedText || raw.selection.selectedText, 400),
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
    // A closed view stays closed until the Owner reopens the question from the list.
    .filter((record) => !record.state?.closedView)
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
  void refreshQuestionList();
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
  yieldHandoffCards();
  syncPanelUI(runtime);
  renderTabs();
  persistPanels(panelId);
  scrollToOrigin(runtime.state.selection);
}

/**
 * Close hides the view. It deletes nothing and cancels nothing: the question
 * record, its saved thread and any run in flight are untouched, and the question
 * is still listed for this page. Deletion is a separate, explicit action.
 */
function closePanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  runtime.state.closedView = true;
  runtime.state.minimized = true;
  runtime.state.updatedAt = Date.now();
  runtime.element.remove();
  panelRuntimes.delete(panelId);
  renderTabs();
  void refreshQuestionList();

  // The view record is kept, marked closed, so a reload does not reopen it and
  // a private (session-only) question is not lost merely by closing its view.
  void writePanelRecord(runtime);
}

// Navigating away is not the same as closing: these panels stay in storage so the user
// can come back to the conversation and find them again.
function clearPanelsForCurrentConversation(): void {
  panelRuntimes.forEach((runtime) => {
    runtime.element.remove();
  });
  panelRuntimes.clear();
  renderTabs();
}

/**
 * Open a saved record's provider conversation as plain navigation in a new tab.
 * It carries no prompt and starts nothing; the worker only accepts provider URLs.
 */
async function openSavedConversation(panelId: string): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  const url = runtime?.state.branchChatUrl;
  if (!runtime || !url) {
    return;
  }
  appendPanelLog(runtime, 'Open saved conversation requested');
  const response = await sendStoreMessage<{ ok: boolean; reason?: string }>({ type: 'OPEN_PROVIDER_URL', url });
  if (!response?.ok) {
    notifyAside(`The saved ${provider.label} conversation could not be opened.`);
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
    `build: ${BUILD_ID}`,
    `workerBuild: ${workerBuildId ?? '(not reported)'}`,
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

function installRuntimeMessageListener(): void {
  if (!hasRuntimeAccess()) {
    return;
  }

  const runtimeMessageListener = (
    message: PanelChangedMessage | QuestionChangedMessage | HandoffChangedMessage | HandoffScrollToAnchorMessage | { type?: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    // Only this extension's worker talks to the page; never another tab.
    if (!isTopFrame() || sender.id !== chrome.runtime.id || sender.tab) {
      return false;
    }
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    switch (message.type) {
      case 'PANEL_CHANGED':
        handlePanelChanged(message as PanelChangedMessage);
        sendResponse({ ok: true });
        return false;
      case 'QUESTION_CHANGED':
        void refreshQuestionList();
        sendResponse({ ok: true });
        return false;
      case 'HANDOFF_CHANGED':
        handleHandoffChanged(message as HandoffChangedMessage);
        sendResponse({ ok: true });
        return false;
      case 'HANDOFF_SCROLL_TO_ANCHOR': {
        const card = handoffCards.get((message as HandoffScrollToAnchorMessage).sessionId);
        sendResponse({ anchor: card ? jumpToHandoffPassage(card.session) : 'not-found' });
        return false;
      }
      case 'RUN_BRANCH_PROMPT_IN_TAB':
        // A worker from an older build asking for the retired automatic run.
        sendResponse({ ok: false, code: 'retired', buildId: BUILD_ID });
        return false;
      default:
        return false;
    }
  };

  chrome.runtime.onMessage.addListener(runtimeMessageListener);
  cleanupFns.push(() => {
    chrome.runtime.onMessage.removeListener(runtimeMessageListener);
  });
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

/**
 * Bring a saved passage back into view, validated rather than guessed: an exact
 * match of the passage with its recorded context, or its message when only the
 * message is identifiable. A duplicate phrase elsewhere is never used to claim
 * success.
 */
function scrollToOrigin(selection: SelectionPayload): AnchorResult {
  const found = locatePassage(selection);
  if (found.status === 'exact') {
    const firstRect = getFirstRangeRect(found.range);
    if (firstRect) {
      scrollRectIntoView(firstRect, found.element);
      afterScrollSettles(() => {
        renderHighlightRects(
          Array.from(found.range.getClientRects()).map((rect) => rect as DOMRect),
          found.element.getBoundingClientRect()
        );
      });
      return 'exact';
    }
    found.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return 'exact';
  }
  if (found.status === 'message-only') {
    found.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    afterScrollSettles(() => {
      renderHighlightRects([found.element.getBoundingClientRect()]);
    });
    return 'message-only';
  }
  return found.status;
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
  syncHandoffCardsToScope();
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
  installRuntimeMessageListener();
  syncMountedUi();
  void (async () => {
    await migrateLegacyPanelStorage();
    await restorePanels();
    await restoreHandoffs();
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
  // Leaving the page (for the native chat, the toolbar popup, another tab) is
  // when a debounced draft must reach the worker, so every view agrees.
  const focusListener = () => {
    flushHandoffDrafts();
  };
  const visibilityListener = () => {
    if (document.visibilityState === 'visible') {
      return;
    }
    flushHandoffDrafts();
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
  window.addEventListener('blur', focusListener);
  document.addEventListener('visibilitychange', visibilityListener);
  window.addEventListener('pagehide', pagehideListener);
  document.addEventListener('keydown', keydownListener);
  installUrlObservers();

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
  cleanupFns.push(() => window.removeEventListener('blur', focusListener));
  cleanupFns.push(() => document.removeEventListener('visibilitychange', visibilityListener));
  cleanupFns.push(() => window.removeEventListener('pagehide', pagehideListener));
  cleanupFns.push(() => document.removeEventListener('keydown', keydownListener));

  // The page role is confirmed asynchronously, so a selection can already exist
  // by the time the listeners are in place: evaluate it once instead of waiting
  // for the next selection change.
  if (!(window.getSelection()?.isCollapsed ?? true)) {
    selectionListener();
  }
}




/**
 * A non-blocking notice in Aside's own host. Never window.alert on a provider
 * page: a modal dialog freezes the provider's UI and the Owner's other work.
 */
let noticeTimer: number | undefined;
function notifyAside(message: string): void {
  console.warn(`[Aside] ${message}`);
  const host = ensureExtensionHost();
  let notice = host.querySelector<HTMLDivElement>('.aside-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'aside-notice';
    notice.setAttribute('role', 'status');
    host.append(notice);
  }
  notice.textContent = message;
  notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    if (notice) {
      notice.hidden = true;
    }
  }, 6_000);
}

/* ================================================================== *
 * Question records: the panel as a view of the canonical database.
 * ================================================================== */

function sanitizeArchive(raw: unknown): BranchPanelState['archive'] {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const candidate = raw as { messages?: unknown; capture?: unknown };
  if (!Array.isArray(candidate.messages)) {
    return undefined;
  }
  const messages: CapturedMessage[] = candidate.messages
    .filter((message): message is CapturedMessage => {
      const entry = message as Partial<CapturedMessage> | null;
      return (
        Boolean(entry) &&
        (entry!.role === 'user' || entry!.role === 'assistant') &&
        typeof entry!.text === 'string' &&
        typeof entry!.ordinal === 'number'
      );
    })
    .map((message) => ({
      role: message.role,
      text: message.text,
      partial: message.partial === true,
      providerMessageId: typeof message.providerMessageId === 'string' ? message.providerMessageId : null,
      ordinal: message.ordinal
    }));
  const capture =
    candidate.capture === 'captured-through' || candidate.capture === 'partial' ? candidate.capture : 'link-only';
  return { messages, capture };
}

/* ---------------- capture watcher (runs in the branch page) ---------------- */

/* ---------------- source-scoped question list ---------------- */

function ensureQuestionList(): HTMLDivElement {
  if (!questionListEl) {
    questionListEl = document.createElement('div');
    questionListEl.id = 'aside-qlist';
    questionListEl.className = 'aside-panel aside-qlist-panel';
    questionListEl.hidden = true;
  }
  return mountInExtensionHost(questionListEl);
}

function questionListCount(): number {
  return questionListEntries.filter((entry) => entry.question.lifecycle === 'active').length;
}

async function refreshQuestionList(): Promise<void> {
  if (!hasRuntimeAccess()) {
    return;
  }
  const scopeKey = currentIdentity(lastKnownUrl).scopeKey;
  const result = await listQuestionsForScope(scopeKey);
  questionListEntries = result?.questions ?? [];
  questionListSourceId = result?.sourceId ?? null;
  renderQuestionListPanel();
  renderTabs();
}

function renderQuestionListPanel(): void {
  const container = ensureQuestionList();
  container.hidden = !questionListOpen;
  if (!questionListOpen) {
    return;
  }
  renderQuestionList(
    container,
    questionListEntries,
    questionListSourceId,
    questionListFilter,
    {
      open: (questionId) => {
        void openQuestionFromRecord(questionId);
      },
      resolve: (entry) => void applyLifecycle(entry, 'ResolveQuestion'),
      reopen: (entry) => void applyLifecycle(entry, 'ReopenQuestion'),
      archive: (entry) => void applyLifecycle(entry, 'ArchiveQuestion'),
      rename: (entry, title) => {
        void runCommand({ type: 'RenameQuestion', questionId: entry.question.id, baseRev: entry.question.rev, title }).then(
          () => {
            const runtime = [...panelRuntimes.values()].find((candidate) => candidate.state.questionId === entry.question.id);
            if (runtime) {
              runtime.state.title = title;
              runtime.state.titleStatus = 'ready';
              syncPanelUI(runtime);
              persistPanels(runtime.state.panelId);
            }
            return refreshQuestionList();
          }
        );
      },
      remove: (entry) => void deleteQuestionEverywhere(entry.question.id),
      exportSource: (sourceId) => void exportSourceAsMarkdown(sourceId),
      openLibrary: () => {
        void sendStoreMessage({ type: 'OPEN_LIBRARY' });
      }
    },
    (filter) => {
      questionListFilter = filter;
      renderQuestionListPanel();
    }
  );
}

function toggleQuestionList(): void {
  questionListOpen = !questionListOpen;
  if (questionListOpen) {
    yieldHandoffCards();
  }
  renderQuestionListPanel();
  if (questionListOpen) {
    void refreshQuestionList();
  }
}

async function applyLifecycle(entry: QuestionListEntry, type: 'ResolveQuestion' | 'ReopenQuestion' | 'ArchiveQuestion'): Promise<void> {
  await runCommand({ type, questionId: entry.question.id, baseRev: entry.question.rev });
  await refreshQuestionList();
}

/** Explicit deletion: the record, its owned rows, and any panel view of it. */
async function deleteQuestionEverywhere(questionId: string): Promise<void> {
  const outcome = await runCommand({ type: 'DeleteQuestion', questionId, descendants: 'reparent' });
  if (!outcome || outcome.status === 'error') {
    notifyAside('Aside could not record the deletion; nothing was removed.');
    return;
  }
  const runtime = [...panelRuntimes.values()].find((candidate) => candidate.state.questionId === questionId);
  if (runtime) {
    closedPanelIds.add(runtime.state.panelId);
    runtime.element.remove();
    panelRuntimes.delete(runtime.state.panelId);
    void deletePanelRecord(runtime.state.panelId);
  }
  // A closed view of this question may still be stored; remove it too.
  const records = await listPanelRecords();
  for (const record of records) {
    if (record.state?.questionId === questionId && !panelRuntimes.has(record.panelId)) {
      panelRevisions.set(record.panelId, record.rev);
      void deletePanelRecord(record.panelId);
    }
  }
  questionRevs.delete(questionId);
  draftRevs.delete(questionId);
  renderTabs();
  await refreshQuestionList();
}

async function exportSourceAsMarkdown(sourceId: string): Promise<void> {
  const result = await exportSourceMarkdown(sourceId);
  if (!result) {
    notifyAside('Export failed: the question database was unreachable.');
    return;
  }
  try {
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    anchor.style.display = 'none';
    mountInExtensionHost(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch {
    try {
      await navigator.clipboard.writeText(result.markdown);
      notifyAside('Download was blocked here; the Markdown was copied to your clipboard instead.');
    } catch {
      notifyAside('Export could not be downloaded or copied on this page. Use the library page instead.');
    }
  }
}

/** Reopen a question: an existing view if there is one, else a view of the record. */
async function openQuestionFromRecord(questionId: string): Promise<void> {
  const mounted = [...panelRuntimes.values()].find((runtime) => runtime.state.questionId === questionId);
  if (mounted) {
    expandPanel(mounted.state.panelId);
    return;
  }

  const records = await listPanelRecords();
  const record = records.find((entry) => entry.state?.questionId === questionId);
  if (record) {
    const restored = createStateFromRestore(record.state);
    if (restored) {
      restored.closedView = false;
      restored.minimized = false;
      // A stored live frame is not reloaded on reopen; the saved thread is shown
      // and continuing is an explicit action.
      if (restored.status === 'live' || restored.status === 'failed') {
        restored.archiveOnly = true;
      }
      closedPanelIds.delete(record.panelId);
      panelRevisions.set(record.panelId, record.rev);
      minimizeOtherPanels(restored.panelId);
      const runtime = createPanelRuntime(restored);
      syncMountedUi();
      persistPanels(runtime.state.panelId);
      scrollToOrigin(runtime.state.selection);
      return;
    }
  }

  const bundle = await fetchBundle(questionId);
  if (!bundle) {
    notifyAside('This question no longer exists.');
    await refreshQuestionList();
    return;
  }
  const state = createStateFromBundle(bundle);
  if (!state) {
    notifyAside('This question cannot be shown here: its saved selection is incomplete.');
    return;
  }
  minimizeOtherPanels(state.panelId);
  createPanelRuntime(state);
  questionRevs.set(questionId, bundle.question.rev);
  draftRevs.set(questionId, bundle.draft?.rev ?? 1);
  const link = bundle.links.at(-1);
  if (link) {
    linkRevs.set(link.id, link.rev);
  }
  syncMountedUi();
  persistPanels(state.panelId);
  scrollToOrigin(state.selection);
}

/** A panel view built from the canonical record alone. */
function createStateFromBundle(bundle: QuestionBundle): BranchPanelState | null {
  const { question, anchor, source } = bundle;
  if (!anchor || !source) {
    return null;
  }
  const link = bundle.links.at(-1);
  const snapshot = bundle.snapshots.at(-1);
  const rootChatUrl = normalizeChatUrl(source.url);
  const selection: SelectionPayload = {
    rootConversationId: source.scopeKey,
    rootChatUrl,
    selectedText: anchor.exact,
    structuredSelectedText: anchor.selectedText,
    selectedBlocks: [
      {
        messageId: anchor.messageId,
        role: anchor.role,
        turnIndex: anchor.turnIndex,
        text: anchor.exact,
        structuredText: anchor.selectedText,
        excerpt: anchor.selectedText.slice(0, 160)
      }
    ],
    branchBaseMessageId: anchor.messageId,
    rangeQuotes: { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix },
    fallbackScrollY: anchor.scrollHint
  };
  const sent = Boolean(snapshot);
  return {
    panelId: randomId('panel'),
    rootConversationId: source.scopeKey,
    rootChatUrl,
    rootProjectUrl: getNonRootContainerUrl(rootChatUrl),
    selection,
    context: createContextForSelection(selection),
    questionId: question.id,
    linkId: link?.id,
    snapshotId: snapshot?.id,
    excludedPlanIds: bundle.draft?.excludedBlockIds,
    focusPreview: clipText(anchor.selectedText, 280),
    branchKind: 'persistent',
    entryAction: question.entryAction,
    surfaceMode: 'embedded',
    launchUrl: undefined,
    branchChatUrl: link?.conversationUrl ?? undefined,
    creationMode: sent ? 'local_persistent' : 'pending',
    title: question.title,
    titleStatus: 'ready',
    minimized: false,
    status: sent ? (link?.run === 'failed' ? 'failed' : 'live') : 'draft',
    statusLabel: sent
      ? link?.conversationUrl
        ? 'Saved thread. Continue at the provider when you need more.'
        : 'Saved thread.'
      : 'Ask a focused follow-up about this selected passage.',
    errorMessage: link?.run === 'failed' ? 'The last attempt failed. You can try again.' : undefined,
    archiveOnly: sent,
    archive: {
      messages: bundle.messages.map((message) => ({
        role: message.role,
        text: message.text,
        partial: message.partial,
        providerMessageId: message.providerMessageId,
        ordinal: message.ordinal
      })),
      capture: link?.capture ?? 'link-only'
    },
    initialQuestion: bundle.draft?.text ?? snapshot?.question,
    initialPrompt: snapshot?.prompt,
    debugLog: [formatDebugLogEntry('Panel view opened from the question record', { questionId: question.id })],
    createdAt: question.createdAt,
    updatedAt: Date.now()
  };
}

/* ================================================================== *
 * Scratch handoffs: the card in the source page, one per session.
 * ================================================================== */

const handoffCards = new Map<string, HandoffCard>();

async function sendHandoff(message: HandoffRequest): Promise<HandoffResponse | null> {
  if (!hasRuntimeAccess()) {
    return null;
  }
  try {
    return (await chrome.runtime.sendMessage(message)) as HandoffResponse;
  } catch (error) {
    if (!isInvalidatedError(error)) {
      console.warn('[Aside] Handoff message failed');
    }
    return null;
  }
}

function currentScopeKey(): string {
  return currentIdentity(lastKnownUrl).scopeKey;
}

function jumpToHandoffPassage(session: ScratchHandoff): AnchorResult {
  if (currentScopeKey() !== session.source.scopeKey) {
    return 'different-conversation';
  }
  return scrollToOrigin(session.selection);
}

function handoffDeps(): HandoffCardDeps {
  return {
    buildId: BUILD_ID,
    mount: (element) => {
      mountInExtensionHost(element);
    },
    notify: notifyAside,
    send: sendHandoff,
    writeClipboard: (text) => writeClipboardText(text, ensureExtensionHost()),
    jumpToPassage: jumpToHandoffPassage,
    openLibrary: () => {
      void sendStoreMessage({ type: 'OPEN_LIBRARY' });
    },
    onVisibilityChange: () => {
      renderTabs();
    },
    onDisposed: (card) => {
      if (handoffCards.get(card.sessionId) === card) {
        handoffCards.delete(card.sessionId);
      }
      renderTabs();
    }
  };
}

/** Hide every visible card without recording a preference: something else took the slot. */
function yieldHandoffCards(except?: HandoffCard): void {
  handoffCards.forEach((card) => {
    if (card !== except && !card.hidden) {
      card.yieldSlot();
    }
  });
}

/** One visible thing at a time in the panel slot. */
function showHandoffCard(card: HandoffCard): void {
  yieldHandoffCards(card);
  getVisiblePanels().forEach((runtime) => minimizePanel(runtime.state.panelId));
  if (questionListOpen) {
    questionListOpen = false;
    renderQuestionListPanel();
  }
  card.show();
  fitSlotToFreeSpace(card.element);
  renderTabs();
}

function mountHandoffCard(session: ScratchHandoff, options: { memoryOnly: boolean }): HandoffCard {
  const existing = handoffCards.get(session.sessionId);
  if (existing) {
    existing.adoptSession(session, { keepLocalDraft: true });
    return existing;
  }
  const card = new HandoffCard(session, handoffDeps(), { memoryOnly: options.memoryOnly });
  handoffCards.set(session.sessionId, card);
  card.element.hidden = true;
  card.mount();
  return card;
}

/** A new scratch session from a selection. Different questions never share one. */
async function openHandoff(entry: HandoffEntry, selection: SelectionPayload, question?: string): Promise<void> {
  const draft: HandoffDraft = {
    question: question ?? (entry === 'why' ? WHY_QUESTION : ''),
    excludedBlockIds: [],
    background: ''
  };
  const response = await sendHandoff({
    type: 'HANDOFF_CREATE',
    buildId: BUILD_ID,
    providerId: provider.id,
    entry,
    scopeKey: currentScopeKey(),
    sourceUrl: normalizeChatUrl(window.location.href),
    selection,
    draft,
    sourceTitle: compactWhitespace(document.title).slice(0, 120)
  });
  if (!response) {
    notifyAside('Aside could not reach its extension worker. Reload this page to use it.');
    return;
  }
  if (response.code === 'stale-client') {
    notifyAside('Aside was updated. Reload this page to use the new version.');
    return;
  }
  if (!response.ok || !response.session) {
    notifyAside('This passage could not be prepared. Select it again and retry.');
    return;
  }
  const card = mountHandoffCard(response.session, {
    memoryOnly: response.memoryOnly === true || response.code === 'storage-unavailable'
  });
  showHandoffCard(card);
  card.focusQuestion();
}

/** Cards for this tab's active sessions, after a reload or a navigation. */
async function restoreHandoffs(): Promise<void> {
  const response = await sendHandoff({ type: 'HANDOFF_LIST_FOR_TAB', buildId: BUILD_ID });
  if (!response?.ok || !response.sessions) {
    if (response?.code === 'stale-client') {
      reportStaleClient(null, 'service worker', response.buildId);
    }
    return;
  }
  const scope = currentScopeKey();
  let shown = false;
  response.sessions
    .slice()
    // Defence in depth: the worker lists only this provider's sessions.
    .filter((session) => session.providerId === provider.id)
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .forEach((session) => {
      const card = mountHandoffCard(session, {
        memoryOnly: response.memoryOnly === true || response.code === 'storage-unavailable'
      });
      const eligible = session.source.scopeKey === scope && !session.hidden;
      if (eligible && !shown && !getVisiblePanels().length && !questionListOpen) {
        shown = true;
        showHandoffCard(card);
      } else if (!card.hidden) {
        card.yieldSlot();
      }
    });
  renderTabs();
}

/** A card whose conversation is no longer on screen steps aside. */
function syncHandoffCardsToScope(): void {
  const scope = currentScopeKey();
  handoffCards.forEach((card) => {
    if (!card.hidden && card.session.source.scopeKey !== scope) {
      card.yieldSlot();
    }
  });
}

function flushHandoffDrafts(): void {
  handoffCards.forEach((card) => {
    void card.flushDraft();
  });
}

function handleHandoffChanged(message: HandoffChangedMessage): void {
  const card = handoffCards.get(message.sessionId);
  if (!card) {
    return;
  }
  if (message.session) {
    if (message.session.providerId !== provider.id) {
      return;
    }
    card.adoptSession(message.session, { keepLocalDraft: true, fromEvent: true });
    renderTabs();
    return;
  }
  const label = routeFor(card.session.providerId).label;
  card.markEnded(
    message.reason === 'target-closed'
      ? `The ${label} tab for this question was closed, so the temporary question was cleared from Aside.`
      : 'Cleared from Aside.'
  );
}

function cleanup(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];

  // Everything Aside put on the page goes: an in-place extension update runs
  // this and then a new content script, and a surviving host would leave dead
  // views the new one does not own. Scratch sessions are not ended here; the
  // worker still holds them for the next content script.
  [...handoffCards.values()].forEach((card) => card.detach());
  handoffCards.clear();
  panelRuntimes.clear();
  extensionHost?.remove();
  document.getElementById(EXTENSION_HOST_ID)?.remove();
  extensionHost = null;
  delete document.documentElement.dataset.asideTheme;
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
  setActiveScopeResolver(() => {
    const url = adapter.normalizeUrl(window.location.href);
    return {
      rootConversationId: adapter.identify(url, sessionDiscriminator).scopeKey,
      rootChatUrl: url
    };
  });

  return true;
}

/**
 * A page Aside opened as a native destination stays exactly as the provider
 * made it: no toolbar, no rail, no restored views, nothing injected. The
 * worker knows the role before the provider document exists, because the tab
 * is registered while it is still blank.
 */
async function pageRole(): Promise<'page' | 'target'> {
  const response = await sendHandoff({ type: 'HANDOFF_ROLE', buildId: BUILD_ID });
  return response?.role === 'target' ? 'target' : 'page';
}

function init(): void {
  window.__asideCleanup?.();
  window.__asideCleanup = cleanup;

  // Only the top document of a provider page: Aside no longer runs in frames.
  if (!isTopFrame() || !bindProviderForDocument()) {
    return;
  }

  void pageRole().then((role) => {
    if (role === 'target') {
      return;
    }
    initTopFrame();
  });
}

init();
