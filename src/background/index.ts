import type { PanelDeleteMessage, PanelUpsertMessage } from '../shared/types';
import { BUILD_ID } from '../shared/build-info';
import { providerHostnames } from '../shared/providers/origins';
import { getAdapter } from '../shared/providers';
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
import {
  HandoffAuthority,
  isHandoffRequestType,
  isRetiredAutomationMessage,
  type HandoffEnv
} from '../handoff/authority';
import { buildSaveNoteCommand, freshSaveNoteIds } from '../handoff/save-note';

/**
 * The service worker: the single authority for durable question records, for
 * legacy panel view records, and for scratch handoffs.
 *
 * It no longer runs branches. The automatic path — driven windows, prompt
 * delivery into provider tabs, re-delivery after navigation, automation events —
 * is retired: those message types are refused from any client, including a
 * content script left over from an older build.
 */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Session storage holds scratch handoffs and private legacy panels. Only this
 * worker and extension pages read it; content scripts reach their own
 * sessions through targeted messages, so the area stays restricted to trusted
 * extension contexts.
 */
async function restrictSessionStorage(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome builds lack setAccessLevel; the default is already trusted-only.
  }
}

void restrictSessionStorage();
// The legacy migration is journaled and idempotent, so running it on every
// worker start is safe and is what makes an interrupted run resume.
void ensureMigrated();
chrome.runtime.onStartup.addListener(() => {
  void restrictSessionStorage();
  void ensureMigrated();
});
chrome.runtime.onInstalled.addListener(() => {
  void restrictSessionStorage();
  void ensureMigrated();
});

function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const handoffEnv: HandoffEnv = {
  buildId: BUILD_ID,
  extensionId: chrome.runtime.id,
  now: () => Date.now(),
  randomId: randomSessionId,
  session: chrome.storage?.session ?? null,
  tabs: {
    create: (props) => chrome.tabs.create(props),
    update: (tabId, props) => chrome.tabs.update(tabId, props),
    get: (tabId) => chrome.tabs.get(tabId),
    remove: (tabId) => chrome.tabs.remove(tabId),
    sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message)
  },
  windows: {
    create: (props) => chrome.windows.create(props) as Promise<chrome.windows.Window>,
    update: (windowId, props) => chrome.windows.update(windowId, props),
    get: (windowId, options) => chrome.windows.get(windowId, options ?? {})
  },
  async saveNote(session, input) {
    const identity = getAdapter(session.providerId).identify(session.selection.rootChatUrl, '');
    const command = buildSaveNoteCommand(
      session,
      input,
      { conversationId: identity.conversationId, containerId: identity.containerId },
      freshSaveNoteIds()
    );
    const response = await handleDomainCommand({ type: 'DOMAIN_COMMAND', command });
    if (!response.ok || response.outcome?.status !== 'applied') {
      throw new Error('The note was not saved.');
    }
    return { questionId: command.question.id };
  }
};

const handoffs = new HandoffAuthority(handoffEnv);

// Browser events for scratch handoffs. Top-level so a suspended worker wakes for
// them; each handler ignores tabs no session owns.
chrome.tabs.onRemoved.addListener((tabId) => {
  void handoffs.onTabRemoved(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    void handoffs.onTabUpdated(tabId, changeInfo.url);
  }
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void handoffs.onTabReplaced(addedTabId, removedTabId);
});

/** A saved record's provider link, opened as plain navigation in a new tab. */
function isSafeProviderUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 4_000) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && providerHostnames().has(parsed.hostname);
  } catch {
    return false;
  }
}

// Every branch that keeps the channel open has to answer, otherwise the content script
// waits on a port that is already closed. Unknown message types return false so the
// channel is released immediately instead of leaking.
type WorkerMessage =
  | PanelUpsertMessage
  | PanelDeleteMessage
  | { type: 'PANEL_LIST' }
  | { type: 'OPEN_PROVIDER_URL'; url: string }
  | DomainRequestMessage;

chrome.runtime.onMessage.addListener((message: WorkerMessage | { type?: unknown }, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }
  // Only this extension's own content scripts and pages.
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  // The automatic branch runner is retired. An old content script that still
  // asks for it gets an explicit refusal, never a partial execution.
  if (isRetiredAutomationMessage(message.type)) {
    sendResponse({ ok: false, code: 'retired', buildId: BUILD_ID, reason: 'This build does not run branches automatically.' });
    return false;
  }

  if (isHandoffRequestType(message.type)) {
    void handoffs.handle(message as never, sender).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, code: 'invalid-request', buildId: BUILD_ID, reason: describeError(error) })
    );
    return true;
  }

  // Durable question records: one authority, one transaction per command, and a
  // response only after the commit.
  if (isDomainRequest(message)) {
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

  const typed = message as WorkerMessage;
  switch (typed.type) {
    case 'PANEL_UPSERT':
      void handlePanelUpsert(typed).then(sendResponse, (error: unknown) =>
        sendResponse({ ok: false, status: 'error', unsaved: true, reason: describeError(error) })
      );
      return true;

    case 'PANEL_DELETE':
      void handlePanelDelete(typed).then(sendResponse, (error: unknown) =>
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

    case 'OPEN_PROVIDER_URL':
      // Navigation only: a saved record's conversation, opened in a new tab. It
      // never carries or delivers a prompt.
      if (!isSafeProviderUrl(typed.url)) {
        sendResponse({ ok: false, reason: 'Not a provider conversation link.' });
        return false;
      }
      // Blank first, then navigate: the same two-step open as a handoff target,
      // so nothing loads before the tab exists as a known, ordinary tab.
      void (async () => {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        if (typeof tab.id !== 'number') {
          throw new Error('no tab id');
        }
        await chrome.tabs.update(tab.id, { url: typed.url });
      })().then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, reason: describeError(error) })
      );
      return true;

    default:
      return false;
  }
});

/**
 * The library is Aside's own page: saved questions, search, export, backup. It
 * opens in a normal tab from the toolbar popup or from the question list; it
 * never embeds a provider site.
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
