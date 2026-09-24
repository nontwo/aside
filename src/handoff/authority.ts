/**
 * The worker's authority over scratch handoffs.
 *
 * One writer: every change to a scratch session goes through here, one at a
 * time. The source tab is the authorization — a request is accepted only from
 * the tab the session was created in (or from an extension page such as the
 * toolbar popup), never on the strength of a session id the page supplies.
 *
 * Retention: memory, mirrored to chrome.storage.session for recovery across a
 * worker restart or a source reload. Never extension local/sync storage, never
 * the question database. If session storage is unavailable, the session lives
 * in memory only and the caller is told so.
 *
 * External actions happen only as the direct result of a user request: opening
 * or focusing the native page, focusing the source, closing a demonstrably
 * owned tab on End. Rehydration after a restart never opens, focuses or copies.
 */

import { isProviderUrl, launchFor } from './routes';
import type {
  AnchorResult,
  HandoffChangedMessage,
  HandoffCode,
  HandoffRequest,
  HandoffResponse,
  HandoffTarget,
  ScratchHandoff
} from './types';

export const HANDOFF_STORAGE_PREFIX = 'aside:handoff:';
/** A creation that has not completed within this window is presumed interrupted. */
export const OPENING_STALE_MS = 20_000;
/** Upper bound on one serialized session; a selection is text, not a document dump. */
export const MAX_SESSION_BYTES = 1_000_000;

export interface StorageAreaLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface TabLike {
  id?: number;
  windowId?: number;
  url?: string;
  index?: number;
}

export interface WindowLike {
  id?: number;
  state?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs?: TabLike[];
}

export interface HandoffEnv {
  buildId: string;
  extensionId: string;
  now(): number;
  randomId(): string;
  /** chrome.storage.session, or null when unavailable. */
  session: StorageAreaLike | null;
  tabs: {
    create(props: { url: string; windowId?: number; index?: number; active?: boolean }): Promise<TabLike>;
    update(tabId: number, props: { url?: string; active?: boolean }): Promise<TabLike | undefined>;
    get(tabId: number): Promise<TabLike>;
    remove(tabId: number): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  windows: {
    create(props: { url: string; focused?: boolean; type?: 'normal' }): Promise<WindowLike>;
    update(windowId: number, props: { focused?: boolean; left?: number; top?: number; width?: number; height?: number }): Promise<unknown>;
    get(windowId: number, options?: { populate?: boolean }): Promise<WindowLike>;
  };
  /** Commits an explicit local note through the storage authority. */
  saveNote?(
    session: ScratchHandoff,
    input: { note: string; excerpt: string; title: string; sourceTitle: string }
  ): Promise<{ questionId: string }>;
}

export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: { id?: number; windowId?: number; url?: string };
}

type Caller =
  | { kind: 'source'; tabId: number; windowId: number | null; url: string }
  | { kind: 'extension-page' };

const RETIRED_TYPES = new Set([
  'CREATE_BRANCH_WINDOW',
  'RECHECK_BRANCH_IN_TAB',
  'RUN_BRANCH_PROMPT_IN_TAB',
  'BRANCH_AUTOMATION_EVENT'
]);

/** True for message types this build no longer executes, from any client. */
export function isRetiredAutomationMessage(type: unknown): boolean {
  return typeof type === 'string' && RETIRED_TYPES.has(type);
}

export function isHandoffRequestType(type: unknown): boolean {
  return typeof type === 'string' && type.startsWith('HANDOFF_');
}

/** A conversation's own path on a provider, if the URL is one; not the query. */
export function conversationPathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match =
      parsed.pathname.match(/^(\/g\/[^/]+)?\/c\/[A-Za-z0-9-]+/) ?? parsed.pathname.match(/^\/chat\/[A-Za-z0-9-]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown, max = 200_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isString(value: unknown, max = 200_000): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isDraft(value: unknown): value is ScratchHandoff['draft'] {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return (
    isString(draft.question, 20_000) &&
    isString(draft.background, 100_000) &&
    Array.isArray(draft.excludedBlockIds) &&
    draft.excludedBlockIds.length <= 500 &&
    draft.excludedBlockIds.every((id) => isNonEmptyString(id, 400))
  );
}

function isSelection(value: unknown): value is ScratchHandoff['selection'] {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const selection = value as Record<string, unknown>;
  return (
    isNonEmptyString(selection.selectedText) &&
    isString(selection.rootChatUrl, 4_000) &&
    isString(selection.branchBaseMessageId, 400) &&
    Array.isArray(selection.selectedBlocks) &&
    Boolean(selection.rangeQuotes) &&
    typeof selection.rangeQuotes === 'object'
  );
}

function isPrompt(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const prompt = value as Record<string, unknown>;
  return (
    typeof prompt.revision === 'number' &&
    isNonEmptyString(prompt.text, 400_000) &&
    isString(prompt.question, 20_000) &&
    Array.isArray(prompt.included) &&
    Array.isArray(prompt.omitted) &&
    Array.isArray(prompt.missing)
  );
}

export class HandoffAuthority {
  private readonly sessions = new Map<string, ScratchHandoff>();
  private hydration: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** True once a write to session storage failed or the area was absent. */
  memoryOnly: boolean;

  constructor(private readonly env: HandoffEnv) {
    this.memoryOnly = env.session === null;
  }

  /* ---------------------------- persistence --------------------------- */

  private hydrate(): Promise<void> {
    this.hydration ??= (async () => {
      if (!this.env.session) {
        return;
      }
      try {
        const stored = await this.env.session.get(null);
        Object.entries(stored).forEach(([key, value]) => {
          if (!key.startsWith(HANDOFF_STORAGE_PREFIX) || !value || typeof value !== 'object') {
            return;
          }
          const record = value as ScratchHandoff;
          if (typeof record.sessionId === 'string' && !this.sessions.has(record.sessionId)) {
            this.sessions.set(record.sessionId, record);
          }
        });
      } catch {
        this.memoryOnly = true;
      }
    })();
    return this.hydration;
  }

  private async persist(session: ScratchHandoff): Promise<void> {
    this.sessions.set(session.sessionId, session);
    if (!this.env.session || this.memoryOnly) {
      return;
    }
    try {
      await this.env.session.set({ [HANDOFF_STORAGE_PREFIX + session.sessionId]: session });
    } catch {
      // Full or unavailable: keep the session in memory and say so. Never disk.
      this.memoryOnly = true;
    }
  }

  private async purge(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    if (!this.env.session) {
      return;
    }
    try {
      await this.env.session.remove(HANDOFF_STORAGE_PREFIX + sessionId);
    } catch {
      // The in-memory copy is gone; a stale session-storage copy cannot be
      // re-read into this worker because hydration already ran.
    }
  }

  /** Run one operation at a time, so two clicks cannot interleave. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /* ------------------------------ helpers ----------------------------- */

  private respond(ok: boolean, code: HandoffCode, extra: Partial<HandoffResponse> = {}): HandoffResponse {
    return { ok, code, buildId: this.env.buildId, ...extra };
  }

  private callerOf(sender: SenderLike): Caller | null {
    if (sender.id !== this.env.extensionId) {
      return null;
    }
    // An extension page (the toolbar popup, the library) is trusted as such even
    // when it happens to be open in a tab. A content script's sender URL is the
    // provider page, never this extension's origin.
    if ((sender.url ?? '').startsWith(`chrome-extension://${this.env.extensionId}/`)) {
      return { kind: 'extension-page' };
    }
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      if (sender.frameId !== undefined && sender.frameId !== 0) {
        return null;
      }
      return {
        kind: 'source',
        tabId,
        windowId: typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : null,
        url: sender.tab?.url ?? sender.url ?? ''
      };
    }
    return null;
  }

  /** The session, if this caller may act on it. */
  private owned(sessionId: unknown, caller: Caller): ScratchHandoff | null {
    if (typeof sessionId !== 'string') {
      return null;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (caller.kind === 'extension-page') {
      return session;
    }
    return session.source.tabId === caller.tabId ? session : null;
  }

  private bump(session: ScratchHandoff, patch: Partial<ScratchHandoff>): ScratchHandoff {
    return { ...session, ...patch, epoch: session.epoch + 1, updatedAt: this.env.now() };
  }

  private async notifySource(
    session: ScratchHandoff,
    next: ScratchHandoff | null,
    reason: HandoffChangedMessage['reason']
  ): Promise<void> {
    if (!session.source.open || session.source.tabId < 0) {
      return;
    }
    const message: HandoffChangedMessage = {
      type: 'HANDOFF_CHANGED',
      sessionId: session.sessionId,
      session: next,
      reason
    };
    try {
      await this.env.tabs.sendMessage(session.source.tabId, message);
    } catch {
      // The source page may be reloading; it re-lists on load.
    }
  }

  /* ---------------------------- public API ---------------------------- */

  /** Snapshot for tests and diagnostics. Never exported to disk. */
  async all(): Promise<ScratchHandoff[]> {
    await this.hydrate();
    return [...this.sessions.values()];
  }

  handle(message: HandoffRequest | { type?: unknown }, sender: SenderLike): Promise<HandoffResponse> {
    return this.serialize(async () => {
      await this.hydrate();
      const type = (message as { type?: unknown }).type;
      if (isRetiredAutomationMessage(type)) {
        return this.respond(false, 'retired');
      }
      const caller = this.callerOf(sender);
      if (!caller) {
        return this.respond(false, 'invalid-request');
      }
      const request = message as HandoffRequest;
      if (request.buildId !== this.env.buildId) {
        // A content script from another build: it must not create, change or
        // act on anything. The page tells the Owner to reload.
        return this.respond(false, 'stale-client');
      }
      switch (request.type) {
        case 'HANDOFF_ROLE':
          return this.role(caller);
        case 'HANDOFF_CREATE':
          return this.create(request, caller);
        case 'HANDOFF_UPDATE':
          return this.update(request, caller);
        case 'HANDOFF_COPIED':
          return this.copied(request, caller);
        case 'HANDOFF_OPEN':
          return this.open(request, caller);
        case 'HANDOFF_END':
          return this.end(request, caller);
        case 'HANDOFF_LIST_FOR_TAB':
          return this.listForTab(caller);
        case 'HANDOFF_LIST_ACTIVE':
          return caller.kind === 'extension-page'
            ? this.respond(true, 'ok', { sessions: [...this.sessions.values()] })
            : this.respond(false, 'invalid-request');
        case 'HANDOFF_RETURN':
          return this.returnToSource(request, caller);
        case 'HANDOFF_ARRANGE':
          return this.arrange(request, caller);
        case 'HANDOFF_SAVE_NOTE':
          return this.saveNote(request, caller);
        default:
          return this.respond(false, 'invalid-request');
      }
    });
  }

  private role(caller: Caller): HandoffResponse {
    if (caller.kind !== 'source') {
      return this.respond(true, 'ok', { role: 'page' });
    }
    const isTarget = [...this.sessions.values()].some((session) => session.target.tabId === caller.tabId);
    return this.respond(true, 'ok', { role: isTarget ? 'target' : 'page' });
  }

  private async create(
    request: Extract<HandoffRequest, { type: 'HANDOFF_CREATE' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    if (caller.kind !== 'source') {
      return this.respond(false, 'invalid-request');
    }
    if (
      (request.providerId !== 'chatgpt' && request.providerId !== 'claude') ||
      (request.entry !== 'ask' && request.entry !== 'why' && request.entry !== 'new_tab') ||
      !isSelection(request.selection) ||
      !isDraft(request.draft) ||
      !isString(request.scopeKey, 1_000) ||
      !isProviderUrl(request.providerId, caller.url)
    ) {
      return this.respond(false, 'invalid-request');
    }
    // A page that is itself a native destination does not start handoffs.
    if ([...this.sessions.values()].some((session) => session.target.tabId === caller.tabId)) {
      return this.respond(false, 'invalid-request');
    }
    const now = this.env.now();
    const session: ScratchHandoff = {
      sessionId: this.env.randomId(),
      epoch: 1,
      providerId: request.providerId,
      policy: 'temporary-intended',
      entry: request.entry,
      source: {
        tabId: caller.tabId,
        windowId: caller.windowId,
        scopeKey: request.scopeKey,
        url: caller.url,
        open: true
      },
      selection: request.selection,
      draft: request.draft,
      copied: null,
      clipboard: 'idle',
      target: {
        state: 'none',
        kind: request.entry === 'new_tab' ? 'tab' : 'window',
        route: null,
        tabId: null,
        windowId: null,
        windowCreated: false,
        ownership: 'owned',
        conversationPaths: [],
        openingSince: null
      },
      hidden: false,
      createdAt: now,
      updatedAt: now
    };
    if (JSON.stringify(session).length > MAX_SESSION_BYTES) {
      return this.respond(false, 'invalid-request');
    }
    await this.persist(session);
    return this.respond(true, this.memoryOnly ? 'storage-unavailable' : 'ok', { session });
  }

  private async update(
    request: Extract<HandoffRequest, { type: 'HANDOFF_UPDATE' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      // An update is never an implicit create.
      return this.respond(false, 'missing-session', { session: null });
    }
    if (request.baseEpoch !== session.epoch) {
      return this.respond(false, 'stale-epoch', { session });
    }
    if (request.draft !== undefined && !isDraft(request.draft)) {
      return this.respond(false, 'invalid-request');
    }
    const next = this.bump(session, {
      draft: request.draft ?? session.draft,
      hidden: typeof request.hidden === 'boolean' ? request.hidden : session.hidden
    });
    if (JSON.stringify(next).length > MAX_SESSION_BYTES) {
      return this.respond(false, 'invalid-request');
    }
    await this.persist(next);
    return this.respond(true, 'ok', { session: next });
  }

  private async copied(
    request: Extract<HandoffRequest, { type: 'HANDOFF_COPIED' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      return this.respond(false, 'missing-session', { session: null });
    }
    if (typeof request.ok !== 'boolean' || !isPrompt(request.prompt)) {
      return this.respond(false, 'invalid-request');
    }
    const next = this.bump(session, {
      clipboard: request.ok ? 'copied' : 'failed',
      copied: request.ok && request.prompt ? request.prompt : session.copied
    });
    await this.persist(next);
    if (caller.kind !== 'source') {
      await this.notifySource(session, next, 'updated');
    }
    return this.respond(true, 'ok', { session: next });
  }

  private async focusTab(tabId: number): Promise<TabLike | null> {
    try {
      const tab = await this.env.tabs.update(tabId, { active: true });
      const windowId = tab?.windowId;
      if (typeof windowId === 'number') {
        await this.env.windows.update(windowId, { focused: true });
      }
      return tab ?? null;
    } catch {
      return null;
    }
  }

  private async open(
    request: Extract<HandoffRequest, { type: 'HANDOFF_OPEN' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      return this.respond(false, 'missing-session', { session: null });
    }
    const target = session.target;

    // An existing target for this session: focus it, never open a second one.
    if (target.state === 'open' && typeof target.tabId === 'number') {
      const focused = await this.focusTab(target.tabId);
      if (focused) {
        return this.respond(true, 'focused-existing', { session });
      }
      // The tab is gone without a removal event reaching us. Its temporary
      // conversation cannot be restored; say so and do not reopen.
      const next = this.bump(session, { target: { ...target, state: 'closed', tabId: null } });
      await this.persist(next);
      return this.respond(false, 'target-closed', { session: next });
    }
    if (target.state === 'closed') {
      return this.respond(false, 'target-closed', { session });
    }
    if (request.focusOnly) {
      return this.respond(false, 'no-target', { session });
    }
    if (
      target.state === 'opening' &&
      target.openingSince !== null &&
      this.env.now() - target.openingSince < OPENING_STALE_MS
    ) {
      return this.respond(true, 'opening', { session });
    }

    const kind = request.kind === 'tab' ? 'tab' : 'window';
    const launch = launchFor(session.providerId, request.route === 'base' ? 'base' : 'convenience');
    let working = this.bump(session, {
      target: { ...target, state: 'opening', kind, route: launch.category, openingSince: this.env.now() }
    });
    await this.persist(working);

    try {
      // Blank first, then register, then navigate: the destination's role is
      // known before any provider document — and any content script in it —
      // exists, so it can never be mistaken for a page to act on.
      let tabId: number | undefined;
      let windowId: number | undefined;
      let windowCreated = false;
      if (kind === 'window') {
        const created = await this.env.windows.create({ url: 'about:blank', focused: true, type: 'normal' });
        tabId = created.tabs?.[0]?.id;
        windowId = created.id;
        windowCreated = true;
      } else {
        let index: number | undefined;
        let sourceWindowId = session.source.windowId ?? undefined;
        if (session.source.open) {
          try {
            const sourceTab = await this.env.tabs.get(session.source.tabId);
            index = typeof sourceTab.index === 'number' ? sourceTab.index + 1 : undefined;
            sourceWindowId = sourceTab.windowId ?? sourceWindowId;
          } catch {
            // Source gone: a tab in the last focused window is fine.
          }
        }
        const created = await this.env.tabs.create({
          url: 'about:blank',
          windowId: sourceWindowId,
          index,
          active: true
        });
        tabId = created.id;
        windowId = created.windowId;
      }
      if (typeof tabId !== 'number') {
        throw new Error('no tab id');
      }
      const registered: HandoffTarget = {
        ...working.target,
        tabId,
        windowId: typeof windowId === 'number' ? windowId : null,
        windowCreated,
        ownership: 'owned',
        conversationPaths: []
      };
      working = this.bump(working, { target: registered });
      await this.persist(working);

      await this.env.tabs.update(tabId, { url: launch.url });

      working = this.bump(working, {
        target: { ...working.target, state: 'open', openingSince: null }
      });
      await this.persist(working);
      if (caller.kind !== 'source') {
        await this.notifySource(session, working, 'updated');
      }
      return this.respond(true, 'opened', { session: working });
    } catch {
      const current = this.sessions.get(session.sessionId);
      if (!current) {
        return this.respond(false, 'missing-session', { session: null });
      }
      // A tab that was created but never navigated is left for the Owner to
      // close; it is not recorded as the target of anything.
      const reset = this.bump(current, {
        target: { ...current.target, state: 'none', tabId: null, windowId: null, openingSince: null }
      });
      await this.persist(reset);
      return this.respond(false, 'open-failed', { session: reset });
    }
  }

  private async end(
    request: Extract<HandoffRequest, { type: 'HANDOFF_END' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      return this.respond(false, 'missing-session', { session: null });
    }
    // Local material first: it must be cleared whatever happens to the tab.
    await this.purge(session.sessionId);

    let targetClosed = false;
    const target = session.target;
    if (
      request.closeTarget === true &&
      target.state === 'open' &&
      typeof target.tabId === 'number' &&
      target.ownership === 'owned'
    ) {
      try {
        const tab = await this.env.tabs.get(target.tabId);
        // Demonstrably ours: still on the provider, and not the source tab.
        if (isProviderUrl(session.providerId, tab.url) && target.tabId !== session.source.tabId) {
          await this.env.tabs.remove(target.tabId);
          targetClosed = true;
        }
      } catch {
        targetClosed = false;
      }
    }
    if (caller.kind !== 'source') {
      await this.notifySource(session, null, 'ended');
    }
    return this.respond(true, 'ok', { session: null, targetClosed });
  }

  private listForTab(caller: Caller): HandoffResponse {
    if (caller.kind !== 'source') {
      return this.respond(false, 'invalid-request');
    }
    const sessions = [...this.sessions.values()].filter((session) => session.source.tabId === caller.tabId);
    return this.respond(true, this.memoryOnly ? 'storage-unavailable' : 'ok', { sessions });
  }

  private async returnToSource(
    request: Extract<HandoffRequest, { type: 'HANDOFF_RETURN' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      return this.respond(false, 'missing-session', { session: null });
    }
    if (!session.source.open) {
      return this.respond(false, 'ok', { session, anchor: 'source-closed' });
    }
    const focused = await this.focusTab(session.source.tabId);
    if (!focused) {
      const next = this.bump(session, { source: { ...session.source, open: false } });
      await this.persist(next);
      return this.respond(false, 'ok', { session: next, anchor: 'source-closed' });
    }
    let anchor: AnchorResult = 'not-found';
    try {
      const reply = (await this.env.tabs.sendMessage(session.source.tabId, {
        type: 'HANDOFF_SCROLL_TO_ANCHOR',
        sessionId: session.sessionId
      })) as { anchor?: AnchorResult } | undefined;
      if (reply?.anchor) {
        anchor = reply.anchor;
      }
    } catch {
      anchor = 'not-found';
    }
    return this.respond(true, 'ok', { session, anchor });
  }

  private async arrange(
    request: Extract<HandoffRequest, { type: 'HANDOFF_ARRANGE' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      return this.respond(false, 'missing-session', { session: null });
    }
    const target = session.target;
    // Only a window Aside created and still owns is moved; the source window
    // is never moved or resized.
    if (
      target.state !== 'open' ||
      !target.windowCreated ||
      target.ownership !== 'owned' ||
      typeof target.windowId !== 'number' ||
      typeof session.source.windowId !== 'number'
    ) {
      return this.respond(false, 'unsupported-layout', { session });
    }
    try {
      const source = await this.env.windows.get(session.source.windowId);
      if (
        source.state === 'fullscreen' ||
        source.state === 'minimized' ||
        typeof source.left !== 'number' ||
        typeof source.top !== 'number' ||
        typeof source.width !== 'number' ||
        typeof source.height !== 'number'
      ) {
        return this.respond(false, 'unsupported-layout', { session });
      }
      const half = Math.floor(source.width / 2);
      await this.env.windows.update(target.windowId, {
        left: source.left + half,
        top: source.top,
        width: Math.max(420, source.width - half),
        height: source.height,
        focused: true
      });
      return this.respond(true, 'ok', { session });
    } catch {
      return this.respond(false, 'unsupported-layout', { session });
    }
  }

  private async saveNote(
    request: Extract<HandoffRequest, { type: 'HANDOFF_SAVE_NOTE' }>,
    caller: Caller
  ): Promise<HandoffResponse> {
    const session = this.owned(request.sessionId, caller);
    if (!session) {
      return this.respond(false, 'missing-session', { session: null });
    }
    if (
      !isString(request.note, 50_000) ||
      !isString(request.excerpt, 100_000) ||
      !isString(request.title, 400) ||
      !isString(request.sourceTitle, 400) ||
      (!request.note.trim() && !request.excerpt.trim()) ||
      !this.env.saveNote
    ) {
      return this.respond(false, 'invalid-request', { session });
    }
    try {
      const { questionId } = await this.env.saveNote(session, {
        note: request.note,
        excerpt: request.excerpt,
        title: request.title,
        sourceTitle: request.sourceTitle
      });
      // The scratch itself stays scratch: saving a note does not promote it.
      return this.respond(true, 'ok', { session, questionId });
    } catch {
      return this.respond(false, 'save-failed', { session });
    }
  }

  /* --------------------------- browser events -------------------------- */

  onTabRemoved(tabId: number): Promise<void> {
    return this.serialize(async () => {
      await this.hydrate();
      for (const session of [...this.sessions.values()]) {
        if (session.target.tabId === tabId) {
          // The native conversation is gone with its tab: end the scratch.
          await this.purge(session.sessionId);
          await this.notifySource(session, null, 'target-closed');
          continue;
        }
        if (session.source.tabId === tabId && session.source.open) {
          // The target is left alone; the session stays reachable from the
          // toolbar until it is ended or its tab closes.
          await this.persist(this.bump(session, { source: { ...session.source, open: false } }));
        }
      }
    });
  }

  onTabUpdated(tabId: number, url: string | undefined): Promise<void> {
    if (!url) {
      return Promise.resolve();
    }
    return this.serialize(async () => {
      await this.hydrate();
      for (const session of [...this.sessions.values()]) {
        if (session.target.tabId !== tabId || session.target.state === 'none') {
          continue;
        }
        const target = session.target;
        // The blank page Aside creates the tab with is where every target
        // starts, and its update event can be processed after the navigation
        // it preceded: it is never evidence that the tab left the provider.
        if (url === 'about:blank') {
          continue;
        }
        let ownership = target.ownership;
        const paths = [...target.conversationPaths];
        if (!isProviderUrl(session.providerId, url)) {
          ownership = 'uncertain';
        } else {
          const path = conversationPathOf(url);
          if (path && !paths.includes(path)) {
            paths.push(path);
            if (paths.length > 1) {
              // A second conversation in the same tab: the Owner went
              // somewhere else. Aside will focus it but never close it.
              ownership = 'uncertain';
            }
          }
        }
        if (ownership !== target.ownership || paths.length !== target.conversationPaths.length) {
          const next = this.bump(session, { target: { ...target, ownership, conversationPaths: paths.slice(0, 4) } });
          await this.persist(next);
          await this.notifySource(session, next, 'updated');
        }
      }
    });
  }

  onTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    return this.serialize(async () => {
      await this.hydrate();
      for (const session of [...this.sessions.values()]) {
        if (session.target.tabId === removedTabId) {
          const next = this.bump(session, {
            target: { ...session.target, tabId: addedTabId, ownership: 'uncertain' }
          });
          await this.persist(next);
          await this.notifySource(session, next, 'updated');
        }
        if (session.source.tabId === removedTabId) {
          await this.persist(this.bump(session, { source: { ...session.source, tabId: addedTabId } }));
        }
      }
    });
  }
}
