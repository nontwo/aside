import type {
  PanelDeleteMessage,
  PanelUpsertMessage,
  BackgroundRequestMessage,
  BranchAutomationEventMessage,
  BranchFailedEvent,
  BranchPanelEvent,
  CreateBranchWindowMessage,
  CreateBranchWindowResponse,
  FocusBranchWindowMessage,
  FocusBranchWindowResponse,
  ForwardBranchPanelEventMessage,
  RecheckBranchInTabMessage,
  RecheckBranchInTabResponse,
  RunBranchPromptInTabMessage,
  RunBranchPromptInTabResponse
} from '../shared/types';
import { BUILD_ID } from '../shared/build-info';
import { providerHostnames } from '../shared/providers/origins';
import { isBranchAttemptRef, isBranchPanelEvent, ownsAttempt } from '../shared/branch-attempt';
import { handlePanelDelete, handlePanelList, handlePanelUpsert } from './panel-authority';
import {
  ensureMigrated,
  handleDomainBackup,
  handleDomainCommand,
  handleDomainExport,
  handleDomainQuery,
  handleDomainRestore,
  handleLegacyCleanup
} from '../storage/authority';
import { isDomainRequest, type DomainRequestMessage } from '../storage/protocol';

interface BranchWindowSession {
  panelId: string;
  providerId: string;
  /** The attempt that owns this window. Events from any other attempt are dropped. */
  attemptId: string;
  sourceTabId: number;
  sourceWindowId?: number;
  launchTabId: number;
  launchWindowId?: number;
  branchChatUrl?: string;
  live: boolean;
  /**
   * The run request as delivered, kept so the SAME tab can be asked to check a
   * private mode again, or resume after the provider navigated mid-preparation.
   * Session storage only: a private prompt never reaches disk from here.
   */
  pendingRun?: RunBranchPromptInTabMessage;
  /** True once the tab accepted the run at least once. */
  runDelivered?: boolean;
  /** Last private-mode preparation step the tab reported. */
  lastStep?: string;
  /** Build of the content script in the branch tab, from its run response. */
  tabBuildId?: string;
}

// MV3 service workers are torn down after ~30s idle, which can easily happen while a
// branch is still generating. Keeping the sessions only in memory silently dropped the
// "live"/"failed" events that come back afterwards and left the panel spinning forever,
// so the map is mirrored into chrome.storage.session.
const SESSION_STORAGE_KEY = 'aside:branch-sessions';

const sessions = new Map<string, BranchWindowSession>();
let hydration: Promise<Map<string, BranchWindowSession>> | null = null;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Memoize the promise, not a boolean: messages arrive concurrently after the worker
// restarts, and a plain flag would let the second caller read an empty map while the
// first is still awaiting storage — dropping exactly the events this is meant to keep.
function hydrateSessions(): Promise<Map<string, BranchWindowSession>> {
  hydration ??= (async () => {
    try {
      const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY);
      const raw = stored[SESSION_STORAGE_KEY] as Record<string, BranchWindowSession> | undefined;
      if (raw && typeof raw === 'object') {
        Object.entries(raw).forEach(([panelId, session]) => {
          if (session && typeof session.launchTabId === 'number' && !sessions.has(panelId)) {
            sessions.set(panelId, session);
          }
        });
      }
    } catch {
      // Session storage is unavailable in some contexts; stay with the in-memory map.
    }

    return sessions;
  })();

  return hydration;
}

/**
 * Private branch panels are stored in chrome.storage.session so they never reach
 * disk. That area is TRUSTED_CONTEXTS-only by default, which excludes content
 * scripts, so the worker opens it to this extension's own content scripts. It stays
 * extension-scoped: no web page can read it.
 */
async function allowContentScriptSessionStorage(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    });
  } catch {
    // Older Chrome builds lack setAccessLevel; the content script then treats
    // session storage as unavailable and refuses to persist private branches
    // rather than falling back to durable storage.
  }
}

void allowContentScriptSessionStorage();
// The legacy migration is journaled and idempotent, so running it on every
// worker start is safe and is what makes an interrupted run resume.
void ensureMigrated();
chrome.runtime.onStartup.addListener(() => {
  void allowContentScriptSessionStorage();
  void ensureMigrated();
});
chrome.runtime.onInstalled.addListener(() => {
  void allowContentScriptSessionStorage();
  void ensureMigrated();
});

async function persistSessions(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: Object.fromEntries(sessions.entries())
    });
  } catch {
    // Best effort only; the in-memory map still works for this worker lifetime.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

// Derived from the provider registry so a new adapter cannot be reachable in the
// content script while the worker still refuses to focus its tabs.
const BRANCH_HOSTS = providerHostnames();

function isBranchTabUrl(url: string | undefined, expectedUrl?: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (!BRANCH_HOSTS.has(parsed.hostname)) {
      return false;
    }

    if (!expectedUrl) {
      return true;
    }

    const expected = new URL(expectedUrl);
    return parsed.hostname === expected.hostname && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}

// Tab and window ids are only meaningful within a browser session, and Chrome hands the
// same numbers out again after a restart. Panels are persisted to disk, so focusing a
// stored id without checking could activate a completely unrelated tab and report success.
async function focusTab(tabId: number, expectedUrl?: string): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId);
  if (!isBranchTabUrl(tab.url, expectedUrl)) {
    return false;
  }

  await chrome.tabs.update(tabId, { active: true });
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return true;
}

function hasNumericBounds(
  windowState: chrome.windows.Window | undefined
): windowState is chrome.windows.Window & {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return Boolean(
    windowState &&
      typeof windowState.left === 'number' &&
      typeof windowState.top === 'number' &&
      typeof windowState.width === 'number' &&
      typeof windowState.height === 'number'
  );
}

function getSideBySideLayout(sourceWindow: chrome.windows.Window): {
  left: number;
  top: number;
  height: number;
  leftWidth: number;
  rightWidth: number;
} | null {
  if (!hasNumericBounds(sourceWindow)) {
    return null;
  }

  const width = Math.max(sourceWindow.width, 1040);
  const height = Math.max(sourceWindow.height, 720);
  const leftWidth = Math.max(520, Math.floor(width / 2));
  const rightWidth = Math.max(520, width - leftWidth);

  return {
    left: sourceWindow.left,
    top: sourceWindow.top,
    height,
    leftWidth,
    rightWidth
  };
}

async function arrangeWindowsSideBySide(
  sourceWindowId: number | undefined,
  launchWindowId: number | undefined
): Promise<void> {
  if (typeof sourceWindowId !== 'number' || typeof launchWindowId !== 'number') {
    return;
  }

  const sourceWindow = await chrome.windows.get(sourceWindowId);
  const layout = getSideBySideLayout(sourceWindow);
  if (!layout) {
    return;
  }

  // Tiling has to move the source window, including out of 'maximized' — that is the only
  // way to put the branch beside it. What it must not do is fight the window states where
  // resizing is either meaningless or actively hostile.
  if (sourceWindow.state !== 'minimized' && sourceWindow.state !== 'fullscreen') {
    await chrome.windows.update(sourceWindowId, {
      state: 'normal',
      left: layout.left,
      top: layout.top,
      width: layout.leftWidth,
      height: layout.height
    });
  }

  await chrome.windows.update(launchWindowId, {
    state: 'normal',
    left: layout.left + layout.leftWidth,
    top: layout.top,
    width: layout.rightWidth,
    height: layout.height
  });
}

async function waitForTabComplete(tabId: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return;
    }
    await sleep(250);
  }

  throw new Error('The branch tab did not finish loading in time.');
}

async function sendRunMessageToTab(
  tabId: number,
  message: RunBranchPromptInTabMessage,
  timeoutMs = 15_000
): Promise<RunBranchPromptInTabResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'The branch tab did not accept the automation request.';

  while (Date.now() < deadline) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          readyState: document.readyState,
          url: window.location.href
        })
      });

      const response = (await chrome.tabs.sendMessage(tabId, message)) as
        | RunBranchPromptInTabResponse
        | undefined;
      if (response?.ok) {
        return response;
      }
      if (response?.reason) {
        lastError = response.reason;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(250);
  }

  return {
    ok: false,
    reason: lastError
  };
}

async function forwardPanelEvent(panelId: string, event: BranchPanelEvent): Promise<void> {
  const session = (await hydrateSessions()).get(panelId);
  if (!session) {
    return;
  }

  const payload: ForwardBranchPanelEventMessage = {
    type: 'BRANCH_PANEL_EVENT',
    providerId: session.providerId,
    panelId,
    attemptId: session.attemptId,
    event
  };

  try {
    await chrome.tabs.sendMessage(session.sourceTabId, payload);
  } catch {
    // Ignore forwarding failures; the source tab may have been closed.
  }
}

async function handleCreateBranchWindow(
  message: CreateBranchWindowMessage,
  sender: chrome.runtime.MessageSender
): Promise<CreateBranchWindowResponse> {
  const sourceTabId = sender.tab?.id;
  if (typeof sourceTabId !== 'number') {
    return {
      ok: false,
      reason: 'The source tab could not be identified.'
    };
  }

  await hydrateSessions();

  try {
    const createdWindow = await chrome.windows.create({
      url: 'about:blank',
      focused: message.focusWindow ?? true,
      type: 'normal'
    });

    const createdTab = createdWindow.tabs?.[0];
    if (!createdTab || typeof createdTab.id !== 'number') {
      throw new Error('Chrome did not return the created branch tab id.');
    }
    const createdTabId = createdTab.id;

    const session: BranchWindowSession = {
      panelId: message.panelId,
      providerId: message.providerId,
      attemptId: message.attemptId,
      sourceTabId,
      sourceWindowId: sender.tab?.windowId,
      launchTabId: createdTabId,
      launchWindowId: createdWindow.id,
      live: false
    };
    sessions.set(message.panelId, session);
    await persistSessions();

    if (message.arrangeSideBySide !== false) {
      try {
        await arrangeWindowsSideBySide(sender.tab?.windowId, createdWindow.id);
      } catch {
        // Best-effort only.
      }
    }

    await chrome.tabs.update(createdTabId, {
      url: message.launchUrl
    });
    await waitForTabComplete(createdTabId);

    const run: RunBranchPromptInTabMessage = {
      type: 'RUN_BRANCH_PROMPT_IN_TAB',
      providerId: message.providerId,
      panelId: message.panelId,
      attemptId: message.attemptId,
      prompt: message.prompt,
      launchUrl: message.launchUrl,
      branchKind: message.branchKind
    };
    session.pendingRun = run;
    await persistSessions();
    const response = await sendRunMessageToTab(createdTabId, run);

    if (!response.ok) {
      throw new Error(response.reason || 'The created tab rejected the branch automation.');
    }

    session.runDelivered = true;
    session.tabBuildId = response.buildId;
    await persistSessions();
    if (response.buildId && response.buildId !== BUILD_ID) {
      // Two builds are talking: the branch tab's content script predates this
      // worker (or the reverse). Said in the log rather than guessed at later.
      await forwardPanelEvent(message.panelId, {
        kind: 'debug-log',
        message: `[${new Date().toISOString()}] stale-client: branch tab build ${response.buildId} differs from worker build ${BUILD_ID}`
      });
    }

    return {
      ok: true,
      tabId: createdTabId,
      windowId: createdWindow.id
    };
  } catch (error) {
    sessions.delete(message.panelId);
    await persistSessions();
    return {
      ok: false,
      reason: describeError(error)
    };
  }
}

/**
 * Check a private mode again in the SAME branch tab. The stored run request is
 * redelivered under its own attempt id; the tab re-observes and, only if the mode
 * verifies, continues the pending prompt. Nothing is navigated or reopened.
 */
async function handleRecheckBranchInTab(
  message: RecheckBranchInTabMessage
): Promise<RecheckBranchInTabResponse> {
  const session = (await hydrateSessions()).get(message.panelId);
  if (!session || !ownsAttempt(message, session)) {
    return {
      ok: false,
      reason: 'The branch window for this attempt is no longer known. Use Try again.',
      buildId: BUILD_ID
    };
  }
  if (session.live) {
    return { ok: false, reason: 'This branch is already live.', buildId: BUILD_ID };
  }
  if (!session.pendingRun || session.launchTabId < 0) {
    return {
      ok: false,
      reason: 'The branch window was closed. Use Try again.',
      buildId: BUILD_ID
    };
  }

  const response = await sendRunMessageToTab(session.launchTabId, session.pendingRun, 8_000);
  if (response.ok) {
    session.runDelivered = true;
    session.tabBuildId = response.buildId ?? session.tabBuildId;
    await persistSessions();
  }
  return { ok: response.ok, reason: response.reason, buildId: response.buildId ?? BUILD_ID };
}

/**
 * A provider can navigate its own tab while a private mode is being prepared
 * (Claude opens incognito as a new page). The new document has no memory of the
 * run, so the stored request is delivered again — only while the last reported
 * step was before anything was typed, so a resume can never resend.
 */
async function handleBranchTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo
): Promise<void> {
  if (changeInfo.status !== 'complete') {
    return;
  }
  const session = [...(await hydrateSessions()).values()].find(
    (candidate) => candidate.launchTabId === tabId
  );
  if (
    !session ||
    session.live ||
    !session.pendingRun ||
    !session.runDelivered ||
    !session.lastStep ||
    session.lastStep === 'ready' ||
    session.lastStep === 'failed'
  ) {
    return;
  }

  await forwardPanelEvent(session.panelId, {
    kind: 'debug-log',
    message: `[${new Date().toISOString()}] Branch tab navigated during private-mode preparation (last step ${session.lastStep}); delivering the run to the new document`
  });
  const response = await sendRunMessageToTab(tabId, session.pendingRun, 8_000);
  if (!response.ok) {
    await forwardPanelEvent(session.panelId, {
      kind: 'debug-log',
      message: `[${new Date().toISOString()}] The navigated branch tab did not accept the run: ${response.reason ?? 'unknown'}`
    });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void handleBranchTabUpdated(tabId, changeInfo);
});

async function handleFocusBranchWindow(
  message: FocusBranchWindowMessage
): Promise<FocusBranchWindowResponse> {
  const session = (await hydrateSessions()).get(message.panelId);
  const tabId = message.launchTabId ?? session?.launchTabId;
  const windowId = message.launchWindowId ?? session?.launchWindowId;

  const branchChatUrl = message.branchChatUrl ?? session?.branchChatUrl;

  if (typeof tabId === 'number') {
    try {
      if (await focusTab(tabId, branchChatUrl)) {
        return { ok: true, tabId, windowId };
      }
    } catch {
      // Fall through to URL-based open below.
    }
  }

  if (!branchChatUrl) {
    return {
      ok: false,
      reason: 'No persistent branch URL is available yet.'
    };
  }

  // Opening a window can still fail (for example when the profile is shutting down).
  // Without this guard the rejection escaped the message handler and the caller was
  // left waiting on a response that never arrived.
  try {
    const createdWindow = await chrome.windows.create({
      url: branchChatUrl,
      focused: true,
      type: 'normal'
    });
    const createdTab = createdWindow.tabs?.[0];

    if (createdTab && typeof createdTab.id === 'number') {
      const createdTabId = createdTab.id;
      const nextSession = session ?? {
        panelId: message.panelId,
        providerId: 'chatgpt',
        attemptId: '',
        sourceTabId: -1,
        launchTabId: createdTabId,
        launchWindowId: createdWindow.id,
        live: true
      };
      nextSession.launchTabId = createdTabId;
      nextSession.launchWindowId = createdWindow.id;
      nextSession.branchChatUrl = branchChatUrl;
      nextSession.live = true;
      sessions.set(message.panelId, nextSession);
      await persistSessions();
    }

    return {
      ok: true,
      tabId: createdTab?.id,
      windowId: createdWindow.id
    };
  } catch (error) {
    return {
      ok: false,
      reason: describeError(error)
    };
  }
}

async function handleAutomationEvent(
  message: BranchAutomationEventMessage,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const session = (await hydrateSessions()).get(message.panelId);
  if (!session) {
    return;
  }

  // An event may not nominate itself as the current attempt. A window left over
  // from a previous try reports the old attemptId and is dropped here, before it
  // can reassign the session's tab or forward anything to the panel.
  if (!ownsAttempt(message, session)) {
    return;
  }

  if (typeof sender.tab?.id === 'number') {
    session.launchTabId = sender.tab.id;
  }
  if (typeof sender.tab?.windowId === 'number') {
    session.launchWindowId = sender.tab.windowId;
  }

  if (message.event.kind === 'preparation') {
    session.lastStep = message.event.recovery.step;
    await persistSessions();
    await forwardPanelEvent(message.panelId, message.event);
    return;
  }

  if (message.event.kind === 'live') {
    session.live = true;
    session.branchChatUrl = message.event.branchChatUrl;
    await persistSessions();
    const event: BranchPanelEvent = {
      ...message.event,
      launchTabId: session.launchTabId,
      launchWindowId: session.launchWindowId
    };
    await forwardPanelEvent(message.panelId, event);
    return;
  }

  if (message.event.kind === 'failed') {
    // A failure that left a recovery behind keeps the run for Check again; any
    // other failure ends this attempt's claim on the tab.
    session.lastStep = 'failed';
    if (!message.event.recovery) {
      session.pendingRun = undefined;
    }
    const event: BranchFailedEvent = {
      ...message.event,
      launchTabId: session.launchTabId,
      launchWindowId: session.launchWindowId
    };
    if (message.event.branchChatUrl) {
      session.branchChatUrl = message.event.branchChatUrl;
    }
    await persistSessions();
    await forwardPanelEvent(message.panelId, event);
    return;
  }

  await forwardPanelEvent(message.panelId, message.event);
}

// Every branch that keeps the channel open has to answer, otherwise the content script
// waits on a port that is already closed. Unknown message types return false so the
// channel is released immediately instead of leaking.
type WorkerMessage =
  | BackgroundRequestMessage
  | PanelUpsertMessage
  | PanelDeleteMessage
  | { type: 'PANEL_LIST' }
  | DomainRequestMessage;

chrome.runtime.onMessage.addListener((message: WorkerMessage, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }

  // Durable question records: one authority, one transaction per command, and a
  // response only after the commit. Requests are accepted from this extension's
  // own content scripts and pages only.
  if (isDomainRequest(message)) {
    if (sender.id !== chrome.runtime.id) {
      return false;
    }
    const respond = (value: unknown) => sendResponse(value);
    const fail = (error: unknown) => sendResponse({ ok: false, reason: describeError(error) });
    switch (message.type) {
      case 'DOMAIN_COMMAND':
        void handleDomainCommand(message).then(respond, fail);
        return true;
      case 'DOMAIN_QUERY':
        void handleDomainQuery(message).then(respond, fail);
        return true;
      case 'DOMAIN_BACKUP':
        void handleDomainBackup().then(respond, fail);
        return true;
      case 'DOMAIN_RESTORE':
        void handleDomainRestore(message.backup).then(respond, fail);
        return true;
      case 'DOMAIN_EXPORT_MARKDOWN':
        void handleDomainExport(message.sourceId).then(respond, fail);
        return true;
      case 'DOMAIN_LEGACY_CLEANUP':
        void handleLegacyCleanup(message.confirm).then(respond, fail);
        return true;
      default:
        return false;
    }
  }

  // Every branch message is validated as data on arrival, not trusted by shape.
  if (
    (message.type === 'CREATE_BRANCH_WINDOW' ||
      message.type === 'RECHECK_BRANCH_IN_TAB' ||
      message.type === 'BRANCH_AUTOMATION_EVENT') &&
    !isBranchAttemptRef(message)
  ) {
    return false;
  }

  if (message.type === 'BRANCH_AUTOMATION_EVENT' && !isBranchPanelEvent(message.event)) {
    return false;
  }

  switch (message.type) {
    case 'CREATE_BRANCH_WINDOW':
      void handleCreateBranchWindow(message, sender).then(sendResponse, (error: unknown) => {
        sendResponse({ ok: false, reason: describeError(error) });
      });
      return true;

    case 'FOCUS_BRANCH_WINDOW':
      void handleFocusBranchWindow(message).then(sendResponse, (error: unknown) => {
        sendResponse({ ok: false, reason: describeError(error) });
      });
      return true;

    case 'RECHECK_BRANCH_IN_TAB':
      void handleRecheckBranchInTab(message).then(sendResponse, (error: unknown) => {
        sendResponse({ ok: false, reason: describeError(error), buildId: BUILD_ID });
      });
      return true;

    case 'BRANCH_AUTOMATION_EVENT':
      void handleAutomationEvent(message, sender).then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, reason: describeError(error) })
      );
      return true;

    case 'PANEL_UPSERT':
      void handlePanelUpsert(message).then(sendResponse, (error: unknown) =>
        sendResponse({ ok: false, status: 'error', unsaved: true, reason: describeError(error) })
      );
      return true;

    case 'PANEL_DELETE':
      void handlePanelDelete(message).then(sendResponse, (error: unknown) =>
        sendResponse({ ok: false, status: 'error', unsaved: true, reason: describeError(error) })
      );
      return true;

    case 'PANEL_LIST':
      // The worker's build travels with every list so a content script left over
      // from a previous install can tell it is talking to a newer worker.
      void handlePanelList().then(
        (response) => sendResponse({ ...response, buildId: BUILD_ID }),
        (error: unknown) =>
          sendResponse({ ok: false, records: [], reason: describeError(error), buildId: BUILD_ID })
      );
      return true;

    default:
      return false;
  }
});

async function handleBranchTabRemoved(tabId: number): Promise<void> {
  const knownSessions = await hydrateSessions();
  let changed = false;

  for (const [panelId, session] of [...knownSessions.entries()]) {
    if (session.launchTabId !== tabId) {
      continue;
    }

    if (!session.live) {
      await forwardPanelEvent(panelId, {
        kind: 'failed',
        reason: 'The branch tab was closed before the branch finished creating.',
        launchTabId: tabId
      });
      knownSessions.delete(panelId);
      changed = true;
      continue;
    }

    session.launchTabId = -1;
    changed = true;
  }

  if (changed) {
    await persistSessions();
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleBranchTabRemoved(tabId);
});

/**
 * The library is Aside's own page: saved questions, search, export, backup. It
 * opens in a normal tab from the toolbar action or from a panel; it never embeds
 * a provider site.
 */
async function openLibraryPage(): Promise<void> {
  const url = chrome.runtime.getURL('library.html');
  const existing = await chrome.tabs.query({ url });
  const tab = existing[0];
  if (tab && typeof tab.id === 'number') {
    await chrome.tabs.update(tab.id, { active: true });
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.action?.onClicked.addListener(() => {
  void openLibraryPage();
});

chrome.runtime.onMessage.addListener((message: { type?: string } | null, sender, sendResponse) => {
  if (!message || message.type !== 'OPEN_LIBRARY' || sender.id !== chrome.runtime.id) {
    return false;
  }
  void openLibraryPage().then(
    () => sendResponse({ ok: true }),
    (error: unknown) => sendResponse({ ok: false, reason: describeError(error) })
  );
  return true;
});
