import { describe, expect, it } from 'vitest';

import {
  MAX_WRITE_REBASES,
  TOMBSTONE_TTL_MS,
  applyDelete,
  applyUpsert,
  approximateByteSize,
  expiredTombstoneKeys,
  mergePanelStateOnConflict,
  planTrim,
  readSnapshot,
  recordsForScope,
  resolveWriteConflict,
  tombstoneKey
} from '../src/shared/panel-store';
import type { PanelRecord, StoreSnapshot } from '../src/shared/panel-store';
import type { BranchPanelState } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function makeState(overrides: Partial<BranchPanelState> = {}): BranchPanelState {
  return {
    panelId: 'p1',
    rootConversationId: 'chatgpt:c:conv-1',
    rootChatUrl: 'https://chatgpt.com/c/conv-1',
    selection: {
      rootConversationId: 'chatgpt:c:conv-1',
      rootChatUrl: 'https://chatgpt.com/c/conv-1',
      selectedText: 'passage',
      selectedBlocks: [],
      branchBaseMessageId: 'assistant:1:abc',
      rangeQuotes: { exact: 'passage', prefix: '', suffix: '' },
      fallbackScrollY: 0
    },
    focusPreview: 'passage',
    branchKind: 'persistent',
    entryAction: 'ask',
    surfaceMode: 'embedded',
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

function makeRecord(overrides: Partial<PanelRecord> = {}): PanelRecord {
  return {
    panelId: 'p1',
    scopeKey: 'chatgpt:c:conv-1',
    area: 'local',
    rev: 1,
    updatedAt: NOW,
    state: makeState(),
    ...overrides
  };
}

function snapshot(records: PanelRecord[] = [], tombstones: StoreSnapshot['tombstones'] = {}): StoreSnapshot {
  return {
    records: Object.fromEntries(records.map((record) => [record.panelId, record])),
    tombstones
  };
}

describe('per-panel writes', () => {
  it('creates a new record at revision 1', () => {
    const outcome = applyUpsert(snapshot(), {
      panelId: 'p1',
      scopeKey: 'chatgpt:c:conv-1',
      area: 'local',
      state: makeState(),
      baseRev: 0,
      now: NOW
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.status === 'applied' && outcome.record.rev).toBe(1);
  });

  it('advances the revision on an up-to-date write', () => {
    const outcome = applyUpsert(snapshot([makeRecord({ rev: 4 })]), {
      panelId: 'p1',
      scopeKey: 'chatgpt:c:conv-1',
      area: 'local',
      state: makeState({ title: 'newer' }),
      baseRev: 4,
      now: NOW
    });

    expect(outcome.status === 'applied' && outcome.record.rev).toBe(5);
  });

  it('reports a conflict instead of silently overwriting another tab', () => {
    // Tab A read rev 4, tab B has since written rev 5. Tab A's write must not win.
    const outcome = applyUpsert(snapshot([makeRecord({ rev: 5, state: makeState({ title: 'from tab B' }) })]), {
      panelId: 'p1',
      scopeKey: 'chatgpt:c:conv-1',
      area: 'local',
      state: makeState({ title: 'from stale tab A' }),
      baseRev: 4,
      now: NOW
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.status === 'conflict' && outcome.current.state.title).toBe('from tab B');
  });
});

describe('deletion tombstones', () => {
  it('records the deleted revision', () => {
    const outcome = applyDelete(snapshot([makeRecord({ rev: 7 })]), {
      panelId: 'p1',
      baseRev: 7,
      now: NOW
    });

    expect(outcome.status).toBe('deleted');
    expect(outcome.status === 'deleted' && outcome.tombstone.rev).toBe(7);
  });

  it('stops a stale tab from resurrecting a panel closed elsewhere', () => {
    // The regression: tab A closes the panel, tab B still has it mounted and its
    // next write brought it straight back.
    const tombstones = { p1: { panelId: 'p1', deletedAt: NOW, rev: 7 } };

    const outcome = applyUpsert(snapshot([], tombstones), {
      panelId: 'p1',
      scopeKey: 'chatgpt:c:conv-1',
      area: 'local',
      state: makeState(),
      baseRev: 7,
      now: NOW + 1_000
    });

    expect(outcome.status).toBe('rejected-deleted');
  });

  it('rejects resurrection even when the stale writer claims a newer revision', () => {
    const tombstones = { p1: { panelId: 'p1', deletedAt: NOW, rev: 7 } };

    const outcome = applyUpsert(snapshot([], tombstones), {
      panelId: 'p1',
      scopeKey: 'chatgpt:c:conv-1',
      area: 'local',
      state: makeState(),
      baseRev: 99,
      now: NOW + 1_000
    });

    expect(outcome.status).toBe('rejected-deleted');
  });

  it('leaves a tombstone even when the record was already gone', () => {
    const outcome = applyDelete(snapshot(), { panelId: 'p1', baseRev: 3, now: NOW });
    expect(outcome.status).toBe('deleted');
  });

  it('expires tombstones so the store stays bounded', () => {
    const fresh = { panelId: 'p1', deletedAt: NOW, rev: 1 };
    const stale = { panelId: 'p2', deletedAt: NOW - TOMBSTONE_TTL_MS - 1, rev: 1 };
    const store = snapshot([], { p1: fresh, p2: stale });

    expect(expiredTombstoneKeys(store, NOW)).toEqual([tombstoneKey('p2')]);

    // Once expired, the panel id may be used again.
    const outcome = applyUpsert(store, {
      panelId: 'p2',
      scopeKey: 'chatgpt:c:conv-1',
      area: 'local',
      state: makeState({ panelId: 'p2' }),
      baseRev: 0,
      now: NOW
    });
    expect(outcome.status).toBe('applied');
  });
});

describe('reading the store', () => {
  it('ignores malformed rows rather than throwing', () => {
    const store = readSnapshot({
      'aside:panel:p1': makeRecord(),
      'aside:panel:broken': { nope: true },
      'aside:gone:p2': { panelId: 'p2', deletedAt: NOW, rev: 1 },
      'aside:gone:broken': null,
      'aside:last-branch-kind:chatgpt': 'temporary'
    });

    expect(Object.keys(store.records)).toEqual(['p1']);
    expect(Object.keys(store.tombstones)).toEqual(['p2']);
  });

  it('hides tombstoned records from a scope listing', () => {
    const store = snapshot(
      [makeRecord({ panelId: 'p1' }), makeRecord({ panelId: 'p2' })],
      { p2: { panelId: 'p2', deletedAt: NOW, rev: 1 } }
    );

    const visible = recordsForScope(store, () => true).map((record) => record.panelId);
    expect(visible).toEqual(['p1']);
  });
});

describe('byte budget', () => {
  it('drops diagnostics before user content and says when that is not enough', () => {
    const chatty = makeRecord({
      panelId: 'p1',
      state: makeState({ debugLog: Array.from({ length: 200 }, () => 'x'.repeat(200)) })
    });
    const quiet = makeRecord({ panelId: 'p2', state: makeState({ panelId: 'p2' }) });
    const store = snapshot([chatty, quiet]);

    const plan = planTrim(store, Math.floor(approximateByteSize(store) / 2));
    expect(plan.trimLogsFor).toContain('p1');
    expect(plan.stillOverBudget).toBe(false);

    // A budget no amount of log trimming can meet must be reported, not hidden by
    // silently evicting a panel.
    const impossible = planTrim(store, 10);
    expect(impossible.stillOverBudget).toBe(true);
  });

  it('does nothing when already under budget', () => {
    const store = snapshot([makeRecord()]);
    expect(planTrim(store, 10_000_000)).toEqual({ trimLogsFor: [], stillOverBudget: false });
  });
});

describe('write conflict policy', () => {
  // The browser-level outcome depends on how two tabs interleave, which a test
  // should not have to win. The invariant is decided here: text the user typed is
  // never discarded without them seeing it.
  it('re-bases while attempts remain', () => {
    expect(
      resolveWriteConflict({
        localQuestion: 'edited here',
        theirQuestion: 'edited elsewhere',
        attempt: 0
      })
    ).toEqual({ action: 'rebase', question: 'edited here' });
  });

  it('keeps the local text and flags unsaved once re-bases run out', () => {
    expect(
      resolveWriteConflict({
        localQuestion: 'edited here',
        theirQuestion: 'edited elsewhere',
        attempt: MAX_WRITE_REBASES
      })
    ).toEqual({ action: 'keep-local-unsaved', question: 'edited here' });
  });

  it('never adopts over a divergent local edit, at any attempt count', () => {
    for (let attempt = 0; attempt <= MAX_WRITE_REBASES + 5; attempt += 1) {
      const decision = resolveWriteConflict({
        localQuestion: 'mine',
        theirQuestion: 'theirs',
        attempt
      });
      expect(decision.action).not.toBe('adopt');
      expect('question' in decision && decision.question).toBe('mine');
    }
  });

  it('adopts when nothing of the user-s is at stake', () => {
    expect(
      resolveWriteConflict({ localQuestion: 'same', theirQuestion: 'same', attempt: 0 }).action
    ).toBe('adopt');
    expect(
      resolveWriteConflict({ localQuestion: '', theirQuestion: undefined, attempt: 9 }).action
    ).toBe('adopt');
  });
});

describe('merging a panel this tab lost a write for', () => {
  const theirs = makeState({
    branchKind: 'persistent',
    status: 'draft',
    statusLabel: 'Ask a focused follow-up.',
    initialQuestion: 'from the other tab'
  });

  it('never demotes a private branch to persistent', () => {
    // The regression: clicking Private, losing the write to an unrelated save in
    // another tab, and having the toggle silently flip back — with the selected
    // passage still sitting in local storage.
    const merged = mergePanelStateOnConflict({
      local: makeState({ branchKind: 'temporary' }),
      theirs,
      localQuestion: 'from the other tab',
      localDrivesBranch: false
    });

    expect(merged.branchKind).toBe('temporary');
  });

  it('takes a private marking from the other tab too', () => {
    const merged = mergePanelStateOnConflict({
      local: makeState({ branchKind: 'persistent' }),
      theirs: makeState({ branchKind: 'temporary' }),
      localQuestion: '',
      localDrivesBranch: false
    });

    expect(merged.branchKind).toBe('temporary');
  });

  it('keeps the live branch details when this tab is the one running it', () => {
    // Without this, a rebase onto the other tab's older snapshot drops the
    // branchChatUrl — the only route back to a conversation the user may want to
    // delete — while the panel still reads as live.
    const local = makeState({
      status: 'live',
      statusLabel: 'Branch answer is ready.',
      branchChatUrl: 'https://chatgpt.com/c/branch-1',
      attemptId: 'attempt-1',
      surfaceMode: 'native_window',
      launchTabId: 42
    });

    const merged = mergePanelStateOnConflict({
      local,
      theirs,
      localQuestion: 'q',
      localDrivesBranch: true
    });

    expect(merged.status).toBe('live');
    expect(merged.branchChatUrl).toBe('https://chatgpt.com/c/branch-1');
    expect(merged.attemptId).toBe('attempt-1');
    expect(merged.launchTabId).toBe(42);
  });

  it('defers to the authority when this tab is not running the branch', () => {
    const merged = mergePanelStateOnConflict({
      local: makeState({ status: 'live', branchChatUrl: 'https://chatgpt.com/c/stale' }),
      theirs: makeState({ status: 'failed', statusLabel: 'Branch creation failed.' }),
      localQuestion: 'q',
      localDrivesBranch: false
    });

    expect(merged.status).toBe('failed');
  });

  it('keeps a curated context rather than replacing it with nothing', () => {
    const context = {
      revision: 3,
      providerId: 'chatgpt',
      selectedPassage: 'passage',
      anchorText: 'passage',
      sourceLabel: 'conv-1',
      blocks: [],
      userBackground: 'my notes'
    };

    const merged = mergePanelStateOnConflict({
      local: makeState({ context }),
      theirs,
      localQuestion: 'q',
      localDrivesBranch: false
    });

    expect(merged.context).toEqual(context);
  });

  it('always keeps the text in this tab-s box', () => {
    const merged = mergePanelStateOnConflict({
      local: makeState({ initialQuestion: 'half a sentence' }),
      theirs,
      localQuestion: 'half a sentence',
      localDrivesBranch: false
    });

    expect(merged.initialQuestion).toBe('half a sentence');
  });
});
