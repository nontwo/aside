import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BranchPanelState } from '../src/shared/types';

/**
 * The authority is the only writer, so its behaviour under a failing read and
 * under a panel that changes storage area is what decides whether a user's
 * privacy choice survives and whether a closed panel stays closed. Both were
 * previously only observable through a two-tab browser run.
 */

interface FakeArea {
  data: Record<string, unknown>;
  failRead: boolean;
}

function makeArea(): FakeArea {
  return { data: {}, failRead: false };
}

let local: FakeArea;
let session: FakeArea;
let sessionAvailable: boolean;

function areaStub(area: FakeArea) {
  return {
    get: async () => {
      if (area.failRead) {
        throw new Error('storage unavailable');
      }
      return { ...area.data };
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(area.data, items);
    },
    remove: async (keys: string | string[]) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        delete area.data[key];
      });
    }
  };
}

async function loadAuthority() {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    storage: {
      local: areaStub(local),
      get session() {
        return sessionAvailable ? areaStub(session) : undefined;
      }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined
    }
  });
  return import('../src/background/panel-authority');
}

function makeState(overrides: Partial<BranchPanelState> = {}): BranchPanelState {
  return {
    panelId: 'p1',
    rootConversationId: 'claude:chat:conv-1',
    rootChatUrl: 'https://claude.ai/chat/conv-1',
    selection: {
      rootConversationId: 'claude:chat:conv-1',
      rootChatUrl: 'https://claude.ai/chat/conv-1',
      selectedText: 'passage',
      selectedBlocks: [],
      branchBaseMessageId: 'assistant:1:abc',
      rangeQuotes: { exact: 'passage', prefix: '', suffix: '' },
      fallbackScrollY: 0
    },
    focusPreview: 'passage',
    branchKind: 'persistent',
    entryAction: 'ask',
    surfaceMode: 'native_window',
    creationMode: 'pending',
    title: 'untitled branch',
    titleStatus: 'pending',
    minimized: false,
    status: 'draft',
    statusLabel: 'Ask a focused follow-up.',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

beforeEach(() => {
  local = makeArea();
  session = makeArea();
  sessionAvailable = true;
});

describe('a panel that switches between Persistent and Private', () => {
  it('keeps one record and one revision line, in the area it moved to', async () => {
    const authority = await loadAuthority();

    const created = await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 0,
      state: makeState()
    });
    expect(created.rev).toBe(1);

    // The user clicks Private. The panel now belongs in session storage.
    const switched = await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'session',
      baseRev: 1,
      state: makeState({ branchKind: 'temporary' })
    });

    expect(switched.status).toBe('applied');
    // Continuing the revision line, not starting a second one at 1.
    expect(switched.rev).toBe(2);
    // And the durable copy — which still says Persistent and still holds the
    // selected passage on disk — is gone.
    expect(local.data['aside:panel:p1']).toBeUndefined();
    expect(session.data['aside:panel:p1']).toBeDefined();
  });

  it('lists the panel once, with the choice the user last made', async () => {
    const authority = await loadAuthority();

    // A duplicate left behind by an older build: same panel in both areas.
    local.data['aside:panel:p1'] = {
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      rev: 1,
      updatedAt: 1,
      state: makeState({ branchKind: 'persistent' })
    };
    session.data['aside:panel:p1'] = {
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'session',
      rev: 2,
      updatedAt: 2,
      state: makeState({ branchKind: 'temporary' })
    };

    const listed = await authority.handlePanelList();

    expect(listed.records).toHaveLength(1);
    expect(listed.records[0].state.branchKind).toBe('temporary');
  });

  it('still detects a stale write from another tab across the move', async () => {
    const authority = await loadAuthority();

    await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 0,
      state: makeState()
    });
    await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'session',
      baseRev: 1,
      state: makeState({ branchKind: 'temporary' })
    });

    // Another tab still believes the panel is at rev 1 in local storage.
    const stale = await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 1,
      state: makeState({ title: 'from the stale tab' })
    });

    expect(stale.status).toBe('conflict');
  });
});

describe('a storage read that fails', () => {
  it('fails the write instead of treating the store as empty', async () => {
    const authority = await loadAuthority();

    await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 0,
      state: makeState({ title: 'the real record' })
    });

    local.failRead = true;

    // An empty snapshot would make this stale write look new and apply it over
    // the record above — a silent lost update.
    const outcome = await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 0,
      state: makeState({ title: 'overwrite' })
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('error');
    expect(outcome.unsaved).toBe(true);

    local.failRead = false;
    const stored = local.data['aside:panel:p1'] as { state: BranchPanelState };
    expect(stored.state.title).toBe('the real record');
  });

  it('does not resurrect a deleted panel when the tombstone read fails', async () => {
    const authority = await loadAuthority();

    await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 0,
      state: makeState()
    });
    await authority.handlePanelDelete({ type: 'PANEL_DELETE', panelId: 'p1', baseRev: 1 });
    expect(local.data['aside:gone:p1']).toBeDefined();

    local.failRead = true;
    const resurrect = await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'local',
      baseRev: 1,
      state: makeState()
    });

    expect(resurrect.ok).toBe(false);
    local.failRead = false;
    expect(local.data['aside:panel:p1']).toBeUndefined();
  });
});

describe('when session storage is unavailable', () => {
  it('refuses to keep a private panel rather than writing it to disk', async () => {
    sessionAvailable = false;
    const authority = await loadAuthority();

    const outcome = await authority.handlePanelUpsert({
      type: 'PANEL_UPSERT',
      panelId: 'p1',
      scopeKey: 'claude:chat:conv-1',
      area: 'session',
      baseRev: 0,
      state: makeState({ branchKind: 'temporary' })
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.unsaved).toBe(true);
    expect(Object.keys(local.data)).toEqual([]);
  });

  it('still records a deletion, because tombstones live in durable storage', async () => {
    sessionAvailable = false;
    const authority = await loadAuthority();

    const outcome = await authority.handlePanelDelete({
      type: 'PANEL_DELETE',
      panelId: 'p1',
      baseRev: 3
    });

    expect(outcome.status).toBe('deleted');
    expect(local.data['aside:gone:p1']).toBeDefined();
  });
});
