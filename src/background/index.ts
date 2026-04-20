import type {
  BackgroundRequestMessage,
  BranchAutomationEventMessage,
  BranchFailedEvent,
  BranchPanelEvent,
  CreateBranchWindowMessage,
  CreateBranchWindowResponse,
  FocusBranchWindowMessage,
  FocusBranchWindowResponse,
  ForwardBranchPanelEventMessage,
  RunBranchPromptInTabMessage,
  RunBranchPromptInTabResponse
} from '../shared/types';

interface BranchWindowSession {
  panelId: string;
  sourceTabId: number;
  sourceWindowId?: number;
  launchTabId: number;
  launchWindowId?: number;
  branchChatUrl?: string;
  live: boolean;
}

const sessions = new Map<string, BranchWindowSession>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
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

  await chrome.windows.update(sourceWindowId, {
    state: 'normal',
    left: layout.left,
    top: layout.top,
    width: layout.leftWidth,
    height: layout.height
  });

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

  throw new Error('The ChatGPT branch tab did not finish loading in time.');
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
  const session = sessions.get(panelId);
  if (!session) {
    return;
  }

  const payload: ForwardBranchPanelEventMessage = {
    type: 'BRANCH_PANEL_EVENT',
    panelId,
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
      reason: 'The source ChatGPT tab could not be identified.'
    };
  }

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
      sourceTabId,
      sourceWindowId: sender.tab?.windowId,
      launchTabId: createdTabId,
      launchWindowId: createdWindow.id,
      live: false
    };
    sessions.set(message.panelId, session);

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

    const response = await sendRunMessageToTab(createdTabId, {
      type: 'RUN_BRANCH_PROMPT_IN_TAB',
      panelId: message.panelId,
      prompt: message.prompt,
      launchUrl: message.launchUrl,
      branchKind: message.branchKind
    });

    if (!response.ok) {
      throw new Error(response.reason || 'The created ChatGPT tab rejected the branch automation.');
    }

    return {
      ok: true,
      tabId: createdTabId,
      windowId: createdWindow.id
    };
  } catch (error) {
    sessions.delete(message.panelId);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleFocusBranchWindow(
  message: FocusBranchWindowMessage
): Promise<FocusBranchWindowResponse> {
  const session = sessions.get(message.panelId);
  const tabId = message.launchTabId ?? session?.launchTabId;
  const windowId = message.launchWindowId ?? session?.launchWindowId;

  if (typeof windowId === 'number') {
    try {
      await chrome.windows.update(windowId, { focused: true });
      if (typeof tabId === 'number') {
        await focusTab(tabId);
      }
      return { ok: true, tabId, windowId };
    } catch {
      // Fall through to URL-based open below.
    }
  }

  if (typeof tabId === 'number') {
    try {
      await focusTab(tabId);
      return { ok: true, tabId };
    } catch {
      // Fall through to URL-based open below.
    }
  }

  if (!message.branchChatUrl && !session?.branchChatUrl) {
    return {
      ok: false,
      reason: 'No persistent branch URL is available yet.'
    };
  }

  const createdWindow = await chrome.windows.create({
    url: message.branchChatUrl ?? session?.branchChatUrl,
    focused: true,
    type: 'normal'
  });
  const createdTab = createdWindow.tabs?.[0];

  if (createdTab && typeof createdTab.id === 'number') {
    const createdTabId = createdTab.id;
    const nextSession = session ?? {
      panelId: message.panelId,
      sourceTabId: -1,
      launchTabId: createdTabId,
      launchWindowId: createdWindow.id,
      live: true
    };
    nextSession.launchTabId = createdTabId;
    nextSession.launchWindowId = createdWindow.id;
    nextSession.branchChatUrl = message.branchChatUrl ?? session?.branchChatUrl;
    nextSession.live = true;
    sessions.set(message.panelId, nextSession);
  }

  return {
    ok: true,
    tabId: createdTab?.id,
    windowId: createdWindow.id
  };
}

async function handleAutomationEvent(
  message: BranchAutomationEventMessage,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const session = sessions.get(message.panelId);
  if (!session) {
    return;
  }

  if (typeof sender.tab?.id === 'number') {
    session.launchTabId = sender.tab.id;
  }
  if (typeof sender.tab?.windowId === 'number') {
    session.launchWindowId = sender.tab.windowId;
  }

  if (message.event.kind === 'live') {
    session.live = true;
    session.branchChatUrl = message.event.branchChatUrl;
    const event: BranchPanelEvent = {
      ...message.event,
      launchTabId: session.launchTabId,
      launchWindowId: session.launchWindowId
    };
    await forwardPanelEvent(message.panelId, event);
    return;
  }

  if (message.event.kind === 'failed') {
    const event: BranchFailedEvent = {
      ...message.event,
      launchTabId: session.launchTabId,
      launchWindowId: session.launchWindowId
    };
    if (message.event.branchChatUrl) {
      session.branchChatUrl = message.event.branchChatUrl;
    }
    await forwardPanelEvent(message.panelId, event);
    return;
  }

  await forwardPanelEvent(message.panelId, message.event);
}

chrome.runtime.onMessage.addListener((message: BackgroundRequestMessage, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }

  void (async () => {
    switch (message.type) {
      case 'CREATE_BRANCH_WINDOW':
        sendResponse(await handleCreateBranchWindow(message, sender));
        return;

      case 'FOCUS_BRANCH_WINDOW':
        sendResponse(await handleFocusBranchWindow(message));
        return;

      case 'BRANCH_AUTOMATION_EVENT':
        await handleAutomationEvent(message, sender);
        sendResponse({ ok: true });
        return;
    }
  })();

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [panelId, session] of sessions.entries()) {
    if (session.launchTabId !== tabId) {
      continue;
    }

    if (!session.live) {
      void forwardPanelEvent(panelId, {
        kind: 'failed',
        reason: 'The background ChatGPT branch tab was closed before the branch finished creating.',
        launchTabId: tabId
      });
      sessions.delete(panelId);
      return;
    }

    session.launchTabId = -1;
  }
});
