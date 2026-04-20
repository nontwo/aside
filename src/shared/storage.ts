import {
  DEFAULT_MAX_CONCURRENT_RUNNERS,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY
} from './constants';
import type { ExtensionState } from './types';

const NON_TERMINAL_STATES = new Set([
  'queued',
  'acquiring_runner',
  'branching_local',
  'sending',
  'streaming'
]);

export function createInitialState(): ExtensionState {
  return {
    branches: {},
    conversations: {},
    tabConversations: {},
    settings: {
      maxConcurrentRunners: DEFAULT_MAX_CONCURRENT_RUNNERS
    }
  };
}

export async function loadState(): Promise<ExtensionState> {
  const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  const migratedState =
    (stored[STORAGE_KEY] as ExtensionState | undefined) ??
    (stored[LEGACY_STORAGE_KEY] as ExtensionState | undefined) ??
    createInitialState();

  if (!stored[STORAGE_KEY] && stored[LEGACY_STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: migratedState });
  }

  const state = migratedState;

  Object.values(state.branches).forEach((branch) => {
    if (NON_TERMINAL_STATES.has(branch.runState)) {
      branch.runState = 'failed';
      branch.runnerTabId = undefined;
      branch.errorMessage = 'Branch generation was interrupted. Resend the question to retry.';
      branch.statusLabel = 'Interrupted';
    }
  });

  return state;
}

export async function saveState(state: ExtensionState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}
