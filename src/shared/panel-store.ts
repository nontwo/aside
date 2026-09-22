import type { BranchPanelState } from './types';

/**
 * Per-panel storage protocol with revisions and deletion tombstones.
 *
 * The previous design read the whole panel namespace, merged it in the tab, and
 * wrote it back. Two tabs doing that lose each other's updates, and a panel deleted
 * in one tab is resurrected by the next write from a tab that still had it. Neither
 * a per-tab promise queue nor an updatedAt comparison fixes that, because both sides
 * are writing a stale snapshot of the whole store.
 *
 * Instead: each panel is its own record carrying a monotonic `rev`. A writer sends
 * the `rev` it read; the authority rejects the write if the record has moved on.
 * Deletions leave a tombstone so a stale writer cannot bring the record back.
 *
 * This module is pure — it takes the current records and a request and returns the
 * decision plus the writes to apply — so the conflict rules are unit-tested rather
 * than inferred from browser behaviour.
 */

export const PANEL_RECORD_PREFIX = 'aside:panel:';
export const TOMBSTONE_PREFIX = 'aside:gone:';

/** How long a deletion is remembered. Long enough to outlive any stale client. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type PanelStorageArea = 'local' | 'session';

export interface PanelRecord {
  panelId: string;
  scopeKey: string;
  area: PanelStorageArea;
  rev: number;
  updatedAt: number;
  state: BranchPanelState;
}

export interface Tombstone {
  panelId: string;
  deletedAt: number;
  /** The revision that was deleted, so a stale write is recognisably older. */
  rev: number;
}

export interface StoreSnapshot {
  records: Record<string, PanelRecord>;
  tombstones: Record<string, Tombstone>;
}

export type WriteOutcome =
  | { status: 'applied'; record: PanelRecord }
  | { status: 'deleted'; tombstone: Tombstone }
  | { status: 'conflict'; current: PanelRecord }
  | { status: 'rejected-deleted'; tombstone: Tombstone }
  | { status: 'noop' };

export interface UpsertRequest {
  panelId: string;
  scopeKey: string;
  area: PanelStorageArea;
  state: BranchPanelState;
  /** Revision the writer last saw. 0 means "I believe this is new". */
  baseRev: number;
  now: number;
}

export interface DeleteRequest {
  panelId: string;
  baseRev: number;
  now: number;
}

export function panelRecordKey(panelId: string): string {
  return `${PANEL_RECORD_PREFIX}${panelId}`;
}

export function tombstoneKey(panelId: string): string {
  return `${TOMBSTONE_PREFIX}${panelId}`;
}

export function isPanelRecordKey(key: string): boolean {
  return key.startsWith(PANEL_RECORD_PREFIX);
}

export function isTombstoneKey(key: string): boolean {
  return key.startsWith(TOMBSTONE_PREFIX);
}

/**
 * Decide the outcome of one panel write.
 *
 * Rules, in order:
 *  1. a live tombstone wins — a deleted panel stays deleted;
 *  2. a write whose baseRev is behind the stored rev is a conflict, never a
 *     silent overwrite, so the caller can reconcile rather than clobber;
 *  3. otherwise the record is written at rev + 1.
 */
export function applyUpsert(snapshot: StoreSnapshot, request: UpsertRequest): WriteOutcome {
  const tombstone = snapshot.tombstones[request.panelId];
  if (tombstone && !isTombstoneExpired(tombstone, request.now)) {
    return { status: 'rejected-deleted', tombstone };
  }

  const existing = snapshot.records[request.panelId];
  if (existing && request.baseRev < existing.rev) {
    return { status: 'conflict', current: existing };
  }

  const rev = (existing?.rev ?? 0) + 1;
  return {
    status: 'applied',
    record: {
      panelId: request.panelId,
      scopeKey: request.scopeKey,
      area: request.area,
      rev,
      updatedAt: request.now,
      state: request.state
    }
  };
}

export function applyDelete(snapshot: StoreSnapshot, request: DeleteRequest): WriteOutcome {
  const existing = snapshot.records[request.panelId];
  const tombstone = snapshot.tombstones[request.panelId];

  if (!existing) {
    // Deleting something already gone is not an error, but it must still leave a
    // tombstone so a tab that has the record cannot write it back.
    if (tombstone && !isTombstoneExpired(tombstone, request.now)) {
      return { status: 'noop' };
    }
    return {
      status: 'deleted',
      tombstone: { panelId: request.panelId, deletedAt: request.now, rev: request.baseRev }
    };
  }

  return {
    status: 'deleted',
    tombstone: { panelId: request.panelId, deletedAt: request.now, rev: existing.rev }
  };
}

export function isTombstoneExpired(tombstone: Tombstone, now: number): boolean {
  return now - tombstone.deletedAt > TOMBSTONE_TTL_MS;
}

/** Tombstones that may be dropped, keeping the store bounded. */
export function expiredTombstoneKeys(snapshot: StoreSnapshot, now: number): string[] {
  return Object.values(snapshot.tombstones)
    .filter((tombstone) => isTombstoneExpired(tombstone, now))
    .map((tombstone) => tombstoneKey(tombstone.panelId));
}

/** Records visible to a given scope, newest-created last. */
export function recordsForScope(
  snapshot: StoreSnapshot,
  predicate: (record: PanelRecord) => boolean
): PanelRecord[] {
  return Object.values(snapshot.records)
    .filter((record) => !snapshot.tombstones[record.panelId])
    .filter(predicate)
    .sort((left, right) => (left.state.createdAt ?? 0) - (right.state.createdAt ?? 0));
}

/** Parse a raw storage bag into a snapshot, ignoring anything malformed. */
export function readSnapshot(raw: Record<string, unknown>): StoreSnapshot {
  const records: Record<string, PanelRecord> = {};
  const tombstones: Record<string, Tombstone> = {};

  Object.entries(raw).forEach(([key, value]) => {
    if (isPanelRecordKey(key)) {
      const record = value as PanelRecord | undefined;
      if (record?.panelId && record.state && typeof record.rev === 'number') {
        records[record.panelId] = record;
      }
      return;
    }

    if (isTombstoneKey(key)) {
      const tombstone = value as Tombstone | undefined;
      if (tombstone?.panelId && typeof tombstone.deletedAt === 'number') {
        tombstones[tombstone.panelId] = tombstone;
      }
    }
  });

  return { records, tombstones };
}

/**
 * Total bytes the store occupies, used to enforce a byte budget rather than a
 * per-conversation record count.
 */
export function approximateByteSize(snapshot: StoreSnapshot): number {
  return Object.values(snapshot.records).reduce(
    (total, record) => total + JSON.stringify(record).length,
    0
  );
}

export interface TrimPlan {
  /** Panels whose diagnostics should be dropped, largest first. */
  trimLogsFor: string[];
  /** True when trimming diagnostics alone cannot get under the budget. */
  stillOverBudget: boolean;
}

/**
 * Plan how to get back under a byte budget without discarding user content:
 * diagnostics go first, and the caller is told when that is not enough rather
 * than silently evicting a panel the user still needs.
 */
export function planTrim(snapshot: StoreSnapshot, budgetBytes: number): TrimPlan {
  if (approximateByteSize(snapshot) <= budgetBytes) {
    return { trimLogsFor: [], stillOverBudget: false };
  }

  const byLogSize = Object.values(snapshot.records)
    .map((record) => ({
      panelId: record.panelId,
      logBytes: JSON.stringify(record.state.debugLog ?? []).length
    }))
    .filter((entry) => entry.logBytes > 2)
    .sort((left, right) => right.logBytes - left.logBytes);

  let projected = approximateByteSize(snapshot);
  const trimLogsFor: string[] = [];
  for (const entry of byLogSize) {
    if (projected <= budgetBytes) {
      break;
    }
    trimLogsFor.push(entry.panelId);
    projected -= entry.logBytes;
  }

  return { trimLogsFor, stillOverBudget: projected > budgetBytes };
}

/** Optimistic concurrency needs a few goes: another tab saving is routine. */
export const MAX_WRITE_REBASES = 3;

export type ConflictAction =
  /** Re-base onto their record, keeping the field the user edits, and write again. */
  | { action: 'rebase'; question: string }
  /** Out of attempts with unsaved text: keep it locally and show the panel unsaved. */
  | { action: 'keep-local-unsaved'; question: string }
  /** Nothing of the user's is at stake; take their version. */
  | { action: 'adopt' };

/**
 * What a tab should do when the authority rejects its write as stale.
 *
 * Pure so the policy can be tested directly: the browser-level behaviour depends
 * on how two tabs interleave, which is exactly what a test should not have to win.
 *
 * The invariant: text the user typed is never discarded without them seeing it.
 * Either it is written, or it stays in the box and the panel reads as unsaved.
 */
export function resolveWriteConflict(input: {
  localQuestion: string;
  theirQuestion: string | undefined;
  attempt: number;
  maxRebases?: number;
}): ConflictAction {
  const maxRebases = input.maxRebases ?? MAX_WRITE_REBASES;
  const diverged = (input.theirQuestion ?? '') !== input.localQuestion;

  if (!diverged) {
    return { action: 'adopt' };
  }

  if (input.attempt < maxRebases) {
    return { action: 'rebase', question: input.localQuestion };
  }

  return { action: 'keep-local-unsaved', question: input.localQuestion };
}

/**
 * Merge this tab's panel state with the authoritative record it lost to.
 *
 * Taking the other tab's record wholesale is lossy in three ways that the user
 * notices: a branch marked Private silently reverts to Persistent (and its
 * content stays on disk), a live branch loses the `branchChatUrl` that is the
 * only way back to the conversation it opened, and a curated context is replaced
 * by whatever the other tab happened to have.
 *
 * So: the authority decides the record, this tab keeps the parts only it knows.
 */
export function mergePanelStateOnConflict(input: {
  local: BranchPanelState;
  theirs: BranchPanelState;
  localQuestion: string;
  /** True when this tab is the one actually running the branch. */
  localDrivesBranch: boolean;
}): BranchPanelState {
  const { local, theirs, localDrivesBranch } = input;

  const merged: BranchPanelState = {
    ...theirs,
    // The text in this tab's box is what its user is looking at.
    initialQuestion: input.localQuestion,
    // Privacy never resolves downwards. Re-marking a branch private costs a
    // click; a branch silently demoted to persistent has already written to disk.
    branchKind:
      local.branchKind === 'temporary' || theirs.branchKind === 'temporary'
        ? 'temporary'
        : theirs.branchKind
  };

  // The assembled context belongs to the tab that assembled it, and a record
  // without one would hide the preview the user is about to submit from.
  if (local.context && (localDrivesBranch || !theirs.context)) {
    merged.context = local.context;
  }

  if (!localDrivesBranch) {
    return merged;
  }

  // This tab is running the branch, so it — not the other tab's older snapshot —
  // knows where that branch is and how far it has got.
  return {
    ...merged,
    status: local.status,
    statusLabel: local.statusLabel,
    errorMessage: local.errorMessage,
    attemptId: local.attemptId,
    surfaceMode: local.surfaceMode,
    creationMode: local.creationMode,
    launchUrl: local.launchUrl,
    branchChatUrl: local.branchChatUrl,
    launchTabId: local.launchTabId,
    launchWindowId: local.launchWindowId,
    initialPrompt: local.initialPrompt,
    title: local.titleStatus === 'ready' ? local.title : merged.title,
    titleStatus: local.titleStatus === 'ready' ? 'ready' : merged.titleStatus
  };
}
