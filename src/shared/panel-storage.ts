import { PANEL_STORAGE_PREFIX } from './constants';
import type { BranchPanelState } from './types';
import { CATCH_ALL_CONVERSATION_ID, getRootConversationId } from './utils';

export interface PersistedPanelBucket {
  key: string;
  panels: BranchPanelState[];
}

export interface PanelBucketMerge {
  entries: Record<string, BranchPanelState[]>;
  removableKeys: string[];
}

// Nothing else prunes chrome.storage.local now that a write no longer deletes buckets it
// does not own, and each panel carries up to 250 debug-log lines. Keep the newest panels
// per conversation so a long-lived profile cannot grow without bound.
export const MAX_PANELS_PER_CONVERSATION = 40;

export function getPanelStorageKeyForConversationId(conversationId: string): string {
  return `${PANEL_STORAGE_PREFIX}${conversationId}`;
}

export function getPanelStorageKeyForState(
  state: Pick<BranchPanelState, 'rootConversationId' | 'rootChatUrl'>
): string {
  return getPanelStorageKeyForConversationId(
    state.rootConversationId || getRootConversationId(state.rootChatUrl)
  );
}

export function isPanelStorageKey(key: string): boolean {
  return key.startsWith(PANEL_STORAGE_PREFIX);
}

// The catch-all bucket is not one conversation: it holds panels from the new-chat home,
// project homes, /share links and temporary chats alike. Its panels are still kept, but
// they belong in the minimized rail rather than springing open on every such page.
export function isCatchAllPanelStorageKey(key: string): boolean {
  return key === getPanelStorageKeyForConversationId(CATCH_ALL_CONVERSATION_ID);
}

/**
 * A tab only mounts the panels of the conversation in view plus minimized panels from
 * other chats, so persisting just the mounted set deletes every panel the user left
 * expanded in a conversation they navigated away from. Merge the mounted panels over
 * what is already stored, keep anything this tab does not own, and drop a stored panel
 * only when it was explicitly closed.
 */
export function mergePanelBuckets(
  mounted: BranchPanelState[],
  stored: PersistedPanelBucket[],
  closedPanelIds: Iterable<string> = []
): PanelBucketMerge {
  const closed = new Set(closedPanelIds);

  const mountedByKey = new Map<string, BranchPanelState[]>();
  mounted.forEach((panel) => {
    const key = getPanelStorageKeyForState(panel);
    const bucket = mountedByKey.get(key) ?? [];
    bucket.push(panel);
    mountedByKey.set(key, bucket);
  });

  const storedByKey = new Map(stored.map((bucket) => [bucket.key, bucket.panels ?? []]));

  const entries: Record<string, BranchPanelState[]> = {};
  const removableKeys: string[] = [];

  new Set([...mountedByKey.keys(), ...storedByKey.keys()]).forEach((key) => {
    const live = mountedByKey.get(key) ?? [];
    const liveById = new Map(live.map((panel) => [panel.panelId, panel]));
    const stored = (storedByKey.get(key) ?? []).filter(
      (panel) => Boolean(panel?.panelId) && !closed.has(panel.panelId)
    );

    const resolved: BranchPanelState[] = [];
    const seen = new Set<string>();

    stored.forEach((panel) => {
      seen.add(panel.panelId);
      const mounted = liveById.get(panel.panelId);
      if (!mounted) {
        // Belongs to another conversation or another tab: keep it exactly as stored.
        resolved.push(panel);
        return;
      }

      // Another tab may have written a newer version of a panel this tab also holds.
      // Letting the mounted snapshot win unconditionally would undo that edit.
      resolved.push((mounted.updatedAt ?? 0) >= (panel.updatedAt ?? 0) ? mounted : panel);
    });

    live.forEach((panel) => {
      if (!seen.has(panel.panelId)) {
        resolved.push(panel);
      }
    });

    const merged = resolved
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
      .slice(-MAX_PANELS_PER_CONVERSATION);

    if (merged.length) {
      entries[key] = merged;
    } else if (storedByKey.has(key)) {
      removableKeys.push(key);
    }
  });

  return { entries, removableKeys };
}
