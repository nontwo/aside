import { beforeEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_STORAGE_PREFIX,
  HandoffAuthority,
  conversationPathOf,
  isRetiredAutomationMessage,
  type HandoffEnv,
  type SenderLike,
  type StorageAreaLike,
  type TabLike
} from '../src/handoff/authority';
import type { HandoffDraft, HandoffRequest, ScratchHandoff } from '../src/handoff/types';

const EXT = 'extension-id-abc';
const BUILD = 'test-build';
const MARKER = 'scratch-marker-7f3a';

/** A session-storage double that records every write, so tests can observe them. */
class RecordingArea implements StorageAreaLike {
  data = new Map<string, unknown>();
  writes: string[] = [];
  failWrites = false;
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null) {
      return Object.fromEntries(this.data);
    }
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((key) => this.data.has(key)).map((key) => [key, this.data.get(key)]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failWrites) {
      throw new Error('QUOTA_BYTES exceeded');
    }
    Object.entries(items).forEach(([key, value]) => {
      this.writes.push(JSON.stringify(value));
      this.data.set(key, JSON.parse(JSON.stringify(value)));
    });
  }
  async remove(keys: string | string[]): Promise<void> {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.data.delete(key));
  }
}

interface FakeBrowser {
  tabs: Map<number, TabLike>;
  windows: Map<number, { id: number; state: string; left: number; top: number; width: number; height: number }>;
  created: Array<{ kind: 'window' | 'tab'; url: string }>;
  navigations: Array<{ tabId: number; url: string }>;
  removed: number[];
  messages: Array<{ tabId: number; message: unknown }>;
  focused: number[];
  createDelayMs: number;
  failCreate: boolean;
  failRemove: boolean;
  anchorReply: string;
}

function makeEnv(area: StorageAreaLike | null, saveNote?: HandoffEnv['saveNote']): { env: HandoffEnv; browser: FakeBrowser } {
  let nextTab = 100;
  let nextWindow = 10;
  let clock = 1_000;
  let ids = 0;
  const browser: FakeBrowser = {
    tabs: new Map([[1, { id: 1, windowId: 1, index: 0, url: 'https://chatgpt.com/c/source-1' }]]),
    windows: new Map([[1, { id: 1, state: 'normal', left: 0, top: 0, width: 1400, height: 900 }]]),
    created: [],
    navigations: [],
    removed: [],
    messages: [],
    focused: [],
    createDelayMs: 0,
    failCreate: false,
    failRemove: false,
    anchorReply: 'exact'
  };
  const env: HandoffEnv = {
    buildId: BUILD,
    extensionId: EXT,
    now: () => (clock += 10),
    randomId: () => `session-${++ids}`,
    session: area,
    tabs: {
      async create(props) {
        if (browser.failCreate) {
          throw new Error('cannot create');
        }
        await new Promise((resolve) => setTimeout(resolve, browser.createDelayMs));
        const tab = { id: ++nextTab, windowId: props.windowId ?? 1, index: props.index ?? 1, url: props.url };
        browser.tabs.set(tab.id, tab);
        browser.created.push({ kind: 'tab', url: props.url });
        return tab;
      },
      async update(tabId, props) {
        const tab = browser.tabs.get(tabId);
        if (!tab) {
          throw new Error('No tab with id');
        }
        if (props.url) {
          tab.url = props.url;
          browser.navigations.push({ tabId, url: props.url });
        }
        if (props.active) {
          browser.focused.push(tabId);
        }
        return tab;
      },
      async get(tabId) {
        const tab = browser.tabs.get(tabId);
        if (!tab) {
          throw new Error('No tab with id');
        }
        return tab;
      },
      async remove(tabId) {
        if (browser.failRemove) {
          throw new Error('cannot close');
        }
        browser.tabs.delete(tabId);
        browser.removed.push(tabId);
      },
      async sendMessage(tabId, message) {
        browser.messages.push({ tabId, message });
        if ((message as { type?: string }).type === 'HANDOFF_SCROLL_TO_ANCHOR') {
          return { anchor: browser.anchorReply };
        }
        return { ok: true };
      }
    },
    windows: {
      async create(props) {
        if (browser.failCreate) {
          throw new Error('cannot create');
        }
        await new Promise((resolve) => setTimeout(resolve, browser.createDelayMs));
        const windowId = ++nextWindow;
        const tab = { id: ++nextTab, windowId, index: 0, url: props.url };
        browser.tabs.set(tab.id, tab);
        browser.windows.set(windowId, { id: windowId, state: 'normal', left: 0, top: 0, width: 800, height: 600 });
        browser.created.push({ kind: 'window', url: props.url });
        return { id: windowId, tabs: [tab] };
      },
      async update(windowId, props) {
        const current = browser.windows.get(windowId);
        if (current) {
          Object.assign(current, props);
        }
        return current;
      },
      async get(windowId) {
        const current = browser.windows.get(windowId);
        if (!current) {
          throw new Error('No window');
        }
        return current;
      }
    },
    saveNote
  };
  return { env, browser };
}

const SOURCE: SenderLike = {
  id: EXT,
  frameId: 0,
  tab: { id: 1, windowId: 1, url: 'https://chatgpt.com/c/source-1' }
};
const OTHER_TAB: SenderLike = {
  id: EXT,
  frameId: 0,
  tab: { id: 2, windowId: 1, url: 'https://chatgpt.com/c/other' }
};
const POPUP: SenderLike = { id: EXT, url: `chrome-extension://${EXT}/popup.html` };
/** The popup page opened as a tab (as the browser smoke does): still an extension page. */
const POPUP_IN_TAB: SenderLike = { id: EXT, frameId: 0, url: `chrome-extension://${EXT}/popup.html`, tab: { id: 77, windowId: 1, url: `chrome-extension://${EXT}/popup.html` } };

function draft(question = `Why? ${MARKER}`): HandoffDraft {
  return { question, excludedBlockIds: [], background: '' };
}

function createRequest(entry: 'ask' | 'why' | 'new_tab' = 'ask'): HandoffRequest {
  return {
    type: 'HANDOFF_CREATE',
    buildId: BUILD,
    providerId: 'chatgpt',
    entry,
    scopeKey: 'chatgpt:c:source-1',
    sourceUrl: 'https://chatgpt.com/c/source-1',
    selection: {
      rootConversationId: 'chatgpt:c:source-1',
      rootChatUrl: 'https://chatgpt.com/c/source-1',
      selectedText: `the passage ${MARKER}`,
      structuredSelectedText: `the passage ${MARKER}`,
      selectedBlocks: [],
      branchBaseMessageId: 'm-1',
      rangeQuotes: { exact: 'the passage', prefix: '', suffix: '' },
      fallbackScrollY: 0
    } as unknown as ScratchHandoff['selection'],
    draft: draft()
  };
}

async function created(authority: HandoffAuthority, entry: 'ask' | 'why' | 'new_tab' = 'ask'): Promise<ScratchHandoff> {
  const response = await authority.handle(createRequest(entry), SOURCE);
  expect(response.ok).toBe(true);
  return response.session as ScratchHandoff;
}

let area: RecordingArea;

beforeEach(() => {
  area = new RecordingArea();
});

describe('scratch handoff authority: lifecycle and retention', () => {
  it('creates a session only in session storage, and End removes it', async () => {
    const { env } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);

    expect(session.policy).toBe('temporary-intended');
    expect(session.target.state).toBe('none');
    // The marker is in session storage while the session is active...
    expect([...area.data.keys()]).toEqual([HANDOFF_STORAGE_PREFIX + session.sessionId]);
    expect(JSON.stringify([...area.data.values()])).toContain(MARKER);

    const ended = await authority.handle(
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: true },
      SOURCE
    );
    expect(ended.ok).toBe(true);
    // ...and gone from it, and from memory, once ended.
    expect(area.data.size).toBe(0);
    expect(await authority.all()).toEqual([]);
  });

  it('never implicitly creates a session from an update, copy, open or end', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const requests: HandoffRequest[] = [
      { type: 'HANDOFF_UPDATE', buildId: BUILD, sessionId: 'ghost', baseEpoch: 1, draft: draft() },
      { type: 'HANDOFF_COPIED', buildId: BUILD, sessionId: 'ghost', ok: true, code: 'ok', prompt: null },
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: 'ghost', kind: 'window' },
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: 'ghost', closeTarget: true }
    ];
    for (const request of requests) {
      const response = await authority.handle(request, SOURCE);
      expect(response.ok).toBe(false);
      expect(response.code).toBe('missing-session');
    }
    expect(area.data.size).toBe(0);
    expect(browser.created).toEqual([]);
  });

  it('late messages after End cannot resurrect the session', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    await authority.handle({ type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: false }, SOURCE);

    const late = await authority.handle(
      { type: 'HANDOFF_UPDATE', buildId: BUILD, sessionId: session.sessionId, baseEpoch: session.epoch, draft: draft('late') },
      SOURCE
    );
    const lateOpen = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    expect(late.code).toBe('missing-session');
    expect(lateOpen.code).toBe('missing-session');
    expect(area.data.size).toBe(0);
    expect(browser.created).toEqual([]);
  });

  it('keeps the session in memory, never on disk, when session storage is unavailable', async () => {
    area.failWrites = true;
    const { env } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const response = await authority.handle(createRequest(), SOURCE);
    expect(response.ok).toBe(true);
    expect(response.code).toBe('storage-unavailable');
    expect(area.data.size).toBe(0);
    expect(await authority.all()).toHaveLength(1);

    const noArea = new HandoffAuthority(makeEnv(null).env);
    const second = await noArea.handle(createRequest(), SOURCE);
    expect(second.code).toBe('storage-unavailable');
  });

  it('rehydrates after a worker restart without opening, focusing or copying anything', async () => {
    const first = makeEnv(area);
    const authority = new HandoffAuthority(first.env);
    const session = await created(authority);
    await authority.handle({ type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' }, SOURCE);
    const createdBefore = first.browser.created.length;

    const restarted = makeEnv(area);
    const revived = new HandoffAuthority(restarted.env);
    const list = await revived.handle({ type: 'HANDOFF_LIST_FOR_TAB', buildId: BUILD }, SOURCE);
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions?.[0].target.state).toBe('open');
    expect(restarted.browser.created).toEqual([]);
    expect(restarted.browser.focused).toEqual([]);
    expect(restarted.browser.navigations).toEqual([]);
    expect(first.browser.created.length).toBe(createdBefore);
  });

  it('uses a stale epoch as a conflict, returning the current record', async () => {
    const { env } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const first = await authority.handle(
      { type: 'HANDOFF_UPDATE', buildId: BUILD, sessionId: session.sessionId, baseEpoch: session.epoch, draft: draft('one') },
      SOURCE
    );
    expect(first.ok).toBe(true);
    const stale = await authority.handle(
      { type: 'HANDOFF_UPDATE', buildId: BUILD, sessionId: session.sessionId, baseEpoch: session.epoch, draft: draft('two') },
      SOURCE
    );
    expect(stale.code).toBe('stale-epoch');
    expect(stale.session?.draft.question).toBe('one');
  });

  it('does not accumulate state across many sessions', async () => {
    const { env } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    for (let index = 0; index < 50; index += 1) {
      const session = await created(authority);
      await authority.handle({ type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' }, SOURCE);
      await authority.handle({ type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: true }, SOURCE);
    }
    expect(await authority.all()).toEqual([]);
    expect(area.data.size).toBe(0);
  });
});

describe('scratch handoff authority: authorization', () => {
  it('rejects another tab, a subframe, a foreign extension and a stale build', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const open = { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' } as const;

    expect((await authority.handle(open, OTHER_TAB)).code).toBe('missing-session');
    expect((await authority.handle(open, { ...SOURCE, frameId: 3 })).code).toBe('invalid-request');
    expect((await authority.handle(open, { ...SOURCE, id: 'someone-else' })).code).toBe('invalid-request');
    expect((await authority.handle({ ...open, buildId: 'older-build' }, SOURCE)).code).toBe('stale-client');
    expect(browser.created).toEqual([]);
  });

  it('refuses retired automation messages from any client', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    for (const type of ['CREATE_BRANCH_WINDOW', 'RECHECK_BRANCH_IN_TAB', 'RUN_BRANCH_PROMPT_IN_TAB', 'BRANCH_AUTOMATION_EVENT']) {
      expect(isRetiredAutomationMessage(type)).toBe(true);
      const response = await authority.handle({ type } as never, SOURCE);
      expect(response.code).toBe('retired');
    }
    expect(browser.created).toEqual([]);
    expect(browser.navigations).toEqual([]);
  });

  it('refuses a create from a page that is not on the provider, or from a native destination', async () => {
    const { env } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const offsite = await authority.handle(createRequest(), {
      ...SOURCE,
      tab: { id: 1, windowId: 1, url: 'https://example.com/' }
    });
    expect(offsite.code).toBe('invalid-request');

    const session = await created(authority);
    const opened = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    const targetTab = opened.session?.target.tabId as number;
    const fromTarget = await authority.handle(createRequest(), {
      id: EXT,
      frameId: 0,
      tab: { id: targetTab, windowId: 11, url: 'https://chatgpt.com/?temporary-chat=true' }
    });
    expect(fromTarget.code).toBe('invalid-request');
    const role = await authority.handle({ type: 'HANDOFF_ROLE', buildId: BUILD }, {
      id: EXT,
      frameId: 0,
      tab: { id: targetTab, windowId: 11, url: 'https://chatgpt.com/?temporary-chat=true' }
    });
    expect(role.role).toBe('target');
    expect((await authority.handle({ type: 'HANDOFF_ROLE', buildId: BUILD }, SOURCE)).role).toBe('page');
  });

  it('lists only the sender tab-s own sessions to a page, and every session only to an extension page', async () => {
    const { env } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    await created(authority);
    expect((await authority.handle({ type: 'HANDOFF_LIST_FOR_TAB', buildId: BUILD }, OTHER_TAB)).sessions).toEqual([]);
    expect((await authority.handle({ type: 'HANDOFF_LIST_ACTIVE', buildId: BUILD }, SOURCE)).ok).toBe(false);
    expect((await authority.handle({ type: 'HANDOFF_LIST_ACTIVE', buildId: BUILD }, POPUP)).sessions).toHaveLength(1);
    expect((await authority.handle({ type: 'HANDOFF_LIST_ACTIVE', buildId: BUILD }, POPUP_IN_TAB)).sessions).toHaveLength(1);
    // A provider page cannot pass itself off as an extension page.
    const spoof: SenderLike = { ...OTHER_TAB, url: 'https://chatgpt.com/c/other' };
    expect((await authority.handle({ type: 'HANDOFF_LIST_ACTIVE', buildId: BUILD }, spoof)).ok).toBe(false);
  });
});

describe('scratch handoff authority: the native destination', () => {
  it('opens blank first, registers ownership, then navigates to the route with no content in the URL', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const opened = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    expect(opened.code).toBe('opened');
    expect(browser.created).toEqual([{ kind: 'window', url: 'about:blank' }]);
    expect(browser.navigations).toHaveLength(1);
    expect(browser.navigations[0].url).toBe('https://chatgpt.com/?temporary-chat=true');
    expect(browser.navigations[0].url).not.toContain(MARKER);
    expect(opened.session?.target).toMatchObject({ state: 'open', ownership: 'owned', windowCreated: true, route: 'convenience' });
  });

  it('New-tab opens a tab beside the source, in the source window', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority, 'new_tab');
    expect(session.target.kind).toBe('tab');
    await authority.handle({ type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'tab' }, SOURCE);
    expect(browser.created).toEqual([{ kind: 'tab', url: 'about:blank' }]);
    const tab = [...browser.tabs.values()].find((candidate) => candidate.id !== 1);
    expect(tab?.windowId).toBe(1);
    expect(tab?.index).toBe(1);
  });

  it('the base route is the plain native new chat', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window', route: 'base' },
      SOURCE
    );
    expect(browser.navigations[0].url).toBe('https://chatgpt.com/');
  });

  it('rapid repeat clicks focus the one target instead of opening another', async () => {
    const { env, browser } = makeEnv(area);
    browser.createDelayMs = 30;
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const open = { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' } as const;
    const results = await Promise.all([authority.handle(open, SOURCE), authority.handle(open, SOURCE), authority.handle(open, SOURCE)]);
    expect(browser.created).toHaveLength(1);
    expect(results.map((result) => result.code)).toEqual(['opened', 'focused-existing', 'focused-existing']);
  });

  it('different questions get different sessions and different targets; Continue focuses only its own', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const first = await created(authority);
    const second = await created(authority);
    const a = await authority.handle({ type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: first.sessionId, kind: 'window' }, SOURCE);
    const b = await authority.handle({ type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: second.sessionId, kind: 'window' }, SOURCE);
    expect(a.session?.target.tabId).not.toBe(b.session?.target.tabId);
    browser.focused = [];
    await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: first.sessionId, kind: 'window', focusOnly: true },
      SOURCE
    );
    expect(browser.focused).toEqual([a.session?.target.tabId]);
  });

  it('open failure is reported and leaves the session usable; the copy state is independent', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const copied = await authority.handle(
      {
        type: 'HANDOFF_COPIED',
        buildId: BUILD,
        sessionId: session.sessionId,
        ok: true,
        code: 'ok',
        prompt: {
          revision: 1,
          text: `prompt ${MARKER}`,
          question: 'q',
          compilerVersion: 'c',
          templateVersion: 't',
          included: [],
          omitted: [],
          missing: [],
          charCount: 1,
          maxChars: 10,
          overBudget: false
        }
      },
      SOURCE
    );
    expect(copied.session?.clipboard).toBe('copied');
    browser.failCreate = true;
    const failed = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    expect(failed.code).toBe('open-failed');
    expect(failed.session?.clipboard).toBe('copied');
    expect(failed.session?.target.state).toBe('none');
    browser.failCreate = false;
    const retried = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    expect(retried.code).toBe('opened');
  });

  it('a closed target is reported as unavailable, never silently reopened', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const opened = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    // The tab disappears without a removal event reaching the worker.
    browser.tabs.delete(opened.session?.target.tabId as number);
    const again = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    expect(again.code).toBe('target-closed');
    expect(browser.created).toHaveLength(1);
  });
});

describe('scratch handoff authority: browser events and closure', () => {
  async function openSession(authority: HandoffAuthority): Promise<ScratchHandoff> {
    const session = await created(authority);
    const opened = await authority.handle(
      { type: 'HANDOFF_OPEN', buildId: BUILD, sessionId: session.sessionId, kind: 'window' },
      SOURCE
    );
    return opened.session as ScratchHandoff;
  }

  it('closing the native tab ends and purges the scratch, and tells the source tab', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    await authority.onTabRemoved(session.target.tabId as number);
    expect(await authority.all()).toEqual([]);
    expect(area.data.size).toBe(0);
    expect(browser.messages.at(-1)).toMatchObject({
      tabId: 1,
      message: { type: 'HANDOFF_CHANGED', session: null, reason: 'target-closed' }
    });
  });

  it('closing the source tab keeps the session and leaves the native tab alone', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    await authority.onTabRemoved(1);
    const [kept] = await authority.all();
    expect(kept.source.open).toBe(false);
    expect(browser.removed).toEqual([]);
    const back = await authority.handle({ type: 'HANDOFF_RETURN', buildId: BUILD, sessionId: session.sessionId }, POPUP);
    expect(back.anchor).toBe('source-closed');
  });

  it('End closes a demonstrably owned tab, and only that tab', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    const ended = await authority.handle(
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: true },
      SOURCE
    );
    expect(ended.targetClosed).toBe(true);
    expect(browser.removed).toEqual([session.target.tabId]);
    expect(browser.tabs.has(1)).toBe(true);
  });

  it('a late about:blank update from the tab-s creation does not cost ownership', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    // The creation event arrives after the open completed, as it can in Chrome.
    await authority.onTabUpdated(session.target.tabId as number, 'about:blank');
    const [current] = await authority.all();
    expect(current.target.ownership).toBe('owned');
    const ended = await authority.handle(
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: true },
      SOURCE
    );
    expect(ended.targetClosed).toBe(true);
    expect(browser.removed).toEqual([session.target.tabId]);
  });

  it('a tab that moved to a second conversation or off the provider is never closed', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const first = await openSession(authority);
    const tabId = first.target.tabId as number;
    await authority.onTabUpdated(tabId, 'https://chatgpt.com/c/temp-1');
    let [current] = await authority.all();
    expect(current.target.ownership).toBe('owned');
    await authority.onTabUpdated(tabId, 'https://chatgpt.com/c/someone-elses-chat');
    [current] = await authority.all();
    expect(current.target.ownership).toBe('uncertain');
    const ended = await authority.handle(
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: first.sessionId, closeTarget: true },
      SOURCE
    );
    expect(ended.ok).toBe(true);
    expect(ended.targetClosed).toBe(false);
    expect(browser.removed).toEqual([]);

    const second = await openSession(authority);
    await authority.onTabUpdated(second.target.tabId as number, 'https://example.com/elsewhere');
    const [offsite] = await authority.all();
    expect(offsite.target.ownership).toBe('uncertain');

    const third = await openSession(authority);
    await authority.onTabReplaced(999, third.target.tabId as number);
    const replaced = (await authority.all()).find((session) => session.sessionId === third.sessionId);
    expect(replaced?.target).toMatchObject({ tabId: 999, ownership: 'uncertain' });
  });

  it('clears local material even when closing the tab fails', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    browser.failRemove = true;
    const ended = await authority.handle(
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: true },
      SOURCE
    );
    expect(ended.ok).toBe(true);
    expect(ended.targetClosed).toBe(false);
    expect(await authority.all()).toEqual([]);
    expect(area.data.size).toBe(0);
  });

  it('End without closing keeps the native tab and still clears everything local', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    const ended = await authority.handle(
      { type: 'HANDOFF_END', buildId: BUILD, sessionId: session.sessionId, closeTarget: false },
      SOURCE
    );
    expect(ended.targetClosed).toBe(false);
    expect(browser.removed).toEqual([]);
    expect(area.data.size).toBe(0);
  });

  it('Return focuses the source tab and reports how the passage was found', async () => {
    const { env, browser } = makeEnv(area);
    browser.anchorReply = 'ambiguous';
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    browser.focused = [];
    const back = await authority.handle({ type: 'HANDOFF_RETURN', buildId: BUILD, sessionId: session.sessionId }, POPUP);
    expect(back.ok).toBe(true);
    expect(back.anchor).toBe('ambiguous');
    expect(browser.focused).toEqual([1]);
  });

  it('Arrange moves only the window Aside created, never the source window', async () => {
    const { env, browser } = makeEnv(area);
    const authority = new HandoffAuthority(env);
    const session = await openSession(authority);
    const sourceBefore = { ...browser.windows.get(1) };
    const arranged = await authority.handle({ type: 'HANDOFF_ARRANGE', buildId: BUILD, sessionId: session.sessionId }, SOURCE);
    expect(arranged.ok).toBe(true);
    expect(browser.windows.get(1)).toEqual(sourceBefore);
    expect(browser.windows.get(session.target.windowId as number)).toMatchObject({ left: 700, width: 700, height: 900 });

    (browser.windows.get(1) as { state: string }).state = 'fullscreen';
    const skipped = await authority.handle({ type: 'HANDOFF_ARRANGE', buildId: BUILD, sessionId: session.sessionId }, SOURCE);
    expect(skipped.code).toBe('unsupported-layout');
  });
});

describe('scratch handoff authority: explicit local note', () => {
  it('commits only through the storage authority, and leaves the scratch a scratch', async () => {
    const saved: Array<{ note: string; excerpt: string }> = [];
    const { env } = makeEnv(area, async (_session, input) => {
      saved.push(input);
      return { questionId: 'q-1' };
    });
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const response = await authority.handle(
      { type: 'HANDOFF_SAVE_NOTE', buildId: BUILD, sessionId: session.sessionId, note: 'my note', excerpt: '', title: 'Why?', sourceTitle: 'Src' },
      SOURCE
    );
    expect(response.ok).toBe(true);
    expect(response.questionId).toBe('q-1');
    expect(saved).toEqual([{ note: 'my note', excerpt: '', title: 'Why?', sourceTitle: 'Src' }]);
    expect((await authority.all())[0].policy).toBe('temporary-intended');
  });

  it('reports a failed commit as a failure and saves nothing', async () => {
    const { env } = makeEnv(area, async () => {
      throw new Error('transaction aborted');
    });
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const response = await authority.handle(
      { type: 'HANDOFF_SAVE_NOTE', buildId: BUILD, sessionId: session.sessionId, note: 'n', excerpt: '', title: 't', sourceTitle: '' },
      SOURCE
    );
    expect(response.ok).toBe(false);
    expect(response.code).toBe('save-failed');
  });

  it('refuses an empty note', async () => {
    const { env } = makeEnv(area, async () => ({ questionId: 'never' }));
    const authority = new HandoffAuthority(env);
    const session = await created(authority);
    const response = await authority.handle(
      { type: 'HANDOFF_SAVE_NOTE', buildId: BUILD, sessionId: session.sessionId, note: '  ', excerpt: '', title: 't', sourceTitle: '' },
      SOURCE
    );
    expect(response.code).toBe('invalid-request');
  });
});

describe('conversation paths', () => {
  it('recognises provider conversation paths and nothing else', () => {
    expect(conversationPathOf('https://chatgpt.com/c/abc-1')).toBe('/c/abc-1');
    expect(conversationPathOf('https://chatgpt.com/g/g-p-x/c/abc-1')).toBe('/g/g-p-x/c/abc-1');
    expect(conversationPathOf('https://claude.ai/chat/uuid-1')).toBe('/chat/uuid-1');
    expect(conversationPathOf('https://chatgpt.com/?temporary-chat=true')).toBeNull();
    expect(conversationPathOf('https://claude.ai/new')).toBeNull();
  });
});
