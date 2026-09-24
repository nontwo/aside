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
import type { PanelRecord, PanelStorageArea, StoreSnapshot } from '../shared/panel-store';
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

const EMPTY_SNAPSHOT: StoreSnapshot = { records: {}, tombstones: {} };

/**
 * Read one storage area, or null if the read failed.
 *
 * Null is not the same as empty. The whole conflict model is decided against
 * what is already stored: if the read failed and we treated it as an empty
 * store, a stale write would be applied over a newer record (a silent lost
 * update) and a tombstone would be missed, resurrecting a panel the user
 * closed. A failed read must fail the write instead.
 */
async function readArea(area: PanelStorageArea): Promise<StoreSnapshot | null> {
  const api = areaApi(area);
  if (!api) {
    // Session storage genuinely absent is a known, reported condition rather
    // than a read failure; there is nothing stored to lose.
    return area === 'session' ? EMPTY_SNAPSHOT : null;
  }

  try {
    return readSnapshot((await api.get(null)) as Record<string, unknown>);
  } catch {
    return null;
  }
}

interface AreaSnapshots {
  local: StoreSnapshot;
  session: StoreSnapshot;
  /**
   * Tombstones live in local storage even for session-area panels, so closing a
   * private branch in one tab is still honoured by a tab that has it mounted.
   */
  tombstones: StoreSnapshot['tombstones'];
}

async function readBothAreas(): Promise<AreaSnapshots | null> {
  const [local, session] = await Promise.all([readArea('local'), readArea('session')]);
  if (!local || !session) {
    return null;
  }
  return { local, session, tombstones: { ...session.tombstones, ...local.tombstones } };
}

const STORAGE_READ_FAILED = {
  ok: false,
  status: 'error' as const,
  unsaved: true,
  reason: 'Could not read extension storage, so this write was not attempted.'
};

/**
 * The record for a panel, wherever it currently lives.
 *
 * A panel switched between Persistent and Private changes storage area. Its
 * identity and revision line must not: if each area kept its own counter, the
 * same panel would exist twice, restore would pick one arbitrarily (reverting
 * the user's privacy choice and leaving the content on disk), and the stale-write
 * check would stop working because the two counters disagree.
 */
function currentRecord(areas: AreaSnapshots, panelId: string) {
  const candidates = [areas.local.records[panelId], areas.session.records[panelId]].filter(
    (record): record is NonNullable<typeof record> => Boolean(record)
  );
  return candidates.sort((left, right) => right.rev - left.rev)[0];
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

    const areas = await readBothAreas();
    if (!areas) {
      return STORAGE_READ_FAILED;
    }

    const otherArea: PanelStorageArea = message.area === 'local' ? 'session' : 'local';
    const existing = currentRecord(areas, message.panelId);
    const movingArea = Boolean(existing) && existing.area !== message.area;

    const snapshot: StoreSnapshot = {
      records: existing
        ? { ...areas[message.area].records, [message.panelId]: existing }
        : areas[message.area].records,
      tombstones: areas.tombstones
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

    // The panel moved between durable and session storage: remove the copy it
    // left behind, so a restore cannot resurrect the previous privacy choice.
    if (movingArea) {
      const previous = areaApi(otherArea);
      if (previous) {
        try {
          await previous.remove(panelRecordKey(record.panelId));
        } catch {
          // Leaving a duplicate is bad but not worth failing a saved write over;
          // handlePanelList prefers the newest revision, which is this one.
        }
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
    const areas = await readBothAreas();
    if (!areas) {
      return STORAGE_READ_FAILED;
    }
    const combined: StoreSnapshot = {
      records: { ...areas.session.records, ...areas.local.records },
      tombstones: areas.tombstones
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
  const areas = await readBothAreas();
  if (!areas) {
    return { ok: false, records: [], sessionUnavailable: areaApi('session') === null };
  }
  const tombstones = areas.tombstones;
  const sessionUnavailable = areaApi('session') === null;

  // One entry per panel even if a stale duplicate survives in the other area:
  // the newest revision is the one the user last chose.
  const byPanelId = new Map<string, PanelRecord>();
  [...Object.values(areas.local.records), ...Object.values(areas.session.records)].forEach(
    (record) => {
      const seen = byPanelId.get(record.panelId);
      if (!seen || record.rev > seen.rev) {
        byPanelId.set(record.panelId, record);
      }
    }
  );

  const records = [...byPanelId.values()]
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
  return approximateByteSize((await readArea('local')) ?? EMPTY_SNAPSHOT);
}
