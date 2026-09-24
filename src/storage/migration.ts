/**
 * Legacy panel records → domain records, journaled and idempotent.
 *
 * Legacy variants handled:
 *  - v1 per-panel records `aside:panel:<id>` in chrome.storage.local, plus
 *    tombstones `aside:gone:<id>`;
 *  - v0 buckets `aside:panels:<conversationId>` (and the pre-rename
 *    `side-branches:panels:` prefix) holding arrays of panel states.
 *
 * Rules:
 *  - only ordinary (persistent-kind) panels are migrated; a private panel never
 *    reaches durable staging, even if a legacy build stored one on disk — that is
 *    flagged, not replicated and not deleted;
 *  - a deleted legacy panel (tombstone) becomes a domain tombstone so nothing can
 *    resurrect it;
 *  - old transcripts were never captured, so migrated questions are link-only —
 *    no historical message is fabricated;
 *  - legacy records are left in place as the rollback source. A separate,
 *    explicit cleanup removes them once validation has passed;
 *  - every step is journaled, so an interrupted run resumes without duplicating.
 */

import type { BranchPanelState } from '../shared/types';
import { PANEL_STORAGE_PREFIX, LEGACY_PANEL_STORAGE_PREFIX } from '../shared/constants';
import { PANEL_RECORD_PREFIX, TOMBSTONE_PREFIX } from '../shared/panel-store';
import { blockIdFor, fnv1a, newAnchorId, newLinkId, newSnapshotId, sourceIdFor } from '../domain/ids';
import { autoTitle, type DomainCommand } from '../domain/commands';
import type { ProviderId } from '../domain/types';
import { applyCommand, readMeta, writeMeta } from './repository';

export const MIGRATION_JOURNAL_KEY = 'migration:legacy-panels';
export const LEGACY_FROZEN_KEY = 'aside:legacy-frozen';

export interface MigrationJournal {
  version: 1;
  startedAt: number;
  completedAt: number | null;
  /** Legacy panel ids already migrated (or intentionally skipped), by outcome. */
  migrated: string[];
  skippedPrivate: string[];
  tombstoned: string[];
  failed: Array<{ panelId: string; reason: string }>;
  /** Counts at the last validation, for the report. */
  validation: { legacyOrdinary: number; migrated: number; ok: boolean } | null;
  cleanedUpAt: number | null;
}

export interface LegacyPanelInput {
  panelId: string;
  state: BranchPanelState;
  origin: 'v1-record' | 'v0-bucket';
}

export interface LegacyReadResult {
  panels: LegacyPanelInput[];
  tombstonedIds: string[];
  /** Private panels found on disk by an older build; reported, never migrated. */
  durablePrivateIds: string[];
  keysRead: string[];
}

function providerIdFromScope(scopeKey: string, url: string): ProviderId {
  if (scopeKey.startsWith('claude:') || url.includes('claude.ai')) {
    return 'claude';
  }
  return 'chatgpt';
}

/** Read every legacy shape out of a raw chrome.storage.local bag. */
export function readLegacyPanels(raw: Record<string, unknown>): LegacyReadResult {
  const panels: LegacyPanelInput[] = [];
  const tombstonedIds: string[] = [];
  const durablePrivateIds: string[] = [];
  const keysRead: string[] = [];
  const seen = new Set<string>();

  const consider = (state: unknown, origin: LegacyPanelInput['origin']) => {
    const candidate = state as Partial<BranchPanelState> | null;
    if (!candidate || typeof candidate !== 'object' || typeof candidate.panelId !== 'string') {
      return;
    }
    if (!candidate.selection || typeof candidate.rootChatUrl !== 'string') {
      return;
    }
    if (seen.has(candidate.panelId)) {
      return;
    }
    seen.add(candidate.panelId);
    if (candidate.branchKind === 'temporary') {
      durablePrivateIds.push(candidate.panelId);
      return;
    }
    panels.push({ panelId: candidate.panelId, state: candidate as BranchPanelState, origin });
  };

  Object.entries(raw).forEach(([key, value]) => {
    if (key.startsWith(TOMBSTONE_PREFIX)) {
      keysRead.push(key);
      const tomb = value as { panelId?: string } | null;
      if (tomb?.panelId) {
        tombstonedIds.push(tomb.panelId);
      }
      return;
    }
    if (key.startsWith(PANEL_RECORD_PREFIX)) {
      keysRead.push(key);
      const record = value as { state?: unknown; area?: string } | null;
      if (record?.area === 'session') {
        return;
      }
      consider(record?.state, 'v1-record');
      return;
    }
    if (key.startsWith(PANEL_STORAGE_PREFIX) || key.startsWith(LEGACY_PANEL_STORAGE_PREFIX)) {
      keysRead.push(key);
      if (Array.isArray(value)) {
        value.forEach((state) => consider(state, 'v0-bucket'));
      }
    }
  });

  return { panels, tombstonedIds, durablePrivateIds, keysRead };
}

/** Deterministic mapping from one legacy panel to domain commands. */
export function commandsForLegacyPanel(input: LegacyPanelInput): DomainCommand[] {
  const { state, panelId } = input;
  const scopeKey = state.rootConversationId || `legacy:${fnv1a(state.rootChatUrl)}`;
  const providerId = providerIdFromScope(scopeKey, state.rootChatUrl);
  const sourceId = sourceIdFor(providerId, scopeKey);
  const selection = state.selection;
  const anchorBlock =
    selection.selectedBlocks.find((block) => block.messageId === selection.branchBaseMessageId) ??
    selection.selectedBlocks[0];
  const anchorText = selection.selectedText;
  const selectedStructured = selection.structuredSelectedText || selection.selectedText;

  const blocks = selection.selectedBlocks.map((block) => {
    const text = block.structuredText || block.text;
    const contentHash = fnv1a(text);
    return {
      id: blockIdFor(sourceId, contentHash),
      sourceId,
      role: block.role,
      kind: 'unknown' as const,
      text,
      anchorText: block.text,
      messageId: block.messageId,
      turnIndex: block.turnIndex,
      contentHash
    };
  });

  const anchorId = newAnchorId();
  const questionId = `q_legacy_${panelId}`;
  const title =
    state.titleStatus === 'ready' && state.title.trim()
      ? state.title.trim()
      : autoTitle(state.initialQuestion ?? '', selectedStructured);

  const commands: DomainCommand[] = [
    {
      type: 'CreateQuestion',
      source: {
        id: sourceId,
        providerId,
        scopeKey,
        conversationId: scopeKey.includes(':c:') || scopeKey.includes(':chat:') ? scopeKey.split(':').at(-1) ?? null : null,
        containerId: null,
        url: state.rootChatUrl,
        title: selection.precedingQuestion?.excerpt || anchorBlock?.excerpt || 'Conversation',
        kind: 'assistant-answer',
        acquisition: 'selected-fragment',
        messageId: anchorBlock?.messageId ?? null
      },
      blocks,
      anchor: {
        id: anchorId,
        sourceId,
        selectedText: selectedStructured,
        exact: selection.rangeQuotes.exact || anchorText,
        prefix: selection.rangeQuotes.prefix,
        suffix: selection.rangeQuotes.suffix,
        messageId: anchorBlock?.messageId ?? selection.branchBaseMessageId,
        turnIndex: anchorBlock?.turnIndex ?? 0,
        role: anchorBlock?.role ?? 'assistant',
        contentHash: fnv1a(anchorBlock?.structuredText || anchorBlock?.text || anchorText),
        scrollHint: selection.fallbackScrollY
      },
      question: {
        id: questionId,
        sourceId,
        anchorId,
        parentQuestionId: null,
        parentMessageId: null,
        title,
        titleSource: state.titleStatus === 'ready' ? 'user' : 'auto',
        retention: 'durable',
        providerMode: 'normal',
        entryAction: state.entryAction
      },
      draft: {
        text: state.initialQuestion ?? '',
        excludedBlockIds: (state.context?.blocks ?? []).filter((block) => !block.included).map((block) => block.id),
        background: state.context?.userBackground ?? ''
      }
    }
  ];

  // A branch that was actually sent gets its prompt frozen as the snapshot and a
  // link-only provider link. No transcript was captured historically, so no
  // message is invented.
  if (state.initialPrompt && (state.status === 'live' || state.branchChatUrl)) {
    const snapshotId = newSnapshotId();
    commands.push({
      type: 'FreezeSnapshot',
      questionId,
      snapshot: {
        id: snapshotId,
        questionId,
        prompt: state.initialPrompt,
        question: state.initialQuestion ?? '',
        blocks: blocks.map((block) => ({
          blockId: block.id,
          contentHash: block.contentHash,
          role: block.messageId === (anchorBlock?.messageId ?? '') ? ('focus' as const) : ('enclosing' as const),
          included: true
        })),
        missing: ['legacy record: transcript was never captured'],
        compilerVersion: 'legacy',
        templateVersion: 'legacy',
        charCount: state.initialPrompt.length
      },
      link: {
        id: newLinkId(),
        questionId,
        providerId,
        conversationUrl: state.branchChatUrl ?? null,
        attemptId: state.attemptId ?? null,
        snapshotId,
        run: state.status === 'live' ? 'completed' : state.status === 'failed' ? 'failed' : 'submission-unknown',
        acknowledgement: state.status === 'live' ? 'legacy: branch reported live' : null,
        capture: 'link-only',
        capturedThroughMessageId: null,
        lastCaptureAt: null,
        model: null
      }
    });
  }

  return commands;
}

export interface MigrationRunResult {
  journal: MigrationJournal;
  durablePrivateIds: string[];
}

/**
 * Run (or resume) the migration. Safe to call on every worker start: already
 * migrated ids are skipped from the journal, and the journal is written after
 * each panel so an interruption resumes at the next one.
 */
export async function runLegacyMigration(
  db: IDBDatabase,
  raw: Record<string, unknown>,
  persistJournal: (journal: MigrationJournal) => Promise<void>,
  now: number = Date.now()
): Promise<MigrationRunResult> {
  const legacy = readLegacyPanels(raw);
  const existing = await readMeta<MigrationJournal>(db, MIGRATION_JOURNAL_KEY);
  const journal: MigrationJournal = existing ?? {
    version: 1,
    startedAt: now,
    completedAt: null,
    migrated: [],
    skippedPrivate: [],
    tombstoned: [],
    failed: [],
    validation: null,
    cleanedUpAt: null
  };

  const done = new Set([...journal.migrated, ...journal.tombstoned]);

  for (const panelId of legacy.tombstonedIds) {
    if (done.has(panelId)) {
      continue;
    }
    await applyCommand(db, { type: 'DeleteQuestion', questionId: `q_legacy_${panelId}`, descendants: 'reparent' }, now);
    journal.tombstoned.push(panelId);
    done.add(panelId);
    await writeMeta(db, MIGRATION_JOURNAL_KEY, journal);
    await persistJournal(journal);
  }

  for (const panel of legacy.panels) {
    if (done.has(panel.panelId)) {
      continue;
    }
    if (legacy.tombstonedIds.includes(panel.panelId)) {
      continue;
    }
    let failed: string | null = null;
    for (const command of commandsForLegacyPanel(panel)) {
      const outcome = await applyCommand(db, command, now);
      if (outcome.status === 'error') {
        failed = outcome.reason;
        break;
      }
      // 'rejected' on CreateQuestion means it already exists from an earlier,
      // interrupted run: that is the idempotent path, not a failure.
    }
    if (failed) {
      journal.failed.push({ panelId: panel.panelId, reason: failed });
    } else {
      journal.migrated.push(panel.panelId);
    }
    done.add(panel.panelId);
    await writeMeta(db, MIGRATION_JOURNAL_KEY, journal);
    await persistJournal(journal);
  }

  legacy.durablePrivateIds.forEach((panelId) => {
    if (!journal.skippedPrivate.includes(panelId)) {
      journal.skippedPrivate.push(panelId);
    }
  });

  journal.validation = {
    legacyOrdinary: legacy.panels.length,
    migrated: journal.migrated.length,
    ok: journal.failed.length === 0 && journal.migrated.length >= legacy.panels.filter((p) => !legacy.tombstonedIds.includes(p.panelId)).length
  };
  if (journal.validation.ok && !journal.completedAt) {
    journal.completedAt = now;
  }
  await writeMeta(db, MIGRATION_JOURNAL_KEY, journal);
  await persistJournal(journal);

  return { journal, durablePrivateIds: legacy.durablePrivateIds };
}

/** Keys an explicit cleanup may remove once the journal validated. Never session keys. */
export function legacyKeysEligibleForCleanup(raw: Record<string, unknown>, journal: MigrationJournal): string[] {
  if (!journal.validation?.ok || !journal.completedAt) {
    return [];
  }
  const eligible: string[] = [];
  Object.entries(raw).forEach(([key, value]) => {
    if (key.startsWith(PANEL_RECORD_PREFIX)) {
      const record = value as { panelId?: string; area?: string; state?: { branchKind?: string } } | null;
      if (record?.area === 'session' || record?.state?.branchKind === 'temporary') {
        return;
      }
      if (record?.panelId && journal.migrated.includes(record.panelId)) {
        eligible.push(key);
      }
      return;
    }
    if (key.startsWith(PANEL_STORAGE_PREFIX) || key.startsWith(LEGACY_PANEL_STORAGE_PREFIX)) {
      const bucket = Array.isArray(value) ? (value as Array<{ panelId?: string; branchKind?: string }>) : [];
      const allMigrated = bucket.every(
        (state) => state.branchKind !== 'temporary' && state.panelId && journal.migrated.includes(state.panelId)
      );
      if (bucket.length && allMigrated) {
        eligible.push(key);
      }
    }
  });
  return eligible;
}
