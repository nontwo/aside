import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, resetDatabaseConnection } from '../src/storage/db';
import {
  applyCommand,
  dumpAll,
  getQuestionBundle,
  listQuestionsForSource,
  listSources,
  searchQuestions
} from '../src/storage/repository';
import {
  commandsForLegacyPanel,
  legacyKeysEligibleForCleanup,
  readLegacyPanels,
  runLegacyMigration
} from '../src/storage/migration';
import { createBackup, renderSourceMarkdown, restoreBackup, validateBackup } from '../src/storage/backup';
import type { CreateQuestionCommand } from '../src/domain/commands';
import type { BranchPanelState } from '../src/shared/types';

let db: IDBDatabase;

beforeEach(async () => {
  resetDatabaseConnection();
  db = await openDatabase(new IDBFactory());
});

const NOW = 1_700_000_000_000;

function createCommand(questionId = 'q1', overrides: Partial<CreateQuestionCommand['question']> = {}): CreateQuestionCommand {
  return {
    type: 'CreateQuestion',
    source: {
      id: 'src_chatgpt_abc',
      providerId: 'chatgpt',
      scopeKey: 'chatgpt:c:conv-1',
      conversationId: 'conv-1',
      containerId: null,
      url: 'https://chatgpt.com/c/conv-1',
      title: 'Convexity',
      kind: 'assistant-answer',
      acquisition: 'selected-fragment',
      messageId: 'assistant:1:abc'
    },
    blocks: [
      {
        id: 'blk_src_chatgpt_abc_h1',
        sourceId: 'src_chatgpt_abc',
        role: 'assistant',
        kind: 'paragraph',
        text: 'The convexity assumption keeps the relaxation tight.',
        anchorText: 'The convexity assumption keeps the relaxation tight.',
        messageId: 'assistant:1:abc',
        turnIndex: 1,
        contentHash: 'h1'
      }
    ],
    anchor: {
      id: `a_${questionId}`,
      sourceId: 'src_chatgpt_abc',
      selectedText: 'convexity assumption',
      exact: 'convexity assumption',
      prefix: 'The ',
      suffix: ' keeps',
      messageId: 'assistant:1:abc',
      turnIndex: 1,
      role: 'assistant',
      contentHash: 'h1',
      scrollHint: 0
    },
    question: {
      id: questionId,
      sourceId: 'src_chatgpt_abc',
      anchorId: `a_${questionId}`,
      parentQuestionId: null,
      parentMessageId: null,
      title: 'Why convexity?',
      titleSource: 'auto',
      retention: 'durable',
      providerMode: 'normal',
      entryAction: 'ask',
      ...overrides
    },
    draft: { text: 'Why is convexity needed?', excludedBlockIds: [], background: '' }
  };
}

describe('question commands', () => {
  it('creates a question with its source, block, anchor and draft in one transaction', async () => {
    const outcome = await applyCommand(db, createCommand(), NOW);
    expect(outcome.status).toBe('applied');

    const bundle = await getQuestionBundle(db, 'q1');
    expect(bundle?.source?.id).toBe('src_chatgpt_abc');
    expect(bundle?.anchor?.exact).toBe('convexity assumption');
    expect(bundle?.draft?.text).toBe('Why is convexity needed?');
    expect(bundle?.question.lifecycle).toBe('active');
  });

  it('never creates on update of a missing id', async () => {
    const outcome = await applyCommand(db, { type: 'UpdateDraft', questionId: 'nope', baseRev: 0, text: 'x' }, NOW);
    expect(outcome.status).toBe('rejected');
    expect(await getQuestionBundle(db, 'nope')).toBeNull();
  });

  it('reports a draft conflict with the stored text instead of picking a winner', async () => {
    await applyCommand(db, createCommand(), NOW);
    const first = await applyCommand(db, { type: 'UpdateDraft', questionId: 'q1', baseRev: 1, text: 'tab A' }, NOW);
    expect(first.status).toBe('applied');

    const stale = await applyCommand(db, { type: 'UpdateDraft', questionId: 'q1', baseRev: 1, text: 'tab B' }, NOW);
    expect(stale.status).toBe('conflict');
    expect(stale.status === 'conflict' && stale.current.text).toBe('tab A');
  });

  it('rejects a revision from the future', async () => {
    await applyCommand(db, createCommand(), NOW);
    const outcome = await applyCommand(db, { type: 'UpdateDraft', questionId: 'q1', baseRev: 99, text: 'x' }, NOW);
    expect(outcome.status).toBe('rejected');
  });

  it('freezes a snapshot that cannot be overwritten', async () => {
    await applyCommand(db, createCommand(), NOW);
    const freeze = {
      type: 'FreezeSnapshot' as const,
      questionId: 'q1',
      snapshot: {
        id: 'snap1',
        questionId: 'q1',
        prompt: 'FULL PROMPT',
        question: 'Why?',
        blocks: [{ blockId: 'blk_src_chatgpt_abc_h1', contentHash: 'h1', role: 'focus' as const, included: true }],
        missing: [],
        compilerVersion: '1',
        templateVersion: '1',
        charCount: 11
      },
      link: {
        id: 'link1',
        questionId: 'q1',
        providerId: 'chatgpt' as const,
        conversationUrl: null,
        attemptId: 'att1',
        snapshotId: 'snap1',
        run: 'submitting' as const,
        acknowledgement: null,
        capture: 'link-only' as const,
        capturedThroughMessageId: null,
        lastCaptureAt: null,
        model: null
      }
    };
    expect((await applyCommand(db, freeze, NOW)).status).toBe('applied');
    const again = await applyCommand(db, { ...freeze, snapshot: { ...freeze.snapshot, prompt: 'CHANGED' } }, NOW);
    expect(again.status).toBe('rejected');
    const bundle = await getQuestionBundle(db, 'q1');
    expect(bundle?.snapshots[0].prompt).toBe('FULL PROMPT');
  });

  it('rejects run updates and captures from a superseded attempt', async () => {
    await applyCommand(db, createCommand(), NOW);
    await applyCommand(db, freezeFor('q1', 'att1'), NOW);

    const stale = await applyCommand(
      db,
      { type: 'UpdateRun', linkId: 'link_q1', baseRev: 1, attemptId: 'old', run: 'completed' },
      NOW
    );
    expect(stale.status).toBe('rejected');

    const capture = await applyCommand(
      db,
      {
        type: 'AppendOrReviseCapturedMessage',
        questionId: 'q1',
        linkId: 'link_q1',
        attemptId: 'old',
        message: { role: 'assistant', text: 'x', partial: false, providerMessageId: null, ordinal: 1, snapshotId: null, attemptId: 'old' },
        capture: 'partial',
        capturedThroughMessageId: null
      },
      NOW
    );
    expect(capture.status).toBe('rejected');
  });

  it('revises a streaming message in place and never regresses a completed one', async () => {
    await applyCommand(db, createCommand(), NOW);
    await applyCommand(db, freezeFor('q1', 'att1'), NOW);

    const capture = (text: string, partial: boolean) =>
      applyCommand(
        db,
        {
          type: 'AppendOrReviseCapturedMessage',
          questionId: 'q1',
          linkId: 'link_q1',
          attemptId: 'att1',
          message: { role: 'assistant', text, partial, providerMessageId: 'pm1', ordinal: 1, snapshotId: 'snap_q1', attemptId: 'att1' },
          capture: partial ? 'partial' : 'captured-through',
          capturedThroughMessageId: partial ? null : 'pm1'
        },
        NOW
      );

    await capture('Hel', true);
    await capture('Hello world.', false);
    const late = await capture('Hel', true);
    expect(late.status).toBe('applied');

    const bundle = await getQuestionBundle(db, 'q1');
    expect(bundle?.messages).toHaveLength(1);
    expect(bundle?.messages[0].text).toBe('Hello world.');
    expect(bundle?.messages[0].partial).toBe(false);
    expect(bundle?.links[0].capture).toBe('captured-through');
  });

  it('walks the lifecycle: resolve, reopen, archive', async () => {
    await applyCommand(db, createCommand(), NOW);
    let rev = 1;
    const step = async (type: 'ResolveQuestion' | 'ReopenQuestion' | 'ArchiveQuestion') => {
      const outcome = await applyCommand(db, { type, questionId: 'q1', baseRev: rev }, NOW);
      expect(outcome.status).toBe('applied');
      rev = outcome.status === 'applied' ? outcome.rev : rev;
    };
    await step('ResolveQuestion');
    expect((await getQuestionBundle(db, 'q1'))?.question.lifecycle).toBe('resolved');
    await step('ReopenQuestion');
    expect((await getQuestionBundle(db, 'q1'))?.question.lifecycle).toBe('active');
    await step('ArchiveQuestion');
    expect((await getQuestionBundle(db, 'q1'))?.question.lifecycle).toBe('archived');
  });

  it('deletes explicitly, leaves a tombstone, and refuses to recreate', async () => {
    await applyCommand(db, createCommand(), NOW);
    await applyCommand(db, { type: 'DeleteQuestion', questionId: 'q1', descendants: 'reparent' }, NOW);
    expect(await getQuestionBundle(db, 'q1')).toBeNull();

    const late = await applyCommand(db, createCommand(), NOW + 1);
    expect(late.status).toBe('rejected');
    const dump = await dumpAll(db);
    expect(dump.tombstones.map((tomb) => tomb.id)).toContain('q1');
  });

  it('reparents children by default and removes them only for a subtree delete', async () => {
    await applyCommand(db, createCommand('root'), NOW);
    await applyCommand(db, freezeFor('root', 'att1'), NOW);
    await applyCommand(
      db,
      {
        type: 'AppendOrReviseCapturedMessage',
        questionId: 'root',
        linkId: 'link_root',
        attemptId: 'att1',
        message: { id: 'm_root_1', role: 'assistant', text: 'answer', partial: false, providerMessageId: null, ordinal: 1, snapshotId: null, attemptId: 'att1' },
        capture: 'captured-through',
        capturedThroughMessageId: 'm_root_1'
      },
      NOW
    );
    const child = await applyCommand(
      db,
      {
        type: 'CreateChildQuestion',
        parentQuestionId: 'root',
        parentMessageId: 'm_root_1',
        question: { id: 'child', title: 'child', titleSource: 'auto', retention: 'durable', providerMode: 'normal', entryAction: 'ask' }
      },
      NOW
    );
    expect(child.status).toBe('applied');

    await applyCommand(db, { type: 'DeleteQuestion', questionId: 'root', descendants: 'reparent' }, NOW);
    const kept = await getQuestionBundle(db, 'child');
    expect(kept?.question.parentQuestionId).toBeNull();

    await applyCommand(db, { type: 'DeleteQuestion', questionId: 'child', descendants: 'subtree' }, NOW);
    expect(await getQuestionBundle(db, 'child')).toBeNull();
  });

  it('keeps a shared block when another question still references it', async () => {
    await applyCommand(db, createCommand('q1'), NOW);
    await applyCommand(db, createCommand('q2'), NOW);
    await applyCommand(db, freezeFor('q1', 'a'), NOW);
    await applyCommand(db, freezeFor('q2', 'b'), NOW);

    await applyCommand(db, { type: 'DeleteQuestion', questionId: 'q1', descendants: 'reparent' }, NOW);
    const dump = await dumpAll(db);
    expect(dump.blocks.map((block) => block.id)).toContain('blk_src_chatgpt_abc_h1');
    expect(dump.sources).toHaveLength(1);

    await applyCommand(db, { type: 'DeleteQuestion', questionId: 'q2', descendants: 'reparent' }, NOW);
    const after = await dumpAll(db);
    expect(after.blocks).toHaveLength(0);
    expect(after.sources).toHaveLength(0);
  });

  it('lists sources and questions, and searches titles and messages', async () => {
    await applyCommand(db, createCommand('q1'), NOW);
    const sources = await listSources(db);
    expect(sources).toHaveLength(1);
    expect(sources[0].questionCount).toBe(1);
    const questions = await listQuestionsForSource(db, 'src_chatgpt_abc');
    expect(questions[0].question.id).toBe('q1');
    const hits = await searchQuestions(db, 'convex');
    expect(hits[0].question.id).toBe('q1');
  });
});

function freezeFor(questionId: string, attemptId: string) {
  return {
    type: 'FreezeSnapshot' as const,
    questionId,
    snapshot: {
      id: `snap_${questionId}`,
      questionId,
      prompt: 'P',
      question: 'Q',
      blocks: [{ blockId: 'blk_src_chatgpt_abc_h1', contentHash: 'h1', role: 'focus' as const, included: true }],
      missing: [],
      compilerVersion: '1',
      templateVersion: '1',
      charCount: 1
    },
    link: {
      id: `link_${questionId}`,
      questionId,
      providerId: 'chatgpt' as const,
      conversationUrl: null,
      attemptId,
      snapshotId: `snap_${questionId}`,
      run: 'submitting' as const,
      acknowledgement: null,
      capture: 'link-only' as const,
      capturedThroughMessageId: null,
      lastCaptureAt: null,
      model: null
    }
  };
}

/* ------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------ */

function legacyState(panelId: string, overrides: Partial<BranchPanelState> = {}): BranchPanelState {
  return {
    panelId,
    rootConversationId: 'chatgpt:c:conv-9',
    rootChatUrl: 'https://chatgpt.com/c/conv-9',
    selection: {
      rootConversationId: 'chatgpt:c:conv-9',
      rootChatUrl: 'https://chatgpt.com/c/conv-9',
      selectedText: 'a passage',
      structuredSelectedText: 'a passage',
      selectedBlocks: [
        { messageId: 'assistant:1:x', role: 'assistant', turnIndex: 1, text: 'a passage in an answer', excerpt: 'a passage' }
      ],
      branchBaseMessageId: 'assistant:1:x',
      rangeQuotes: { exact: 'a passage', prefix: '', suffix: ' in' },
      fallbackScrollY: 10
    },
    focusPreview: 'a passage',
    branchKind: 'persistent',
    entryAction: 'ask',
    surfaceMode: 'embedded',
    creationMode: 'local_persistent',
    title: 'old title',
    titleStatus: 'ready',
    minimized: true,
    status: 'live',
    statusLabel: 'live',
    initialQuestion: 'why?',
    initialPrompt: 'THE OLD PROMPT',
    branchChatUrl: 'https://chatgpt.com/c/branch-9',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

describe('legacy migration', () => {
  it('reads v1 records and v0 buckets, skipping private and session records', () => {
    const raw = {
      'aside:panel:p1': { panelId: 'p1', area: 'local', rev: 3, state: legacyState('p1') },
      'aside:panel:p2': { panelId: 'p2', area: 'session', rev: 1, state: legacyState('p2', { branchKind: 'temporary' }) },
      'aside:panel:p3': { panelId: 'p3', area: 'local', rev: 1, state: legacyState('p3', { branchKind: 'temporary' }) },
      'aside:panels:conv-9': [legacyState('p4'), { nope: true }],
      'side-branches:panels:conv-8': [legacyState('p5')],
      'aside:gone:p6': { panelId: 'p6', deletedAt: 1, rev: 2 },
      'aside:last-branch-kind:chatgpt': 'persistent'
    };
    const result = readLegacyPanels(raw);
    expect(result.panels.map((panel) => panel.panelId).sort()).toEqual(['p1', 'p4', 'p5']);
    expect(result.durablePrivateIds).toEqual(['p3']);
    expect(result.tombstonedIds).toEqual(['p6']);
  });

  it('maps a sent legacy panel to a question, a frozen snapshot and a link-only provider link', () => {
    const commands = commandsForLegacyPanel({ panelId: 'p1', state: legacyState('p1'), origin: 'v1-record' });
    expect(commands[0].type).toBe('CreateQuestion');
    expect(commands[1].type).toBe('FreezeSnapshot');
    const freeze = commands[1];
    if (freeze.type === 'FreezeSnapshot') {
      expect(freeze.snapshot.prompt).toBe('THE OLD PROMPT');
      expect(freeze.link.capture).toBe('link-only');
      expect(freeze.link.conversationUrl).toBe('https://chatgpt.com/c/branch-9');
    }
    const create = commands[0];
    if (create.type === 'CreateQuestion') {
      expect(create.question.title).toBe('old title');
    }
  });

  it('migrates idempotently, honours legacy tombstones, and resumes after an interruption', async () => {
    const raw = {
      'aside:panel:p1': { panelId: 'p1', area: 'local', rev: 3, state: legacyState('p1') },
      'aside:panel:p2': { panelId: 'p2', area: 'local', rev: 3, state: legacyState('p2') },
      'aside:panel:p6': { panelId: 'p6', area: 'local', rev: 3, state: legacyState('p6') },
      'aside:gone:p6': { panelId: 'p6', deletedAt: 1, rev: 2 }
    };
    const journals: unknown[] = [];
    const persist = async (journal: unknown) => {
      journals.push(journal);
    };

    const first = await runLegacyMigration(db, raw, persist, NOW);
    expect(first.journal.migrated.sort()).toEqual(['p1', 'p2']);
    expect(first.journal.tombstoned).toEqual(['p6']);
    expect(first.journal.validation?.ok).toBe(true);

    const second = await runLegacyMigration(db, raw, persist, NOW + 1);
    expect(second.journal.migrated.sort()).toEqual(['p1', 'p2']);
    const dump = await dumpAll(db);
    expect(dump.questions).toHaveLength(2);
    expect(dump.messages).toHaveLength(0);
    expect(dump.questions.map((q) => q.id)).not.toContain('q_legacy_p6');

    // A tombstoned legacy id cannot come back through a replayed migration.
    const replay = await applyCommand(db, commandsForLegacyPanel({ panelId: 'p6', state: legacyState('p6'), origin: 'v1-record' })[0], NOW);
    expect(replay.status).toBe('rejected');
  });

  it('only offers legacy keys for cleanup after validation, never session or private ones', () => {
    const raw = {
      'aside:panel:p1': { panelId: 'p1', area: 'local', state: { branchKind: 'persistent' } },
      'aside:panel:p3': { panelId: 'p3', area: 'local', state: { branchKind: 'temporary' } },
      'aside:panel:p2': { panelId: 'p2', area: 'session', state: { branchKind: 'temporary' } },
      'aside:panels:conv-9': [{ panelId: 'p4', branchKind: 'persistent' }]
    };
    const notValidated = legacyKeysEligibleForCleanup(raw, {
      version: 1, startedAt: 1, completedAt: null, migrated: ['p1', 'p4'], skippedPrivate: [], tombstoned: [], failed: [], validation: null, cleanedUpAt: null
    });
    expect(notValidated).toEqual([]);

    const validated = legacyKeysEligibleForCleanup(raw, {
      version: 1, startedAt: 1, completedAt: 2, migrated: ['p1', 'p4'], skippedPrivate: [], tombstoned: [], failed: [],
      validation: { legacyOrdinary: 2, migrated: 2, ok: true }, cleanedUpAt: null
    });
    expect(validated.sort()).toEqual(['aside:panel:p1', 'aside:panels:conv-9']);
  });
});

/* ------------------------------------------------------------------ *
 * Backup / restore / export
 * ------------------------------------------------------------------ */

describe('backup and restore', () => {
  it('round-trips a database and refuses to resurrect a deleted question', async () => {
    await applyCommand(db, createCommand('q1'), NOW);
    await applyCommand(db, createCommand('q2'), NOW);
    const backup = createBackup(await dumpAll(db), 'test-build', NOW);
    expect(validateBackup(backup).ok).toBe(true);

    await applyCommand(db, { type: 'DeleteQuestion', questionId: 'q2', descendants: 'reparent' }, NOW);

    resetDatabaseConnection();
    const fresh = await openDatabase(new IDBFactory());
    // Fresh database with q2 tombstoned: the import must skip it.
    await applyCommand(fresh, { type: 'DeleteQuestion', questionId: 'q2', descendants: 'reparent' }, NOW);
    const report = await restoreBackup(fresh, backup);
    expect(report.skippedDeleted).toEqual(['q2']);
    expect((await getQuestionBundle(fresh, 'q1'))?.question.title).toBe('Why convexity?');
    expect(await getQuestionBundle(fresh, 'q2')).toBeNull();
  });

  it('does not overwrite a newer stored record with an older backup', async () => {
    await applyCommand(db, createCommand('q1'), NOW);
    const older = createBackup(await dumpAll(db), 'test-build', NOW);
    await applyCommand(db, { type: 'RenameQuestion', questionId: 'q1', baseRev: 1, title: 'newer title' }, NOW);

    const report = await restoreBackup(db, older);
    expect(report.skippedOlder).toContain('questions:q1');
    expect((await getQuestionBundle(db, 'q1'))?.question.title).toBe('newer title');
  });

  it('rejects malformed input and any record claiming to be session-only', () => {
    expect(validateBackup({}).ok).toBe(false);
    expect(validateBackup('<script>').ok).toBe(false);
    const bad = {
      format: 'aside-backup',
      version: 1,
      exportedAt: 1,
      buildId: 'x',
      data: { sources: [], blocks: [], anchors: [], questions: [{ id: 'p', sourceId: 's', retention: 'session-only' }], drafts: [], snapshots: [], messages: [], links: [], notes: [], tombstones: [] }
    };
    const verdict = validateBackup(bad);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/session-only/);
  });

  it('renders Markdown that labels capture honesty and fences content', async () => {
    await applyCommand(db, createCommand('q1'), NOW);
    await applyCommand(db, freezeFor('q1', 'att1'), NOW);
    const bundle = await getQuestionBundle(db, 'q1');
    const markdown = renderSourceMarkdown('Convexity', 'https://chatgpt.com/c/conv-1', bundle ? [bundle] : []);
    expect(markdown).toContain('link only — transcript not captured');
    expect(markdown).toContain('```text');
  });
});
