/**
 * Applies domain commands to the question database, one transaction per command.
 *
 * Consistency rules enforced here:
 *  - a create is explicit; updating a missing id is rejected, never a create;
 *  - a stale or future revision is a conflict, and a draft conflict carries the
 *    stored text so the caller can show both rather than pick one;
 *  - a tombstoned question cannot be written back by a delayed command;
 *  - blocks are shared by content hash and removed only when nothing references
 *    them, so deleting one question cannot damage another;
 *  - a transaction commits before the caller is told it succeeded.
 */

import type {
  Anchor,
  ContextSnapshot,
  Message,
  Note,
  ProviderLink,
  Question,
  QuestionDraft,
  Source,
  SourceBlock,
  Tombstone
} from '../domain/types';
import {
  autoTitle,
  nextLifecycle,
  type CommandOutcome,
  type DomainCommand
} from '../domain/commands';
import { newMessageId, newQuestionId } from '../domain/ids';
import { STORES, requestToPromise, withTransaction, type StoreName } from './db';

const REV_START = 1;

async function getOne<T>(tx: IDBTransaction, store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return requestToPromise(tx.objectStore(store).get(key)) as Promise<T | undefined>;
}

async function getAllByIndex<T>(
  tx: IDBTransaction,
  store: StoreName,
  index: string,
  value: IDBValidKey
): Promise<T[]> {
  return requestToPromise(tx.objectStore(store).index(index).getAll(value)) as Promise<T[]>;
}

async function put(tx: IDBTransaction, store: StoreName, value: unknown): Promise<void> {
  await requestToPromise(tx.objectStore(store).put(value));
}

async function remove(tx: IDBTransaction, store: StoreName, key: IDBValidKey): Promise<void> {
  await requestToPromise(tx.objectStore(store).delete(key));
}

function rejected(reason: string): CommandOutcome {
  return { status: 'rejected', reason };
}

function conflict(rev: number, text?: string): CommandOutcome {
  return { status: 'conflict', current: { rev, text } };
}

/** Blocks referenced by anything other than the question being removed. */
async function blockStillReferenced(
  tx: IDBTransaction,
  blockId: string,
  excludingQuestionId: string
): Promise<boolean> {
  const block = await getOne<SourceBlock>(tx, STORES.blocks, blockId);
  if (!block) {
    return false;
  }
  const questions = await getAllByIndex<Question>(tx, STORES.questions, 'sourceId', block.sourceId);
  for (const question of questions) {
    if (question.id === excludingQuestionId) {
      continue;
    }
    const snapshots = await getAllByIndex<ContextSnapshot>(tx, STORES.snapshots, 'questionId', question.id);
    if (snapshots.some((snapshot) => snapshot.blocks.some((ref) => ref.blockId === blockId))) {
      return true;
    }
    const anchor = await getOne<Anchor>(tx, STORES.anchors, question.anchorId);
    if (anchor && block.messageId === anchor.messageId && block.contentHash === anchor.contentHash) {
      return true;
    }
  }
  return false;
}

export async function applyCommand(
  db: IDBDatabase,
  command: DomainCommand,
  now: number = Date.now()
): Promise<CommandOutcome> {
  const stores: StoreName[] = Object.values(STORES);
  try {
    return await withTransaction(db, stores, 'readwrite', (tx) => applyInside(tx, command, now));
  } catch (error) {
    // A quota, parse or transaction failure is reported, never papered over by
    // initialising or overwriting anything.
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function applyInside(
  tx: IDBTransaction,
  command: DomainCommand,
  now: number
): Promise<CommandOutcome> {
  switch (command.type) {
    case 'CreateQuestion': {
      const tomb = await getOne<Tombstone>(tx, STORES.tombstones, command.question.id);
      if (tomb) {
        return rejected('This question was deleted and cannot be recreated.');
      }
      const existing = await getOne<Question>(tx, STORES.questions, command.question.id);
      if (existing) {
        return rejected('A question with this id already exists.');
      }

      const source = await getOne<Source>(tx, STORES.sources, command.source.id);
      if (!source) {
        await put(tx, STORES.sources, {
          ...command.source,
          createdAt: now,
          updatedAt: now,
          rev: REV_START
        } satisfies Source);
      } else if (source.title !== command.source.title && command.source.title) {
        await put(tx, STORES.sources, { ...source, title: command.source.title, updatedAt: now, rev: source.rev + 1 });
      }

      for (const block of command.blocks) {
        const stored = await getOne<SourceBlock>(tx, STORES.blocks, block.id);
        if (!stored) {
          await put(tx, STORES.blocks, { ...block, capturedAt: now } satisfies SourceBlock);
        }
      }

      await put(tx, STORES.anchors, { ...command.anchor, createdAt: now } satisfies Anchor);

      const question: Question = {
        ...command.question,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now,
        rev: REV_START
      };
      await put(tx, STORES.questions, question);

      await put(tx, STORES.drafts, {
        questionId: question.id,
        text: command.draft?.text ?? '',
        excludedBlockIds: command.draft?.excludedBlockIds ?? [],
        background: command.draft?.background ?? '',
        updatedAt: now,
        rev: REV_START
      } satisfies QuestionDraft);

      if (command.note) {
        await put(tx, STORES.notes, {
          id: command.note.id,
          questionId: question.id,
          sourceId: command.source.id,
          text: command.note.text,
          messageId: null,
          createdAt: now,
          updatedAt: now
        } satisfies Note);
      }

      return { status: 'applied', rev: question.rev, id: question.id };
    }

    case 'CreateChildQuestion': {
      const parent = await getOne<Question>(tx, STORES.questions, command.parentQuestionId);
      if (!parent) {
        return rejected('The parent question does not exist.');
      }
      const parentMessage = await getOne<Message>(tx, STORES.messages, command.parentMessageId);
      if (!parentMessage || parentMessage.questionId !== parent.id) {
        return rejected('The parent message does not belong to that question.');
      }
      const tomb = await getOne<Tombstone>(tx, STORES.tombstones, command.question.id);
      if (tomb) {
        return rejected('This question was deleted and cannot be recreated.');
      }
      const question: Question = {
        ...command.question,
        sourceId: parent.sourceId,
        anchorId: parent.anchorId,
        parentQuestionId: parent.id,
        parentMessageId: parentMessage.id,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now,
        rev: REV_START
      };
      await put(tx, STORES.questions, question);
      await put(tx, STORES.drafts, {
        questionId: question.id,
        text: command.draft?.text ?? '',
        excludedBlockIds: command.draft?.excludedBlockIds ?? [],
        background: command.draft?.background ?? '',
        updatedAt: now,
        rev: REV_START
      } satisfies QuestionDraft);
      return { status: 'applied', rev: question.rev, id: question.id };
    }

    case 'UpdateDraft': {
      const question = await getOne<Question>(tx, STORES.questions, command.questionId);
      if (!question) {
        return rejected('The question no longer exists.');
      }
      const draft = await getOne<QuestionDraft>(tx, STORES.drafts, command.questionId);
      const currentRev = draft?.rev ?? 0;
      if (command.baseRev > currentRev) {
        return rejected('The draft revision is ahead of storage; refusing an invalid future revision.');
      }
      if (command.baseRev < currentRev) {
        return conflict(currentRev, draft?.text);
      }
      const next: QuestionDraft = {
        questionId: command.questionId,
        text: command.text ?? draft?.text ?? '',
        excludedBlockIds: command.excludedBlockIds ?? draft?.excludedBlockIds ?? [],
        background: command.background ?? draft?.background ?? '',
        updatedAt: now,
        rev: currentRev + 1
      };
      await put(tx, STORES.drafts, next);
      if (question.titleSource === 'auto' && command.text !== undefined) {
        const anchor = await getOne<Anchor>(tx, STORES.anchors, question.anchorId);
        await put(tx, STORES.questions, {
          ...question,
          title: autoTitle(command.text, anchor?.selectedText ?? ''),
          updatedAt: now,
          rev: question.rev + 1
        });
      }
      return { status: 'applied', rev: next.rev, id: command.questionId };
    }

    case 'RenameQuestion': {
      const question = await getOne<Question>(tx, STORES.questions, command.questionId);
      if (!question) {
        return rejected('The question no longer exists.');
      }
      if (command.baseRev !== question.rev) {
        return conflict(question.rev);
      }
      const title = command.title.trim();
      if (!title) {
        return rejected('A title cannot be empty.');
      }
      await put(tx, STORES.questions, {
        ...question,
        title,
        titleSource: 'user',
        updatedAt: now,
        rev: question.rev + 1
      });
      return { status: 'applied', rev: question.rev + 1, id: question.id };
    }

    case 'FreezeSnapshot': {
      const question = await getOne<Question>(tx, STORES.questions, command.questionId);
      if (!question) {
        return rejected('The question no longer exists.');
      }
      const existing = await getOne<ContextSnapshot>(tx, STORES.snapshots, command.snapshot.id);
      if (existing) {
        return rejected('A snapshot with this id already exists; snapshots are immutable.');
      }
      await put(tx, STORES.snapshots, { ...command.snapshot, createdAt: now } satisfies ContextSnapshot);
      await put(tx, STORES.links, {
        ...command.link,
        createdAt: now,
        updatedAt: now,
        rev: REV_START
      } satisfies ProviderLink);
      await put(tx, STORES.questions, { ...question, updatedAt: now, rev: question.rev + 1 });
      return { status: 'applied', rev: question.rev + 1, id: command.snapshot.id };
    }

    case 'UpdateRun': {
      const link = await getOne<ProviderLink>(tx, STORES.links, command.linkId);
      if (!link) {
        return rejected('The provider link no longer exists.');
      }
      if (link.attemptId && link.attemptId !== command.attemptId) {
        return rejected('This update belongs to a superseded attempt.');
      }
      if (command.baseRev !== link.rev) {
        return conflict(link.rev);
      }
      const next: ProviderLink = {
        ...link,
        run: command.run ?? link.run,
        conversationUrl: command.conversationUrl === undefined ? link.conversationUrl : command.conversationUrl,
        acknowledgement: command.acknowledgement === undefined ? link.acknowledgement : command.acknowledgement,
        model: command.model === undefined ? link.model : command.model,
        updatedAt: now,
        rev: link.rev + 1
      };
      await put(tx, STORES.links, next);
      return { status: 'applied', rev: next.rev, id: link.id };
    }

    case 'AppendOrReviseCapturedMessage': {
      const question = await getOne<Question>(tx, STORES.questions, command.questionId);
      if (!question) {
        return rejected('The question no longer exists.');
      }
      const link = await getOne<ProviderLink>(tx, STORES.links, command.linkId);
      if (!link || link.questionId !== question.id) {
        return rejected('The provider link does not belong to that question.');
      }
      if (link.attemptId && link.attemptId !== command.attemptId) {
        return rejected('This capture belongs to a superseded attempt.');
      }

      const messages = await getAllByIndex<Message>(tx, STORES.messages, 'questionId', question.id);
      const match =
        (command.message.id && messages.find((entry) => entry.id === command.message.id)) ||
        (command.message.providerMessageId &&
          messages.find((entry) => entry.providerMessageId === command.message.providerMessageId)) ||
        messages.find(
          (entry) => entry.ordinal === command.message.ordinal && entry.role === command.message.role
        );

      const id = match?.id ?? command.message.id ?? newMessageId();
      const stored: Message = {
        id,
        questionId: question.id,
        role: command.message.role,
        text: command.message.text,
        partial: command.message.partial,
        providerMessageId: command.message.providerMessageId,
        ordinal: command.message.ordinal,
        snapshotId: command.message.snapshotId,
        attemptId: command.message.attemptId,
        capturedAt: now,
        rev: (match?.rev ?? 0) + 1
      };
      // A completed message is never regressed to a partial one by a late read.
      if (match && !match.partial && command.message.partial) {
        return { status: 'applied', rev: match.rev, id: match.id };
      }
      await put(tx, STORES.messages, stored);
      await put(tx, STORES.links, {
        ...link,
        capture: command.capture,
        capturedThroughMessageId: command.capturedThroughMessageId,
        lastCaptureAt: now,
        run: command.message.partial ? 'streaming' : link.run === 'streaming' ? 'completed' : link.run,
        updatedAt: now,
        rev: link.rev + 1
      } satisfies ProviderLink);
      return { status: 'applied', rev: stored.rev, id: stored.id };
    }

    case 'ResolveQuestion':
    case 'ReopenQuestion':
    case 'ArchiveQuestion': {
      const question = await getOne<Question>(tx, STORES.questions, command.questionId);
      if (!question) {
        return rejected('The question no longer exists.');
      }
      if (command.baseRev !== question.rev) {
        return conflict(question.rev);
      }
      const lifecycle = nextLifecycle(question.lifecycle, command.type);
      if (!lifecycle) {
        return rejected(`Cannot ${command.type} a question that is ${question.lifecycle}.`);
      }
      await put(tx, STORES.questions, { ...question, lifecycle, updatedAt: now, rev: question.rev + 1 });
      return { status: 'applied', rev: question.rev + 1, id: question.id };
    }

    case 'SaveNote': {
      const question = await getOne<Question>(tx, STORES.questions, command.note.questionId);
      if (!question) {
        return rejected('The question no longer exists.');
      }
      const existing = await getOne<Note>(tx, STORES.notes, command.note.id);
      await put(tx, STORES.notes, {
        ...command.note,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      } satisfies Note);
      return { status: 'applied', rev: 1, id: command.note.id };
    }

    case 'DeleteNote': {
      const existing = await getOne<Note>(tx, STORES.notes, command.noteId);
      if (!existing) {
        return rejected('The note no longer exists.');
      }
      await remove(tx, STORES.notes, command.noteId);
      return { status: 'applied', rev: 1, id: command.noteId };
    }

    case 'DeleteQuestion': {
      const question = await getOne<Question>(tx, STORES.questions, command.questionId);
      if (!question) {
        // Deleting something already gone still leaves a tombstone so a delayed
        // write cannot bring it back.
        await put(tx, STORES.tombstones, { id: command.questionId, kind: 'question', deletedAt: now } satisfies Tombstone);
        return { status: 'applied', rev: 0, id: command.questionId };
      }

      const children = await getAllByIndex<Question>(tx, STORES.questions, 'parentQuestionId', question.id);
      if (command.descendants === 'subtree') {
        for (const child of children) {
          await applyInside(tx, { type: 'DeleteQuestion', questionId: child.id, descendants: 'subtree' }, now);
        }
      } else {
        for (const child of children) {
          await put(tx, STORES.questions, {
            ...child,
            parentQuestionId: question.parentQuestionId,
            parentMessageId: question.parentQuestionId ? question.parentMessageId : null,
            updatedAt: now,
            rev: child.rev + 1
          });
        }
      }

      const snapshots = await getAllByIndex<ContextSnapshot>(tx, STORES.snapshots, 'questionId', question.id);
      const referencedBlocks = new Set<string>();
      for (const snapshot of snapshots) {
        snapshot.blocks.forEach((ref) => referencedBlocks.add(ref.blockId));
        await remove(tx, STORES.snapshots, snapshot.id);
      }
      for (const message of await getAllByIndex<Message>(tx, STORES.messages, 'questionId', question.id)) {
        await remove(tx, STORES.messages, message.id);
      }
      for (const link of await getAllByIndex<ProviderLink>(tx, STORES.links, 'questionId', question.id)) {
        await remove(tx, STORES.links, link.id);
      }
      for (const note of await getAllByIndex<Note>(tx, STORES.notes, 'questionId', question.id)) {
        await remove(tx, STORES.notes, note.id);
      }
      await remove(tx, STORES.drafts, question.id);

      // The anchor is owned by this question unless a child still points at it.
      const anchorSharers = (await getAllByIndex<Question>(tx, STORES.questions, 'sourceId', question.sourceId)).filter(
        (other) => other.id !== question.id && other.anchorId === question.anchorId
      );
      if (!anchorSharers.length) {
        await remove(tx, STORES.anchors, question.anchorId);
      }

      await remove(tx, STORES.questions, question.id);
      await put(tx, STORES.tombstones, { id: question.id, kind: 'question', deletedAt: now } satisfies Tombstone);

      for (const blockId of referencedBlocks) {
        if (!(await blockStillReferenced(tx, blockId, question.id))) {
          await remove(tx, STORES.blocks, blockId);
        }
      }

      // A source with no questions left is removed too; it can be recreated from
      // the page if the Owner asks again.
      const remaining = await getAllByIndex<Question>(tx, STORES.questions, 'sourceId', question.sourceId);
      if (!remaining.length) {
        for (const block of await getAllByIndex<SourceBlock>(tx, STORES.blocks, 'sourceId', question.sourceId)) {
          await remove(tx, STORES.blocks, block.id);
        }
        for (const note of await getAllByIndex<Note>(tx, STORES.notes, 'sourceId', question.sourceId)) {
          await remove(tx, STORES.notes, note.id);
        }
        await remove(tx, STORES.sources, question.sourceId);
      }

      return { status: 'applied', rev: 0, id: question.id };
    }

    case 'AliasSource': {
      const source = await getOne<Source>(tx, STORES.sources, command.sourceId);
      if (!source) {
        return rejected('The source no longer exists.');
      }
      if (source.conversationId && source.conversationId !== command.conversationId) {
        return rejected('The source already belongs to a different conversation.');
      }
      await put(tx, STORES.sources, {
        ...source,
        conversationId: command.conversationId,
        scopeKey: command.scopeKey,
        url: command.url,
        updatedAt: now,
        rev: source.rev + 1
      });
      return { status: 'applied', rev: source.rev + 1, id: source.id };
    }

    default:
      return rejected('Unknown command.');
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export interface QuestionListEntry {
  question: Question;
  draft: QuestionDraft | null;
  latestLink: ProviderLink | null;
  messageCount: number;
  noteCount: number;
}

export interface SourceListEntry {
  source: Source;
  questionCount: number;
  activeCount: number;
  lastActivityAt: number;
}

export interface QuestionBundle {
  question: Question;
  source: Source | null;
  anchor: Anchor | null;
  draft: QuestionDraft | null;
  snapshots: ContextSnapshot[];
  messages: Message[];
  links: ProviderLink[];
  notes: Note[];
  children: Question[];
  parent: Question | null;
}

export async function listSources(db: IDBDatabase): Promise<SourceListEntry[]> {
  return withTransaction(db, [STORES.sources, STORES.questions], 'readonly', async (tx) => {
    const sources = (await requestToPromise(tx.objectStore(STORES.sources).getAll())) as Source[];
    const entries: SourceListEntry[] = [];
    for (const source of sources) {
      const questions = await getAllByIndex<Question>(tx, STORES.questions, 'sourceId', source.id);
      entries.push({
        source,
        questionCount: questions.length,
        activeCount: questions.filter((question) => question.lifecycle === 'active').length,
        lastActivityAt: Math.max(source.updatedAt, ...questions.map((question) => question.updatedAt))
      });
    }
    return entries.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  });
}

export async function listQuestionsForSource(
  db: IDBDatabase,
  sourceId: string
): Promise<QuestionListEntry[]> {
  return withTransaction(
    db,
    [STORES.questions, STORES.drafts, STORES.links, STORES.messages, STORES.notes],
    'readonly',
    async (tx) => {
      const questions = await getAllByIndex<Question>(tx, STORES.questions, 'sourceId', sourceId);
      const entries: QuestionListEntry[] = [];
      for (const question of questions) {
        const links = await getAllByIndex<ProviderLink>(tx, STORES.links, 'questionId', question.id);
        const messages = await getAllByIndex<Message>(tx, STORES.messages, 'questionId', question.id);
        const notes = await getAllByIndex<Note>(tx, STORES.notes, 'questionId', question.id);
        entries.push({
          question,
          draft: (await getOne<QuestionDraft>(tx, STORES.drafts, question.id)) ?? null,
          latestLink: links.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null,
          messageCount: messages.length,
          noteCount: notes.length
        });
      }
      return entries.sort((left, right) => left.question.createdAt - right.question.createdAt);
    }
  );
}

export async function findSourcesByScope(db: IDBDatabase, scopeKey: string): Promise<Source[]> {
  return withTransaction(db, [STORES.sources], 'readonly', (tx) =>
    getAllByIndex<Source>(tx, STORES.sources, 'scopeKey', scopeKey)
  );
}

export async function getQuestionBundle(
  db: IDBDatabase,
  questionId: string
): Promise<QuestionBundle | null> {
  return withTransaction(db, Object.values(STORES), 'readonly', async (tx) => {
    const question = await getOne<Question>(tx, STORES.questions, questionId);
    if (!question) {
      return null;
    }
    const messages = await getAllByIndex<Message>(tx, STORES.messages, 'questionId', question.id);
    return {
      question,
      source: (await getOne<Source>(tx, STORES.sources, question.sourceId)) ?? null,
      anchor: (await getOne<Anchor>(tx, STORES.anchors, question.anchorId)) ?? null,
      draft: (await getOne<QuestionDraft>(tx, STORES.drafts, question.id)) ?? null,
      snapshots: (await getAllByIndex<ContextSnapshot>(tx, STORES.snapshots, 'questionId', question.id)).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
      messages: messages.sort((left, right) => left.ordinal - right.ordinal),
      links: (await getAllByIndex<ProviderLink>(tx, STORES.links, 'questionId', question.id)).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
      notes: await getAllByIndex<Note>(tx, STORES.notes, 'questionId', question.id),
      children: await getAllByIndex<Question>(tx, STORES.questions, 'parentQuestionId', question.id),
      parent: question.parentQuestionId
        ? (await getOne<Question>(tx, STORES.questions, question.parentQuestionId)) ?? null
        : null
    };
  });
}

export interface SearchHit {
  question: Question;
  sourceTitle: string;
  matchedIn: 'title' | 'draft' | 'message';
}

export async function searchQuestions(db: IDBDatabase, term: string, limit = 50): Promise<SearchHit[]> {
  const needle = term.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return withTransaction(
    db,
    [STORES.questions, STORES.sources, STORES.drafts, STORES.messages],
    'readonly',
    async (tx) => {
      const questions = (await requestToPromise(tx.objectStore(STORES.questions).getAll())) as Question[];
      const hits: SearchHit[] = [];
      for (const question of questions) {
        const source = await getOne<Source>(tx, STORES.sources, question.sourceId);
        const sourceTitle = source?.title ?? '';
        if (question.title.toLowerCase().includes(needle) || sourceTitle.toLowerCase().includes(needle)) {
          hits.push({ question, sourceTitle, matchedIn: 'title' });
        } else {
          const draft = await getOne<QuestionDraft>(tx, STORES.drafts, question.id);
          if (draft?.text.toLowerCase().includes(needle)) {
            hits.push({ question, sourceTitle, matchedIn: 'draft' });
          } else {
            const messages = await getAllByIndex<Message>(tx, STORES.messages, 'questionId', question.id);
            if (messages.some((message) => message.text.toLowerCase().includes(needle))) {
              hits.push({ question, sourceTitle, matchedIn: 'message' });
            }
          }
        }
        if (hits.length >= limit) {
          break;
        }
      }
      return hits;
    }
  );
}

export interface DatabaseDump {
  sources: Source[];
  blocks: SourceBlock[];
  anchors: Anchor[];
  questions: Question[];
  drafts: QuestionDraft[];
  snapshots: ContextSnapshot[];
  messages: Message[];
  links: ProviderLink[];
  notes: Note[];
  tombstones: Tombstone[];
}

export async function dumpAll(db: IDBDatabase): Promise<DatabaseDump> {
  return withTransaction(db, Object.values(STORES), 'readonly', async (tx) => ({
    sources: (await requestToPromise(tx.objectStore(STORES.sources).getAll())) as Source[],
    blocks: (await requestToPromise(tx.objectStore(STORES.blocks).getAll())) as SourceBlock[],
    anchors: (await requestToPromise(tx.objectStore(STORES.anchors).getAll())) as Anchor[],
    questions: (await requestToPromise(tx.objectStore(STORES.questions).getAll())) as Question[],
    drafts: (await requestToPromise(tx.objectStore(STORES.drafts).getAll())) as QuestionDraft[],
    snapshots: (await requestToPromise(tx.objectStore(STORES.snapshots).getAll())) as ContextSnapshot[],
    messages: (await requestToPromise(tx.objectStore(STORES.messages).getAll())) as Message[],
    links: (await requestToPromise(tx.objectStore(STORES.links).getAll())) as ProviderLink[],
    notes: (await requestToPromise(tx.objectStore(STORES.notes).getAll())) as Note[],
    tombstones: (await requestToPromise(tx.objectStore(STORES.tombstones).getAll())) as Tombstone[]
  }));
}

export async function readMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return withTransaction(db, [STORES.meta], 'readonly', async (tx) => {
    const row = (await getOne<{ key: string; value: T }>(tx, STORES.meta, key)) ?? undefined;
    return row?.value;
  });
}

export async function writeMeta<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
  await withTransaction(db, [STORES.meta], 'readwrite', async (tx) => {
    await put(tx, STORES.meta, { key, value });
  });
}

export { newQuestionId };
