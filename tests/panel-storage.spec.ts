import { describe, expect, it } from 'vitest';

import { PANEL_STORAGE_PREFIX } from '../src/shared/constants';
import {
  MAX_PANELS_PER_CONVERSATION,
  getPanelStorageKeyForState,
  isPanelStorageKey,
  mergePanelBuckets
} from '../src/shared/panel-storage';
import type { BranchPanelState } from '../src/shared/types';

function makePanel(overrides: Partial<BranchPanelState> & { panelId: string }): BranchPanelState {
  const conversationId = overrides.rootConversationId ?? 'conv-a';
  return {
    rootConversationId: conversationId,
    rootChatUrl: `https://chatgpt.com/c/${conversationId}`,
    selection: {
      rootConversationId: conversationId,
      rootChatUrl: `https://chatgpt.com/c/${conversationId}`,
      selectedText: 'selected passage',
      selectedBlocks: [],
      branchBaseMessageId: 'assistant:1:abc',
      rangeQuotes: { exact: 'selected passage', prefix: '', suffix: '' },
      fallbackScrollY: 0
    },
    focusPreview: 'selected passage',
    branchKind: 'persistent',
    entryAction: 'ask',
    surfaceMode: 'embedded',
    creationMode: 'pending',
    title: 'untitled branch',
    titleStatus: 'pending',
    minimized: false,
    status: 'draft',
    statusLabel: 'Ask a focused follow-up about this selected passage.',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('panel storage keys', () => {
  it('keys a panel by its root conversation id', () => {
    expect(getPanelStorageKeyForState(makePanel({ panelId: 'p1' }))).toBe(
      `${PANEL_STORAGE_PREFIX}conv-a`
    );
  });

  it('falls back to the conversation id parsed out of the chat url', () => {
    const panel = makePanel({ panelId: 'p1' });
    panel.rootConversationId = '';
    panel.rootChatUrl = 'https://chatgpt.com/c/conv-from-url';
    expect(getPanelStorageKeyForState(panel)).toBe(`${PANEL_STORAGE_PREFIX}conv-from-url`);
  });

  it('recognises only its own storage keys', () => {
    expect(isPanelStorageKey(`${PANEL_STORAGE_PREFIX}conv-a`)).toBe(true);
    expect(isPanelStorageKey('aside:last-branch-kind')).toBe(false);
  });
});

describe('mergePanelBuckets', () => {
  it('keeps panels of conversations that are not open in this tab', () => {
    // The regression this guards: a tab showing conversation B mounts none of
    // conversation A's expanded panels, so writing only the mounted set erased them.
    const mounted = [makePanel({ panelId: 'b1', rootConversationId: 'conv-b' })];
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [makePanel({ panelId: 'a1', rootConversationId: 'conv-a' })]
      }
    ];

    const { entries, removableKeys } = mergePanelBuckets(mounted, stored);

    expect(entries[`${PANEL_STORAGE_PREFIX}conv-a`].map((panel) => panel.panelId)).toEqual(['a1']);
    expect(entries[`${PANEL_STORAGE_PREFIX}conv-b`].map((panel) => panel.panelId)).toEqual(['b1']);
    expect(removableKeys).toEqual([]);
  });

  it('lets a mounted panel overwrite its own stored copy', () => {
    const mounted = [makePanel({ panelId: 'a1', title: 'fresh title', titleStatus: 'ready' })];
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [makePanel({ panelId: 'a1', title: 'stale title' })]
      }
    ];

    const { entries } = mergePanelBuckets(mounted, stored);
    const bucket = entries[`${PANEL_STORAGE_PREFIX}conv-a`];

    expect(bucket).toHaveLength(1);
    expect(bucket[0].title).toBe('fresh title');
  });

  it('drops panels the user closed and removes the bucket once it is empty', () => {
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [makePanel({ panelId: 'a1' }), makePanel({ panelId: 'a2' })]
      }
    ];

    const partial = mergePanelBuckets([], stored, ['a1']);
    expect(partial.entries[`${PANEL_STORAGE_PREFIX}conv-a`].map((p) => p.panelId)).toEqual(['a2']);
    expect(partial.removableKeys).toEqual([]);

    const emptied = mergePanelBuckets([], stored, ['a1', 'a2']);
    expect(emptied.entries[`${PANEL_STORAGE_PREFIX}conv-a`]).toBeUndefined();
    expect(emptied.removableKeys).toEqual([`${PANEL_STORAGE_PREFIX}conv-a`]);
  });

  it('orders a merged bucket by creation time', () => {
    const mounted = [makePanel({ panelId: 'newer', createdAt: 30 })];
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [makePanel({ panelId: 'older', createdAt: 10 })]
      }
    ];

    const { entries } = mergePanelBuckets(mounted, stored);
    expect(entries[`${PANEL_STORAGE_PREFIX}conv-a`].map((panel) => panel.panelId)).toEqual([
      'older',
      'newer'
    ]);
  });

  it('ignores malformed stored rows instead of writing them back', () => {
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [{ minimized: true } as unknown as BranchPanelState]
      }
    ];

    const { entries, removableKeys } = mergePanelBuckets([], stored);
    expect(entries[`${PANEL_STORAGE_PREFIX}conv-a`]).toBeUndefined();
    expect(removableKeys).toEqual([`${PANEL_STORAGE_PREFIX}conv-a`]);
  });
});

describe('mergePanelBuckets concurrency and growth', () => {
  it('does not let a stale mounted snapshot undo a newer write from another tab', () => {
    const mounted = [makePanel({ panelId: 'a1', title: 'stale in this tab', updatedAt: 10 })];
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [makePanel({ panelId: 'a1', title: 'newer from other tab', updatedAt: 99 })]
      }
    ];

    const { entries } = mergePanelBuckets(mounted, stored);
    expect(entries[`${PANEL_STORAGE_PREFIX}conv-a`][0].title).toBe('newer from other tab');
  });

  it('still writes an edit this tab made most recently', () => {
    const mounted = [makePanel({ panelId: 'a1', title: 'edited here', updatedAt: 120 })];
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: [makePanel({ panelId: 'a1', title: 'older on disk', updatedAt: 99 })]
      }
    ];

    const { entries } = mergePanelBuckets(mounted, stored);
    expect(entries[`${PANEL_STORAGE_PREFIX}conv-a`][0].title).toBe('edited here');
  });

  it('caps a conversation bucket so storage cannot grow without bound', () => {
    const stored = [
      {
        key: `${PANEL_STORAGE_PREFIX}conv-a`,
        panels: Array.from({ length: MAX_PANELS_PER_CONVERSATION + 10 }, (_unused, index) =>
          makePanel({ panelId: `p${index}`, createdAt: index })
        )
      }
    ];

    const { entries } = mergePanelBuckets([], stored);
    const bucket = entries[`${PANEL_STORAGE_PREFIX}conv-a`];

    expect(bucket).toHaveLength(MAX_PANELS_PER_CONVERSATION);
    // The newest panels are the ones worth keeping.
    expect(bucket.at(-1)?.panelId).toBe(`p${MAX_PANELS_PER_CONVERSATION + 9}`);
  });
});
