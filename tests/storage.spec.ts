import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LEGACY_STORAGE_KEY, STORAGE_KEY } from '../src/shared/constants';
import { createInitialState, loadState, saveState } from '../src/shared/storage';

function installStorageMock(store: Record<string, unknown>) {
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (typeof keys === 'string') {
            return { [keys]: store[keys] };
          }

          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, store[key]]));
          }

          return { ...store };
        }),
        set: vi.fn(async (values) => {
          Object.assign(store, values);
        })
      }
    }
  } as unknown as typeof chrome;
}

describe('shared storage helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates legacy state into the Aside storage key', async () => {
    const legacyState = createInitialState();
    legacyState.settings.maxConcurrentRunners = 5;
    const store: Record<string, unknown> = {
      [LEGACY_STORAGE_KEY]: legacyState
    };
    installStorageMock(store);

    const loaded = await loadState();

    expect(loaded.settings.maxConcurrentRunners).toBe(5);
    expect(store[STORAGE_KEY]).toEqual(legacyState);
  });

  it('saves state under the Aside storage key', async () => {
    const state = createInitialState();
    state.settings.maxConcurrentRunners = 3;
    const store: Record<string, unknown> = {};
    installStorageMock(store);

    await saveState(state);

    expect(store[STORAGE_KEY]).toEqual(state);
  });
});
