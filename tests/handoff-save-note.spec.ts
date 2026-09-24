import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, resetDatabaseConnection } from '../src/storage/db';
import { applyCommand, dumpAll, getQuestionBundle } from '../src/storage/repository';
import { createBackup } from '../src/storage/backup';
import { PASTED_EXCERPT_HEADING, buildSaveNoteCommand, composeNoteText } from '../src/handoff/save-note';
import type { ScratchHandoff } from '../src/handoff/types';

let db: IDBDatabase;

beforeEach(async () => {
  resetDatabaseConnection();
  db = await openDatabase(new IDBFactory());
});

const NOW = 1_700_000_000_000;

function scratch(): ScratchHandoff {
  return {
    sessionId: 'session-1',
    epoch: 3,
    providerId: 'chatgpt',
    policy: 'temporary-intended',
    entry: 'why',
    source: { tabId: 1, windowId: 1, scopeKey: 'chatgpt:c:conv-1', url: 'https://chatgpt.com/c/conv-1', open: true },
    selection: {
      rootConversationId: 'chatgpt:c:conv-1',
      rootChatUrl: 'https://chatgpt.com/c/conv-1',
      selectedText: 'S2≠S2 holds',
      structuredSelectedText: '$S_2 \\ne S^2$ holds',
      selectedBlocks: [
        { messageId: 'assistant:1:abc', role: 'assistant', turnIndex: 1, text: 'Whole answer text that is NOT previewed', excerpt: 'Whole answer' }
      ],
      branchBaseMessageId: 'assistant:1:abc',
      rangeQuotes: { exact: 'S2≠S2 holds', prefix: 'Then ', suffix: '.' },
      fallbackScrollY: 120
    },
    draft: { question: 'Why does this step hold?', excludedBlockIds: [], background: 'bg' },
    copied: null,
    clipboard: 'copied',
    target: {
      state: 'open',
      kind: 'window',
      route: 'convenience',
      tabId: 5,
      windowId: 7,
      windowCreated: true,
      ownership: 'owned',
      conversationPaths: [],
      openingSince: null
    },
    hidden: false,
    createdAt: NOW,
    updatedAt: NOW
  };
}

const ids = { questionId: 'q_note_1', anchorId: 'a_note_1', noteId: 'n_note_1' };

describe('explicit local note from a scratch handoff', () => {
  it('saves the passage, the question and the note together, and nothing else', async () => {
    const command = buildSaveNoteCommand(
      scratch(),
      { note: 'My takeaway.', excerpt: 'It holds because S_2 counts pairs.', title: '', sourceTitle: 'Convexity chat' },
      { conversationId: 'conv-1', containerId: null },
      ids
    );
    expect(command.blocks).toEqual([]);
    expect(command.question.providerMode).toBe('native-handoff');
    expect(command.question.retention).toBe('durable');
    expect(command.anchor.selectedText).toBe('$S_2 \\ne S^2$ holds');

    const outcome = await applyCommand(db, command, NOW);
    expect(outcome.status).toBe('applied');
    const bundle = await getQuestionBundle(db, ids.questionId);
    expect(bundle?.question.title).toBe('Why does this step hold?');
    expect(bundle?.notes.map((note) => note.text)).toEqual([
      `My takeaway.\n\n${PASTED_EXCERPT_HEADING}:\nIt holds because S_2 counts pairs.`
    ]);
    // No link (the native chat is not resumable), no captured messages, no snapshot.
    expect(bundle?.links).toEqual([]);
    expect(bundle?.messages).toEqual([]);
    expect(bundle?.snapshots).toEqual([]);

    const dump = await dumpAll(db);
    const everything = JSON.stringify(dump);
    // The unpreviewed whole answer and the background are not saved.
    expect(everything).not.toContain('Whole answer text that is NOT previewed');
    expect(everything).not.toContain('"bg"');
  });

  it('writes nothing at all when the question cannot be created', async () => {
    const command = buildSaveNoteCommand(
      scratch(),
      { note: 'n', excerpt: '', title: 't', sourceTitle: '' },
      { conversationId: null, containerId: null },
      ids
    );
    expect((await applyCommand(db, command, NOW)).status).toBe('applied');
    const second = buildSaveNoteCommand(
      scratch(),
      { note: 'second', excerpt: '', title: 't', sourceTitle: '' },
      { conversationId: null, containerId: null },
      { ...ids, noteId: 'n_other' }
    );
    // Same question id: rejected, and its note must not appear either.
    expect((await applyCommand(db, second, NOW)).status).toBe('rejected');
    const dump = await dumpAll(db);
    expect(dump.notes.map((note) => note.id)).toEqual([ids.noteId]);
  });

  it('a saved note is ordinary durable data: it is in the backup', async () => {
    await applyCommand(
      db,
      buildSaveNoteCommand(
        scratch(),
        { note: 'keep me', excerpt: '', title: 't', sourceTitle: '' },
        { conversationId: null, containerId: null },
        ids
      ),
      NOW
    );
    const backup = createBackup(await dumpAll(db), 'test-build', NOW);
    expect(JSON.stringify(backup)).toContain('keep me');
  });

  it('composes an excerpt only when the Owner supplied one', () => {
    expect(composeNoteText('just mine', '')).toBe('just mine');
    expect(composeNoteText('', 'pasted')).toBe(`${PASTED_EXCERPT_HEADING}:\npasted`);
  });
});
