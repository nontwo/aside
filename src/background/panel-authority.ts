import {
  applyDelete,
  applyUpsert,
  approximateByteSize,
  expiredTombstoneKeys,
  panelRecordKey,
  planTrim,
  readSnapshot,
  tombstoneKey
} from '../shared/panel-store';
import type { PanelStorageArea, StoreSnapshot } from '../shared/panel-store';
import { ALL_PROVIDER_ORIGINS } from '../shared/providers/origins';
import type {
  PanelChangedMessage,
  PanelDeleteMessage,
  PanelListResponse,
  PanelUpsertMessage,
  PanelWriteResponse
} from '../shared/types';

/**
 * The single authoritative writer for panel records.
 *
 * Every tab proposes changes here instead of reading, merging and rewriting the
 * whole store itself. Writes are serialized through one promise chain so two
 * messages arriving together cannot interleave a read-modify-write.
 */

/** Total durable budget for panel records before diagnostics are trimmed. */
const LOCAL_BUDGET_BYTES = 4 * 1024 * 1024;
/** Per-record ceiling, so one runaway panel cannot consume the budget alone. */
const RECORD_BUDGET_BYTES = 256 * 1024;

let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writeChain.then(operation, operation);
  // Keep the chain alive regardless of individual failures.
  writeChain = next.catch(() => undefined);
  return next;
}

function areaApi(area: PanelStorageArea): chrome.storage.StorageArea | null {
  if (area === 'session') {
    return chrome.storage.session ?? null;
  }
  return chrome.storage.local;
}

async function readArea(area: PanelStorageArea): Promise<StoreSnapshot> {
  const api = areaApi(area);
  if (!api) {
    return { records: {}, tombstones: {} };
  }

  try {
    return readSnapshot((await api.get(null)) as Record<string, unknown>);
  } catch {
    return { records: {}, tombstones: {} };
  }
}

/**
 * Tombstones live in local storage even for session-area panels, so closing a
 * private branch in one tab is still honoured by a tab that has it mounted.
 */
async function readTombstones(): Promise<StoreSnapshot['tombstones']> {
  const [local, session] = await Promise.all([readArea('local'), readArea('session')]);
  return { ...session.tombstones, ...local.tombstones };
}

async function broadcastPanelChange(message: PanelChangedMessage): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: ALL_PROVIDER_ORIGINS.map((origin) => `${origin}/*`) });
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // A tab without a listener yet is not an error.
      }
    })
  );
}

export async function handlePanelUpsert(message: PanelUpsertMessage): Promise<PanelWriteResponse> {
  return serialize(async () => {
    const api = areaApi(message.area);
    if (!api) {
      return {
        ok: false,
        status: 'error' as const,
        unsaved: true,
        reason:
          'Private branches need session storage, which this browser did not make available.'
      };
    }

    const areaSnapshot = await readArea(message.area);
    const snapshot: StoreSnapshot = {
      records: areaSnapshot.records,
      tombstones: await readTombstones()
    };

    const now = Date.now();
    const outcome = applyUpsert(snapshot, {
      panelId: message.panelId,
      scopeKey: message.scopeKey,
      area: message.area,
      state: message.state,
      baseRev: message.baseRev,
      now
    });

    if (outcome.status === 'conflict') {
      return {
        ok: false,
        status: 'conflict' as const,
        current: {
          panelId: outcome.current.panelId,
          scopeKey: outcome.current.scopeKey,
          area: outcome.current.area,
          rev: outcome.current.rev,
          state: outcome.current.state
        }
      };
    }

    if (outcome.status === 'rejected-deleted') {
      return { ok: false, status: 'rejected-deleted' as const };
    }

    if (outcome.status !== 'applied') {
      return { ok: true, status: 'noop' as const };
    }

    let record = outcome.record;

    // One panel must not be able to eat the whole budget with diagnostics.
    if (JSON.stringify(record).length > RECORD_BUDGET_BYTES) {
      record = { ...record, state: { ...record.state, debugLog: ['(log trimmed: record too large)'] } };
    }

    try {
      await api.set({ [panelRecordKey(record.panelId)]: record });
    } catch (error) {
      // Try to make room from diagnostics before reporting failure, and never
      // evict another panel's content to do it.
      const plan = planTrim({ ...snapshot, records: { ...snapshot.records, [record.panelId]: record } }, LOCAL_BUDGET_BYTES);
      const trimmed: Record<string, unknown> = {};
      plan.trimLogsFor
        .filter((panelId) => panelId !== record.panelId)
        .forEach((panelId) => {
          const existing = snapshot.records[panelId];
          if (existing) {
            trimmed[panelRecordKey(panelId)] = {
              ...existing,
              state: { ...existing.state, debugLog: ['(log trimmed to stay within the storage budget)'] }
            };
          }
        });

      try {
        if (Object.keys(trimmed).length) {
          await api.set(trimmed);
        }
        await api.set({ [panelRecordKey(record.panelId)]: record });
      } catch (retryError) {
        return {
          ok: false,
          status: 'error' as const,
          unsaved: true,
          reason: retryError instanceof Error ? retryError.message : String(error)
        };
      }
    }

    // Housekeeping: drop expired tombstones so the store stays bounded.
    const expired = expiredTombstoneKeys(snapshot, now);
    if (expired.length) {
      try {
        await chrome.storage.local.remove(expired);
      } catch {
        // Not fatal.
      }
    }

    void broadcastPanelChange({
      type: 'PANEL_CHANGED',
      panelId: record.panelId,
      scopeKey: record.scopeKey,
      rev: record.rev,
      deleted: false,
      state: record.state
    });

    return { ok: true, status: 'applied' as const, rev: record.rev };
  });
}

export async function handlePanelDelete(message: PanelDeleteMessage): Promise<PanelWriteResponse> {
  return serialize(async () => {
    const [local, session] = await Promise.all([readArea('local'), readArea('session')]);
    const combined: StoreSnapshot = {
      records: { ...session.records, ...local.records },
      tombstones: { ...session.tombstones, ...local.tombstones }
    };

    const outcome = applyDelete(combined, {
      panelId: message.panelId,
      baseRev: message.baseRev,
      now: Date.now()
    });

    if (outcome.status !== 'deleted') {
      return { ok: true, status: 'noop' as const };
    }

    // The tombstone always goes to durable storage, even for a private branch:
    // remembering that something was closed is not the same as remembering it.
    try {
      await chrome.storage.local.set({ [tombstoneKey(message.panelId)]: outcome.tombstone });
    } catch {
      return { ok: false, status: 'error' as const, unsaved: true };
    }

    await Promise.all(
      (['local', 'session'] as PanelStorageArea[]).map(async (area) => {
        const api = areaApi(area);
        if (!api) {
          return;
        }
        try {
          await api.remove(panelRecordKey(message.panelId));
        } catch {
          // Already gone.
        }
      })
    );

    void broadcastPanelChange({
      type: 'PANEL_CHANGED',
      panelId: message.panelId,
      scopeKey: combined.records[message.panelId]?.scopeKey ?? '',
      rev: outcome.tombstone.rev,
      deleted: true
    });

    return { ok: true, status: 'deleted' as const };
  });
}

export async function handlePanelList(): Promise<PanelListResponse> {
  const [local, session] = await Promise.all([readArea('local'), readArea('session')]);
  const tombstones = { ...session.tombstones, ...local.tombstones };
  const sessionUnavailable = areaApi('session') === null;

  const records = [...Object.values(local.records), ...Object.values(session.records)]
    .filter((record) => !tombstones[record.panelId])
    .sort((left, right) => (left.state.createdAt ?? 0) - (right.state.createdAt ?? 0))
    .map((record) => ({
      panelId: record.panelId,
      scopeKey: record.scopeKey,
      area: record.area,
      rev: record.rev,
      state: record.state
    }));

  return { ok: true, records, sessionUnavailable };
}

/** Diagnostic used by tests and the migration path. */
export async function storeByteSize(): Promise<number> {
  return approximateByteSize(await readArea('local'));
}
