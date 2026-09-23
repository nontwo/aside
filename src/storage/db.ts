/**
 * The extension-origin IndexedDB that holds durable question records.
 *
 * Opened by the service worker only. The schema is versioned; an upgrade runs in
 * `onupgradeneeded` and is the only place object stores are created, so a
 * mismatched client can never half-initialise the database.
 */

export const DB_NAME = 'aside-questions';
export const DB_VERSION = 1;

export const STORES = {
  sources: 'sources',
  blocks: 'blocks',
  anchors: 'anchors',
  questions: 'questions',
  drafts: 'drafts',
  snapshots: 'snapshots',
  messages: 'messages',
  links: 'links',
  notes: 'notes',
  tombstones: 'tombstones',
  meta: 'meta'
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export const ALL_STORES: StoreName[] = Object.values(STORES);

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const sources = db.createObjectStore(STORES.sources, { keyPath: 'id' });
    sources.createIndex('scopeKey', 'scopeKey', { unique: false });
    sources.createIndex('conversationId', 'conversationId', { unique: false });

    const blocks = db.createObjectStore(STORES.blocks, { keyPath: 'id' });
    blocks.createIndex('sourceId', 'sourceId', { unique: false });

    const anchors = db.createObjectStore(STORES.anchors, { keyPath: 'id' });
    anchors.createIndex('sourceId', 'sourceId', { unique: false });

    const questions = db.createObjectStore(STORES.questions, { keyPath: 'id' });
    questions.createIndex('sourceId', 'sourceId', { unique: false });
    questions.createIndex('parentQuestionId', 'parentQuestionId', { unique: false });
    questions.createIndex('lifecycle', 'lifecycle', { unique: false });

    db.createObjectStore(STORES.drafts, { keyPath: 'questionId' });

    const snapshots = db.createObjectStore(STORES.snapshots, { keyPath: 'id' });
    snapshots.createIndex('questionId', 'questionId', { unique: false });

    const messages = db.createObjectStore(STORES.messages, { keyPath: 'id' });
    messages.createIndex('questionId', 'questionId', { unique: false });

    const links = db.createObjectStore(STORES.links, { keyPath: 'id' });
    links.createIndex('questionId', 'questionId', { unique: false });

    const notes = db.createObjectStore(STORES.notes, { keyPath: 'id' });
    notes.createIndex('questionId', 'questionId', { unique: false });
    notes.createIndex('sourceId', 'sourceId', { unique: false });

    db.createObjectStore(STORES.tombstones, { keyPath: 'id' });
    db.createObjectStore(STORES.meta, { keyPath: 'key' });
  }
}

let opening: Promise<IDBDatabase> | null = null;

export function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion);
    };
    request.onsuccess = () => {
      const db = request.result;
      // If another client upgrades the schema, close so the upgrade can proceed
      // and the next call reopens at the new version rather than holding it back.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      opening = null;
      reject(new Error('IndexedDB open blocked by another connection'));
    };
  });
  return opening;
}

/** Test hook: forget the cached connection so a fresh factory can be used. */
export function resetDatabaseConnection(): void {
  opening = null;
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
  });
}

/**
 * Run work inside one transaction and resolve only after it has committed.
 *
 * The callback must not await anything outside IndexedDB: an `await` on a
 * network call or a message would let the transaction auto-commit underneath
 * it. Persist intent, commit, then do the external work.
 */
export async function withTransaction<T>(
  db: IDBDatabase,
  stores: StoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = transactionDone(tx);
  let result: T;
  try {
    result = await work(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already aborted.
    }
    throw error;
  }
  await done;
  return result;
}
