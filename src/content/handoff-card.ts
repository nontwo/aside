/**
 * The handoff card: a disposable reading question on its way to a native
 * temporary conversation the Owner runs themselves.
 *
 * What the card does automatically: shows the passage, prepares one readable
 * prompt from it, and keeps that prompt identical to what it copies. What it
 * does only when the Owner clicks: copy the prompt, open or focus the native
 * page, save a local note, end the scratch. What it never does: type, paste or
 * send in a provider page, choose the native mode, personalization or model,
 * or read the native answer back.
 *
 * The card lives in the SOURCE page only. Nothing from it is ever placed in
 * the native destination's DOM.
 */

import { autoTitle } from '../domain/commands';
import { planForHandoff, preparePrompt, focusTextOf } from '../handoff/prompt';
import { NATIVE_HANDOFF_INSTRUCTION, routeFor } from '../handoff/routes';
import type {
  AnchorResult,
  HandoffCode,
  HandoffDraft,
  HandoffRequest,
  HandoffResponse,
  PreparedPrompt,
  ScratchHandoff
} from '../handoff/types';
import { clipText, compactWhitespace } from '../shared/utils';

export const HANDOFF_CARD_CLASS = 'aside-handoff';

export interface HandoffCardDeps {
  buildId: string;
  /** Put an element into Aside's own host in the source page. */
  mount(element: HTMLElement): void;
  notify(message: string): void;
  /** Send to the worker; null when the extension runtime is gone. */
  send(message: HandoffRequest): Promise<HandoffResponse | null>;
  writeClipboard(text: string): Promise<{ ok: boolean; code: HandoffCode }>;
  jumpToPassage(session: ScratchHandoff): AnchorResult;
  openLibrary(): void;
  /** The card's visibility changed; the rail may need an entry. */
  onVisibilityChange(card: HandoffCard): void;
  /** The card is gone for good. */
  onDisposed(card: HandoffCard): void;
}

/**
 * What the card may say about the clipboard. `here` is true only for a copy this
 * card made in this page: a copy recorded earlier (a reload, the popup) may have
 * been replaced by anything since, so it is never claimed as current.
 */
type ClipboardLine =
  | { kind: 'idle' }
  | { kind: 'copied'; revision: number; here: boolean }
  | { kind: 'failed'; code: HandoffCode }
  | { kind: 'replaced' };

function clipboardLineFrom(session: ScratchHandoff): ClipboardLine {
  if (session.clipboard === 'copied' && session.copied) {
    return { kind: 'copied', revision: session.copied.revision, here: false };
  }
  if (session.clipboard === 'failed') {
    return { kind: 'failed', code: 'clipboard-denied' };
  }
  if (session.clipboard === 'replaced') {
    return { kind: 'replaced' };
  }
  return { kind: 'idle' };
}

const DRAFT_SYNC_DELAY_MS = 400;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; role?: string; type?: string } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) {
    node.className = options.className;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  if (options.role) {
    node.dataset.asideRole = options.role;
  }
  if (options.type && node instanceof HTMLButtonElement) {
    node.type = options.type as 'button';
  }
  return node;
}

function button(text: string, role: string, className = 'aside-panel-secondary'): HTMLButtonElement {
  const node = el('button', { className, text, role });
  node.type = 'button';
  return node;
}

function anchorMessage(result: AnchorResult): string {
  switch (result) {
    case 'exact':
      return '';
    case 'message-only':
      return 'The passage has changed on the page; showing the message it was in.';
    case 'ambiguous':
      return 'The passage appears more than once on the page, so Aside did not jump to a guess.';
    case 'different-conversation':
      return 'This tab now shows a different conversation.';
    case 'source-closed':
      return 'The source tab was closed.';
    default:
      return 'The passage is no longer on this page.';
  }
}

export class HandoffCard {
  readonly element: HTMLDivElement;
  session: ScratchHandoff;
  /** True once End or a target close has cleared this session. */
  ended = false;

  private readonly deps: HandoffCardDeps;
  private readonly providerLabel: string;
  private draft: HandoffDraft;
  private prompt: PreparedPrompt;
  private lastCopied: PreparedPrompt | null;
  private clipboardLine: ClipboardLine;
  private targetLine = '';
  private anchorLine = '';
  private busy = false;
  private syncTimer: number | undefined;
  private syncing: Promise<void> = Promise.resolve();
  private memoryOnly = false;
  private staleClient = false;
  private readonly cleanups: Array<() => void> = [];

  // Nodes that change.
  private readonly titleEl: HTMLHeadingElement;
  private readonly questionInput: HTMLTextAreaElement;
  private readonly contextSummary: HTMLParagraphElement;
  private readonly missingEl: HTMLParagraphElement;
  private readonly budgetEl: HTMLParagraphElement;
  private readonly blockList: HTMLDivElement;
  private readonly backgroundInput: HTMLTextAreaElement;
  private readonly promptPreview: HTMLPreElement;
  private readonly primaryButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  private readonly plainButton: HTMLButtonElement;
  private readonly clipboardStatus: HTMLParagraphElement;
  private readonly targetStatus: HTMLParagraphElement;
  private readonly manualCopy: HTMLTextAreaElement;
  private readonly guide: HTMLDivElement;
  private readonly arrangeButton: HTMLButtonElement;
  private readonly moreDetails: HTMLDetailsElement;
  private readonly endConfirm: HTMLDivElement;
  private readonly endConfirmText: HTMLParagraphElement;
  private readonly noteForm: HTMLDivElement;
  private readonly noteTitle: HTMLInputElement;
  private readonly noteText: HTMLTextAreaElement;
  private readonly noteExcerpt: HTMLTextAreaElement;
  private readonly notePreview: HTMLDivElement;
  private readonly noteStatus: HTMLParagraphElement;
  private readonly bodyEl: HTMLDivElement;

  constructor(session: ScratchHandoff, deps: HandoffCardDeps, options: { memoryOnly?: boolean } = {}) {
    this.session = session;
    this.deps = deps;
    this.memoryOnly = Boolean(options.memoryOnly);
    const route = routeFor(session.providerId);
    this.providerLabel = route.label;
    this.draft = { ...session.draft, excludedBlockIds: [...session.draft.excludedBlockIds] };
    this.lastCopied = session.copied;
    this.prompt = preparePrompt(session.selection, this.draft, this.lastCopied);
    this.clipboardLine = clipboardLineFrom(session);

    this.element = el('div', { className: `aside-panel ${HANDOFF_CARD_CLASS}` });
    this.element.dataset.sessionId = session.sessionId;
    this.element.dataset.provider = session.providerId;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Aside temporary handoff');

    /* ---------------------------------- header --------------------------------- */
    const header = el('div', { className: 'aside-panel-header' });
    const heading = el('div', { className: 'aside-panel-heading' });
    this.titleEl = el('h2');
    const label = el('p', { className: 'aside-handoff-label', text: 'Temporary handoff · Not saved in Aside', role: 'handoff-label' });
    heading.append(this.titleEl, label);

    const actions = el('div', { className: 'aside-panel-actions' });
    const jumpButton = button('Jump to passage', 'handoff-jump');
    const hideButton = button('Hide', 'handoff-hide');
    this.moreDetails = el('details', { className: 'aside-panel-more' });
    const moreSummary = el('summary', { text: 'More' });
    const moreMenu = el('div', { className: 'aside-panel-more-menu' });
    this.arrangeButton = button('Arrange side by side', 'handoff-arrange');
    this.arrangeButton.title = 'Place the chat window Aside opened beside this one. This window is not moved.';
    const clearClipboardButton = button('Clear clipboard now (replaces its contents)', 'handoff-clear-clipboard');
    const diagnosticsButton = button('Copy diagnostics (no content)', 'handoff-diagnostics');
    moreMenu.append(this.arrangeButton, clearClipboardButton, diagnosticsButton);
    this.moreDetails.append(moreSummary, moreMenu);
    actions.append(jumpButton, hideButton, this.moreDetails);
    header.append(heading, actions);

    /* ----------------------------------- body ---------------------------------- */
    this.bodyEl = el('div', { className: 'aside-panel-body' });

    const focus = el('div', { className: 'aside-focus' });
    const focusLabel = el('small', { text: 'Selected passage' });
    const focusText = el('p', { text: focusTextOf(session.selection) });
    focusText.dataset.asideRole = 'handoff-focus';
    focusText.title = 'Click to expand or collapse';
    focusText.addEventListener('click', () => {
      focusText.dataset.expanded = focusText.dataset.expanded === 'true' ? 'false' : 'true';
    });
    focus.append(focusLabel, focusText);

    const form = el('div', { className: 'aside-launcher aside-handoff-form' });
    const questionLabel = el('label', { className: 'aside-handoff-field', text: 'Your question' });
    this.questionInput = el('textarea', { role: 'handoff-question' });
    this.questionInput.rows = 3;
    this.questionInput.placeholder = 'Ask a focused question about this passage';
    this.questionInput.value = this.draft.question;
    questionLabel.append(this.questionInput);

    const context = el('div', { className: 'aside-handoff-context' });
    this.contextSummary = el('p', { className: 'aside-handoff-summary', role: 'handoff-context-summary' });
    this.missingEl = el('p', { className: 'aside-handoff-missing', role: 'handoff-missing' });
    this.budgetEl = el('p', { className: 'aside-handoff-budget', role: 'handoff-budget' });
    const details = el('details', { className: 'aside-context' });
    const detailsSummary = el('summary', { text: 'Edit context and see the full prompt' });
    this.blockList = el('div', { className: 'aside-context-blocks' });
    const backgroundLabel = el('label', { className: 'aside-context-background', text: 'Background to add (optional)' });
    this.backgroundInput = el('textarea', { role: 'handoff-background' });
    this.backgroundInput.rows = 2;
    this.backgroundInput.placeholder = 'Definitions or assumptions the passage relies on but does not state';
    this.backgroundInput.value = this.draft.background;
    backgroundLabel.append(this.backgroundInput);
    const previewLabel = el('p', { className: 'aside-context-preview-label', text: 'Exactly what will be copied:' });
    this.promptPreview = el('pre', { className: 'aside-context-preview', role: 'handoff-prompt' });
    details.append(detailsSummary, this.blockList, backgroundLabel, previewLabel, this.promptPreview);
    context.append(this.contextSummary, this.missingEl, this.budgetEl, details);

    const primaryRow = el('div', { className: 'aside-launcher-actions aside-handoff-primary' });
    this.primaryButton = button('Copy & open temporary chat', 'handoff-copy-open', 'aside-panel-primary');
    primaryRow.append(this.primaryButton);

    const secondary = el('div', { className: 'aside-handoff-secondary' });
    this.copyButton = button('Copy prompt', 'handoff-copy');
    this.openButton = button(`Open ${this.providerLabel}`, 'handoff-open');
    this.plainButton = button('Open a plain new chat instead', 'handoff-open-plain');
    this.plainButton.title = `Opens ${route.baseUrl} — select ${route.modeLabel} there yourself.`;
    secondary.append(this.copyButton, this.openButton, this.plainButton);

    this.clipboardStatus = el('p', { className: 'aside-handoff-status', role: 'handoff-clipboard-status' });
    this.clipboardStatus.setAttribute('role', 'status');
    this.targetStatus = el('p', { className: 'aside-handoff-status', role: 'handoff-target-status' });
    this.targetStatus.setAttribute('role', 'status');

    this.manualCopy = el('textarea', { className: 'aside-handoff-manual', role: 'handoff-manual-copy' });
    this.manualCopy.readOnly = true;
    this.manualCopy.hidden = true;
    this.manualCopy.rows = 6;

    this.guide = el('div', { className: 'aside-handoff-guide' });
    const instruction = el('p', { className: 'aside-handoff-instruction', text: NATIVE_HANDOFF_INSTRUCTION, role: 'handoff-instruction' });
    const steps = el('ol', { className: 'aside-handoff-steps' });
    route.steps.forEach((step) => steps.append(el('li', { text: step })));
    const notes = el('details', { className: 'aside-privacy-note' });
    notes.append(el('summary', { text: `What ${route.modeLabel} does and does not do` }));
    const noteList = el('ul');
    [
      ...route.notes,
      'Aside keeps this question only for this browser session and clears it when you End it, when its chat tab closes, or when the browser or extension restarts. The clipboard keeps what you copied until you copy something else.'
    ].forEach((note) => noteList.append(el('li', { text: note })));
    notes.append(noteList);
    this.guide.append(instruction, steps, notes);

    form.append(questionLabel, context, primaryRow, secondary, this.clipboardStatus, this.targetStatus, this.manualCopy, this.guide);

    /* --------------------------------- footer ---------------------------------- */
    const footer = el('div', { className: 'aside-handoff-footer' });
    const saveNoteButton = button('Save local note…', 'handoff-save-note-open');
    const endButton = button('End & discard', 'handoff-end');
    footer.append(saveNoteButton, endButton);

    this.endConfirm = el('div', { className: 'aside-recovery-confirm aside-handoff-end-confirm' });
    this.endConfirm.hidden = true;
    this.endConfirmText = el('p');
    const endConfirmActions = el('div', { className: 'aside-recovery-actions' });
    const endConfirmButton = button('End & discard', 'handoff-end-confirm', 'aside-panel-primary');
    const endKeepButton = button('Keep', 'handoff-end-keep');
    endConfirmActions.append(endConfirmButton, endKeepButton);
    this.endConfirm.append(this.endConfirmText, endConfirmActions);

    this.noteForm = el('div', { className: 'aside-recovery-confirm aside-handoff-note' });
    this.noteForm.hidden = true;
    const noteIntro = el('p', {
      className: 'aside-handoff-note-intro',
      text: 'Saving creates a permanent local record in Aside’s library, in this browser only. It does not save, convert or change the temporary chat.'
    });
    this.notePreview = el('div', { className: 'aside-handoff-note-preview', role: 'handoff-note-preview' });
    const titleLabel = el('label', { className: 'aside-handoff-field', text: 'Title' });
    this.noteTitle = el('input');
    this.noteTitle.type = 'text';
    this.noteTitle.dataset.asideRole = 'handoff-note-title';
    titleLabel.append(this.noteTitle);
    const noteLabel = el('label', { className: 'aside-handoff-field', text: 'Your note' });
    this.noteText = el('textarea', { role: 'handoff-note-text' });
    this.noteText.rows = 3;
    noteLabel.append(this.noteText);
    const excerptLabel = el('label', {
      className: 'aside-handoff-field',
      text: 'Answer excerpt (optional — paste it yourself; Aside does not read the chat)'
    });
    this.noteExcerpt = el('textarea', { role: 'handoff-note-excerpt' });
    this.noteExcerpt.rows = 3;
    excerptLabel.append(this.noteExcerpt);
    const noteActions = el('div', { className: 'aside-recovery-actions' });
    const noteSaveButton = button('Save to library', 'handoff-note-save', 'aside-panel-primary');
    const noteCancelButton = button('Cancel', 'handoff-note-cancel');
    noteActions.append(noteSaveButton, noteCancelButton);
    this.noteStatus = el('p', { className: 'aside-handoff-status', role: 'handoff-note-status' });
    this.noteForm.append(noteIntro, this.notePreview, titleLabel, noteLabel, excerptLabel, noteActions, this.noteStatus);

    this.bodyEl.append(focus, form, footer, this.endConfirm, this.noteForm);
    this.element.append(header, this.bodyEl);

    /* --------------------------------- events ---------------------------------- */
    const on = <T extends Event>(target: EventTarget, type: string, handler: (event: T) => void) => {
      target.addEventListener(type, handler as EventListener);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
    };

    on(this.questionInput, 'input', () => this.editDraft({ question: this.questionInput.value }));
    on(this.backgroundInput, 'input', () => this.editDraft({ background: this.backgroundInput.value }));
    on(this.questionInput, 'blur', () => void this.flushDraft());
    on(this.backgroundInput, 'blur', () => void this.flushDraft());
    on(this.primaryButton, 'click', () => void this.primaryAction());
    on(this.copyButton, 'click', () => void this.copyOnly());
    on(this.openButton, 'click', () => void this.openTarget({ focusOnly: false }));
    on(this.plainButton, 'click', () => void this.openTarget({ focusOnly: false, route: 'base' }));
    on(jumpButton, 'click', () => {
      this.anchorLine = anchorMessage(this.deps.jumpToPassage(this.session));
      this.render();
    });
    on(hideButton, 'click', () => this.hide());
    on(this.arrangeButton, 'click', () => {
      this.moreDetails.open = false;
      void this.arrange();
    });
    on(clearClipboardButton, 'click', () => {
      this.moreDetails.open = false;
      void this.clearClipboard();
    });
    on(diagnosticsButton, 'click', () => {
      this.moreDetails.open = false;
      void this.copyDiagnostics();
    });
    on(saveNoteButton, 'click', () => this.openNoteForm());
    on(noteCancelButton, 'click', () => {
      this.noteForm.hidden = true;
      this.noteStatus.textContent = '';
    });
    on(noteSaveButton, 'click', () => void this.saveNote());
    on(endButton, 'click', () => this.openEndConfirm());
    on(endKeepButton, 'click', () => {
      this.endConfirm.hidden = true;
    });
    on(endConfirmButton, 'click', () => void this.end());
    on<KeyboardEvent>(this.element, 'keydown', (event) => {
      // Only Aside's own card: native menus and focus are never intercepted.
      if (event.key !== 'Escape' || event.isComposing) {
        return;
      }
      if (this.moreDetails.open) {
        this.moreDetails.open = false;
        return;
      }
      this.hide();
    });

    this.renderContext();
    this.render();
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get hidden(): boolean {
    return this.element.hidden;
  }

  /** Short label for the rail. */
  railLabel(): string {
    const question = compactWhitespace(this.draft.question);
    return clipText(question || compactWhitespace(focusTextOf(this.session.selection)), 28);
  }

  mount(): void {
    this.deps.mount(this.element);
  }

  show(): void {
    if (this.ended) {
      return;
    }
    this.element.hidden = false;
    if (this.session.hidden) {
      this.session = { ...this.session, hidden: false };
      void this.pushUpdate({ hidden: false });
    }
    this.deps.onVisibilityChange(this);
  }

  hide(): void {
    this.element.hidden = true;
    if (!this.ended && !this.session.hidden) {
      this.session = { ...this.session, hidden: true };
      void this.pushUpdate({ hidden: true });
    }
    this.deps.onVisibilityChange(this);
  }

  /** Visually hide without recording a user preference (another card took the slot). */
  yieldSlot(): void {
    this.element.hidden = true;
    this.deps.onVisibilityChange(this);
  }

  focusQuestion(): void {
    window.setTimeout(() => {
      if (!this.element.hidden) {
        this.questionInput.focus();
        const end = this.questionInput.value.length;
        this.questionInput.setSelectionRange(end, end);
      }
    }, 0);
  }

  /* -------------------------------- draft & prompt ------------------------------- */

  private editDraft(patch: Partial<HandoffDraft>): void {
    if (this.ended) {
      return;
    }
    this.draft = { ...this.draft, ...patch };
    this.prompt = preparePrompt(this.session.selection, this.draft, this.prompt);
    this.renderContext();
    this.render();
    window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => void this.flushDraft(), DRAFT_SYNC_DELAY_MS);
  }

  private setExcluded(blockId: string, excluded: boolean): void {
    const set = new Set(this.draft.excludedBlockIds);
    if (excluded) {
      set.add(blockId);
    } else {
      set.delete(blockId);
    }
    this.editDraft({ excludedBlockIds: [...set] });
  }

  /** Send the draft to the worker for recovery; one request at a time. */
  flushDraft(): Promise<void> {
    window.clearTimeout(this.syncTimer);
    this.syncing = this.syncing.then(async () => {
      const same =
        this.session.draft.question === this.draft.question &&
        this.session.draft.background === this.draft.background &&
        this.session.draft.excludedBlockIds.join('\n') === this.draft.excludedBlockIds.join('\n');
      if (same || this.ended) {
        return;
      }
      await this.pushUpdate({ draft: this.draft });
    });
    return this.syncing;
  }

  private async pushUpdate(patch: { draft?: HandoffDraft; hidden?: boolean }): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.deps.send({
        type: 'HANDOFF_UPDATE',
        buildId: this.deps.buildId,
        sessionId: this.session.sessionId,
        baseEpoch: this.session.epoch,
        ...patch
      });
      if (!response) {
        return;
      }
      this.noteMemoryOnly(response);
      if (response.ok && response.session) {
        this.adoptSession(response.session, { keepLocalDraft: true });
        return;
      }
      if (response.code === 'stale-epoch' && response.session) {
        // This card is the only writer of the draft; adopt the epoch and retry.
        this.session = { ...response.session, draft: this.session.draft };
        continue;
      }
      if (response.code === 'missing-session') {
        this.markEnded('This temporary question is no longer in Aside (the extension or browser may have restarted).');
      } else if (response.code === 'stale-client') {
        this.markStale();
      }
      return;
    }
  }

  private currentPrompt(): PreparedPrompt {
    this.prompt = preparePrompt(this.session.selection, this.draft, this.prompt);
    return this.prompt;
  }

  /* ------------------------------------ actions ----------------------------------- */

  private async primaryAction(): Promise<void> {
    if (this.session.target.state === 'open') {
      await this.openTarget({ focusOnly: true });
      return;
    }
    await this.copyAndOpen();
  }

  /** Copy first (the page still has focus and the click's activation), then open. */
  async copyAndOpen(): Promise<void> {
    if (this.busy || this.ended) {
      return;
    }
    this.busy = true;
    this.render();
    // Bound to this session and this frozen revision before anything is awaited:
    // switching tabs meanwhile cannot change what is handed off.
    const sessionId = this.session.sessionId;
    const prompt = this.currentPrompt();
    try {
      await this.copy(sessionId, prompt);
      await this.openTarget({ focusOnly: false, sessionId, alreadyBusy: true });
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async copyOnly(): Promise<void> {
    if (this.busy || this.ended) {
      return;
    }
    this.busy = true;
    this.render();
    try {
      await this.copy(this.session.sessionId, this.currentPrompt());
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async copy(sessionId: string, prompt: PreparedPrompt): Promise<void> {
    const result = await this.deps.writeClipboard(prompt.text);
    if (result.ok) {
      this.lastCopied = prompt;
      this.clipboardLine = { kind: 'copied', revision: prompt.revision, here: true };
      this.manualCopy.hidden = true;
    } else {
      this.clipboardLine = { kind: 'failed', code: result.code };
      // Last resort: the exact text, selected, for a manual copy. Never a URL.
      this.manualCopy.value = prompt.text;
      this.manualCopy.hidden = false;
      window.setTimeout(() => {
        this.manualCopy.focus();
        this.manualCopy.select();
      }, 0);
    }
    this.render();
    const response = await this.deps.send({
      type: 'HANDOFF_COPIED',
      buildId: this.deps.buildId,
      sessionId,
      ok: result.ok,
      code: result.code,
      prompt: result.ok ? prompt : null
    });
    if (response) {
      this.noteMemoryOnly(response);
    }
    if (response?.session && response.session.sessionId === this.session.sessionId) {
      this.adoptSession(response.session, { keepLocalDraft: true });
    }
  }

  /** Tell the worker Aside put something else on the clipboard. */
  private async reportReplaced(): Promise<void> {
    this.clipboardLine = { kind: 'replaced' };
    const response = await this.deps.send({
      type: 'HANDOFF_COPIED',
      buildId: this.deps.buildId,
      sessionId: this.session.sessionId,
      ok: true,
      code: 'ok',
      prompt: null,
      replaced: true
    });
    if (response?.session && response.session.sessionId === this.session.sessionId) {
      this.adoptSession(response.session, { keepLocalDraft: true });
    }
  }

  private noteMemoryOnly(response: HandoffResponse): void {
    if (typeof response.memoryOnly === 'boolean' && response.memoryOnly !== this.memoryOnly) {
      this.memoryOnly = response.memoryOnly;
    }
  }

  async openTarget(options: {
    focusOnly: boolean;
    route?: 'base' | 'convenience';
    sessionId?: string;
    alreadyBusy?: boolean;
  }): Promise<void> {
    if (this.ended || (this.busy && !options.alreadyBusy)) {
      return;
    }
    if (!options.alreadyBusy) {
      this.busy = true;
      this.render();
    }
    await this.flushDraft();
    try {
      const response = await this.deps.send({
        type: 'HANDOFF_OPEN',
        buildId: this.deps.buildId,
        sessionId: options.sessionId ?? this.session.sessionId,
        kind: this.session.target.kind,
        focusOnly: options.focusOnly,
        route: options.route
      });
      if (!response) {
        this.targetLine = `Could not reach Aside's extension worker, so ${this.providerLabel} was not opened. Reload this page and try again.`;
        return;
      }
      this.noteMemoryOnly(response);
      if (response.session) {
        this.adoptSession(response.session, { keepLocalDraft: true });
      }
      const where = this.session.target.kind === 'tab' ? 'a new tab' : 'a new window';
      switch (response.code) {
        case 'opened':
          this.targetLine = `${this.providerLabel} opened in ${where}.`;
          break;
        case 'focused-existing':
          this.targetLine = `Switched to the ${this.providerLabel} ${this.session.target.kind === 'tab' ? 'tab' : 'window'} for this question.`;
          break;
        case 'opening':
          this.targetLine = `${this.providerLabel} is still opening.`;
          break;
        case 'target-closed':
          this.markEnded(
            `The ${this.providerLabel} tab for this question was closed, so its temporary conversation cannot be reopened and the question was cleared from Aside. Select the passage again to ask a new one.`
          );
          break;
        case 'no-target':
          this.targetLine = `No ${this.providerLabel} page is open for this question yet.`;
          break;
        case 'focus-failed':
          this.targetLine = `The ${this.providerLabel} ${this.session.target.kind === 'tab' ? 'tab' : 'window'} for this question is still open, but the browser did not switch to it. Switch to it yourself.`;
          break;
        case 'stale-client':
          this.markStale();
          break;
        case 'missing-session':
          this.markEnded('This temporary question is no longer in Aside.');
          break;
        default:
          this.targetLine = `${this.providerLabel} could not be opened. Your prompt is still here; try Open ${this.providerLabel} again.`;
      }
    } finally {
      if (!options.alreadyBusy) {
        this.busy = false;
      }
      this.render();
    }
  }

  private async arrange(): Promise<void> {
    const response = await this.deps.send({
      type: 'HANDOFF_ARRANGE',
      buildId: this.deps.buildId,
      sessionId: this.session.sessionId
    });
    this.targetLine = response?.ok
      ? `The ${this.providerLabel} window was placed beside this one.`
      : 'Side by side is not available for this window layout. Nothing was moved.';
    this.render();
  }

  private async clearClipboard(): Promise<void> {
    const result = await this.deps.writeClipboard('');
    if (result.ok) {
      await this.reportReplaced();
    }
    this.deps.notify(
      result.ok
        ? 'Clipboard replaced with empty text in this browser. Clipboard history or synced clipboards may still hold what you copied.'
        : 'The clipboard could not be cleared from here.'
    );
    this.render();
  }

  private async copyDiagnostics(): Promise<void> {
    const response = await this.deps.send({ type: 'HANDOFF_ROLE', buildId: this.deps.buildId });
    const lines = [
      'Aside handoff diagnostics (no content, no URLs)',
      `pageBuild: ${this.deps.buildId}`,
      `workerBuild: ${response?.buildId ?? '(unreachable)'}`,
      `provider: ${this.session.providerId}`,
      `entry: ${this.session.entry}`,
      `routeCategory: ${this.session.target.route ?? '(not opened)'}`,
      `clipboard: ${this.clipboardLine.kind}${this.clipboardLine.kind === 'failed' ? ` (${this.clipboardLine.code})` : ''}`,
      `target: ${this.session.target.state} · ${this.session.target.kind} · ${this.session.target.ownership}`,
      `storage: ${this.memoryOnly ? 'memory-only' : 'session'}`,
      `promptRevision: ${this.prompt.revision} · compiler ${this.prompt.compilerVersion} · template ${this.prompt.templateVersion}`,
      `lastCode: ${response?.code ?? '(none)'}`
    ];
    const result = await this.deps.writeClipboard(lines.join('\n'));
    // Copying diagnostics replaces the prompt on the clipboard: say so.
    if (result.ok) {
      await this.reportReplaced();
    }
    this.deps.notify(result.ok ? 'Diagnostics copied. The prompt is no longer on the clipboard.' : 'Diagnostics could not be copied.');
    this.render();
  }

  private openNoteForm(): void {
    if (this.ended) {
      return;
    }
    this.endConfirm.hidden = true;
    this.noteForm.hidden = false;
    this.noteStatus.textContent = '';
    const focus = focusTextOf(this.session.selection);
    if (!this.noteTitle.value) {
      this.noteTitle.value = autoTitle(this.draft.question, focus);
    }
    this.notePreview.replaceChildren();
    const rows: Array<[string, string]> = [
      ['Source', this.session.source.title || `${this.providerLabel} conversation`],
      ['Passage', clipText(focus, 600)],
      ['Question', this.draft.question.trim() || '(none)']
    ];
    rows.forEach(([name, value]) => {
      const row = el('p');
      const strong = el('strong', { text: `${name}: ` });
      row.append(strong, document.createTextNode(value));
      this.notePreview.append(row);
    });
    this.notePreview.append(
      el('p', {
        className: 'aside-handoff-note-small',
        text: 'Plus your title and note below, and the few words around the passage that let Aside find it again. Nothing else from the page or the chat is saved.'
      })
    );
    this.noteText.focus();
  }

  private async saveNote(): Promise<void> {
    if (this.busy || this.ended) {
      return;
    }
    const note = this.noteText.value;
    const excerpt = this.noteExcerpt.value;
    if (!note.trim() && !excerpt.trim()) {
      this.noteStatus.textContent = 'Write a note or paste an excerpt first.';
      return;
    }
    this.busy = true;
    this.noteStatus.textContent = 'Saving…';
    await this.flushDraft();
    try {
      const response = await this.deps.send({
        type: 'HANDOFF_SAVE_NOTE',
        buildId: this.deps.buildId,
        sessionId: this.session.sessionId,
        note,
        excerpt,
        title: this.noteTitle.value
      });
      if (response?.ok && response.questionId) {
        this.noteForm.hidden = true;
        this.noteText.value = '';
        this.noteExcerpt.value = '';
        this.deps.notify('Saved to Aside’s library as a permanent local record. This temporary question itself is still not saved.');
      } else {
        this.noteStatus.textContent =
          response?.code === 'stale-client'
            ? 'Not saved: Aside was updated. Reload this page first.'
            : 'Not saved. Nothing was written; your note is still here.';
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private openEndConfirm(): void {
    if (this.ended) {
      return;
    }
    this.noteForm.hidden = true;
    const target = this.session.target;
    let text = 'This clears the question and its prepared prompt from Aside.';
    if (target.state === 'open' && target.ownership === 'owned') {
      text += ` It also closes the ${this.providerLabel} tab Aside opened; that temporary conversation cannot be reopened after it is closed.`;
    } else if (target.state === 'open') {
      text += ` The ${this.providerLabel} tab stays open, because Aside can no longer confirm it is the one it opened. Close it yourself when you are done.`;
    }
    text += ' What you copied stays on the clipboard until you copy something else.';
    this.endConfirmText.textContent = text;
    this.endConfirm.hidden = false;
  }

  async end(): Promise<void> {
    if (this.ended) {
      return;
    }
    const closeTarget = this.session.target.state === 'open' && this.session.target.ownership === 'owned';
    window.clearTimeout(this.syncTimer);
    const response = await this.deps.send({
      type: 'HANDOFF_END',
      buildId: this.deps.buildId,
      sessionId: this.session.sessionId,
      closeTarget
    });
    // Local material goes whatever the worker answered.
    this.ended = true;
    let message = 'Cleared from Aside.';
    if (!response) {
      message = 'Cleared from this page. Aside’s worker could not be reached; its copy is cleared when the browser session ends.';
    } else if (closeTarget && !response.targetClosed) {
      message = `Local material cleared; the ${this.providerLabel} tab is still open. Close it yourself if you are done.`;
    } else if (!closeTarget && this.session.target.state === 'open') {
      message = `Cleared from Aside. The ${this.providerLabel} tab was left open.`;
    }
    this.deps.notify(message);
    this.dispose();
  }

  /* -------------------------------- worker updates -------------------------------- */

  adoptSession(next: ScratchHandoff, options: { keepLocalDraft?: boolean; fromEvent?: boolean } = {}): void {
    if (next.sessionId !== this.session.sessionId || this.ended) {
      return;
    }
    if (options.fromEvent && next.clipboard !== this.session.clipboard) {
      // Another view (the popup) copied or replaced: recorded, not claimed as current.
      this.clipboardLine = clipboardLineFrom(next);
    }
    const localDraft = this.draft;
    this.session = next;
    if (!options.keepLocalDraft) {
      this.draft = { ...next.draft };
      this.questionInput.value = this.draft.question;
      this.backgroundInput.value = this.draft.background;
    } else {
      this.draft = localDraft;
    }
    if (next.copied && (!this.lastCopied || next.copied.revision >= this.lastCopied.revision)) {
      this.lastCopied = next.copied;
    }
    this.render();
  }

  /**
   * The worker says the session is gone (its chat tab closed, or the worker
   * lost it). The page drops its copy too: nothing of the question is kept
   * here to be revived. A new question starts from a new selection.
   */
  markEnded(message: string): void {
    if (this.ended) {
      return;
    }
    this.deps.notify(message);
    this.dispose();
  }

  markStale(): void {
    this.staleClient = true;
    this.targetLine = 'Aside was updated. Reload this page to keep using it; this question is not affected until you do.';
    this.render();
  }

  setMemoryOnly(memoryOnly: boolean): void {
    this.memoryOnly = memoryOnly;
    this.render();
  }

  /**
   * Remove the card from the page without ending its session: the content
   * script is being replaced (an update) and the worker keeps the session.
   */
  detach(): void {
    window.clearTimeout(this.syncTimer);
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.element.remove();
  }

  dispose(): void {
    this.ended = true;
    window.clearTimeout(this.syncTimer);
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    // Rendered prompt text leaves the page with the card.
    this.promptPreview.textContent = '';
    this.manualCopy.value = '';
    this.element.remove();
    this.deps.onDisposed(this);
  }

  /* ------------------------------------ render ------------------------------------ */

  private renderContext(): void {
    const plan = planForHandoff(this.session.selection, this.draft);
    this.contextSummary.textContent = this.prompt.included.length
      ? `Context: ${this.describeIncluded()}`
      : 'Context: the selected passage.';
    this.missingEl.textContent = this.prompt.missing.length ? `Missing: ${this.prompt.missing.join('; ')}.` : '';
    this.missingEl.hidden = !this.prompt.missing.length;
    this.budgetEl.textContent = this.prompt.overBudget
      ? `About ${this.prompt.charCount.toLocaleString()} characters — more than Aside's ${this.prompt.maxChars.toLocaleString()}-character guide, and nothing essential was cut. The native chat may still accept it; consider selecting less.`
      : '';
    this.budgetEl.hidden = !this.prompt.overBudget;

    this.blockList.replaceChildren();
    plan.blocks
      .filter((block) => block.role !== 'background')
      .forEach((block) => {
        const row = el('label', { className: 'aside-context-block' });
        row.dataset.planRole = block.role;
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = block.included;
        toggle.dataset.blockId = block.id;
        // The focus is what the question is about; it is never removable.
        toggle.disabled = block.role === 'focus';
        toggle.addEventListener('change', () => this.setExcluded(block.id, !toggle.checked));
        const text = el('span', {
          text: `${block.reason}: ${clipText(compactWhitespace(block.text), 90)}${
            !block.included && block.omitReason === 'budget' ? ' (left out to fit the size guide)' : ''
          }`
        });
        row.append(toggle, text);
        this.blockList.append(row);
      });
    this.promptPreview.textContent = this.prompt.text;
  }

  private describeIncluded(): string {
    const labels: string[] = [];
    const roles = new Set(this.prompt.included.map((block) => block.role));
    labels.push('the selected passage');
    if (roles.has('enclosing')) {
      labels.push('its paragraph or block');
    }
    if (roles.has('enclosing-equation')) {
      labels.push('the whole equation (as context)');
    }
    if (roles.has('preceding-question')) {
      labels.push('the question before it');
    }
    const deps = this.prompt.included.filter((block) => block.role === 'dependency').length;
    if (deps) {
      labels.push(`${deps} referenced definition${deps > 1 ? 's' : ''}`);
    }
    if (roles.has('background')) {
      labels.push('your background');
    }
    const left = this.prompt.omitted.length ? `; ${this.prompt.omitted.length} left out` : '';
    return `${labels.join(', ')}${left}. About ${this.prompt.charCount.toLocaleString()} characters.`;
  }

  render(): void {
    const target = this.session.target;
    const open = target.state === 'open';
    const route = routeFor(this.session.providerId);
    const question = compactWhitespace(this.draft.question);
    this.titleEl.textContent = question ? clipText(question, 90) : 'Ask about this passage';

    this.primaryButton.textContent = open
      ? `Continue in ${this.providerLabel}`
      : this.session.target.kind === 'tab'
        ? 'Copy & open temporary chat in a new tab'
        : 'Copy & open temporary chat';
    this.primaryButton.disabled = this.busy || this.ended || this.staleClient;
    this.copyButton.disabled = this.busy || this.ended;
    this.openButton.textContent = open ? `Focus ${this.providerLabel}` : `Open ${this.providerLabel} only`;
    this.openButton.disabled = this.busy || this.ended || this.staleClient;
    this.plainButton.hidden = open || !route.convenienceUrl;
    this.plainButton.disabled = this.busy || this.ended || this.staleClient;
    this.arrangeButton.hidden = !(open && target.windowCreated && target.ownership === 'owned');

    const copiedCurrent =
      this.clipboardLine.kind === 'copied' && this.lastCopied !== null && this.lastCopied.text === this.prompt.text;
    if (this.clipboardLine.kind === 'copied' && copiedCurrent && this.clipboardLine.here) {
      this.clipboardStatus.textContent = 'Copied: this exact prompt is on the clipboard. Nothing has been sent.';
      this.clipboardStatus.dataset.state = 'copied';
    } else if (this.clipboardLine.kind === 'copied' && copiedCurrent) {
      this.clipboardStatus.textContent =
        'Copied earlier. If you have copied anything since, copy again before pasting. Nothing has been sent.';
      this.clipboardStatus.dataset.state = 'copied-earlier';
    } else if (this.clipboardLine.kind === 'replaced') {
      this.clipboardStatus.textContent = 'The prompt is no longer on the clipboard. Copy again before pasting.';
      this.clipboardStatus.dataset.state = 'stale';
    } else if (this.clipboardLine.kind === 'copied') {
      this.clipboardStatus.textContent = 'Edited since you copied it: copy again before pasting.';
      this.clipboardStatus.dataset.state = 'stale';
    } else if (this.clipboardLine.kind === 'failed') {
      this.clipboardStatus.textContent =
        'Not copied: the browser did not allow clipboard access. Use Copy prompt, or copy the selected text below yourself.';
      this.clipboardStatus.dataset.state = 'failed';
    } else {
      this.clipboardStatus.textContent = '';
      this.clipboardStatus.dataset.state = 'idle';
    }
    this.clipboardStatus.hidden = !this.clipboardStatus.textContent;

    let targetText = this.targetLine;
    if (!targetText && open) {
      targetText = `Continue in ${this.providerLabel}: the answer and follow-ups stay there.`;
    }
    if (open && target.ownership === 'uncertain') {
      targetText += ` That tab has moved on, so Aside will not close it for you.`;
    }
    if (this.anchorLine) {
      targetText = `${targetText} ${this.anchorLine}`.trim();
    }
    if (this.memoryOnly) {
      targetText = `${targetText} Session storage is unavailable, so this question lives only while Aside's worker keeps running.`.trim();
    }
    this.targetStatus.textContent = targetText;
    this.targetStatus.hidden = !targetText;

    this.element.dataset.target = target.state;
    this.element.dataset.clipboard = this.clipboardLine.kind;
    this.element.dataset.busy = String(this.busy);
  }
}

/**
 * Clipboard write from the source page, inside the click that asked for it.
 * The supported API first; a selected hidden textarea with execCommand as the
 * fallback. No clipboard read is ever requested, and nothing goes in a URL.
 */
export async function writeClipboardText(text: string, host: HTMLElement): Promise<{ ok: boolean; code: HandoffCode }> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, code: 'ok' };
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.left = '-10000px';
  area.style.top = '0';
  area.style.opacity = '0';
  host.append(area);
  try {
    area.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    return ok ? { ok: true, code: 'ok' } : { ok: false, code: 'clipboard-denied' };
  } catch {
    return { ok: false, code: 'clipboard-unavailable' };
  } finally {
    area.value = '';
    area.remove();
    previous?.focus?.();
  }
}

export const HANDOFF_CARD_CSS = `
    .${HANDOFF_CARD_CLASS} .aside-handoff-label {
      margin: 4px 0 0;
      font: 600 12px/1.3 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font: 600 12px/1.3 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-field input,
    .${HANDOFF_CARD_CLASS} .aside-handoff-field textarea,
    .${HANDOFF_CARD_CLASS} .aside-handoff-manual {
      font: 500 13px/1.45 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-text, #111827);
      background: var(--sb-panel-bg, #ffffff);
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.12));
      border-radius: 10px;
      padding: 8px 10px;
      resize: vertical;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-context p {
      margin: 0 0 4px;
      font: 500 12px/1.45 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-missing,
    .${HANDOFF_CARD_CLASS} .aside-handoff-budget {
      color: var(--sb-text, #111827) !important;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-secondary,
    .${HANDOFF_CARD_CLASS} .aside-handoff-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-secondary button,
    .${HANDOFF_CARD_CLASS} .aside-handoff-footer button {
      padding: 6px 10px;
      font-size: 12px;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-footer {
      padding: 10px 18px 14px;
      justify-content: space-between;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-status {
      margin: 0;
      font: 500 12px/1.45 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-text, #111827);
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-status[data-state="failed"],
    .${HANDOFF_CARD_CLASS} .aside-handoff-status[data-state="stale"] {
      color: var(--sb-danger, #991b1b);
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-guide {
      display: grid;
      gap: 6px;
      font: 500 12px/1.45 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-instruction {
      margin: 0;
      color: var(--sb-text, #111827);
      font-weight: 600;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-steps {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 3px;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-end-confirm,
    .${HANDOFF_CARD_CLASS} .aside-handoff-note {
      margin: 0 18px 14px;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-note-preview p {
      margin: 0 0 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .${HANDOFF_CARD_CLASS} .aside-handoff-note-small {
      font-size: 11px;
      color: var(--sb-muted, #6b7280);
    }
    .${HANDOFF_CARD_CLASS} button:focus-visible,
    .${HANDOFF_CARD_CLASS} summary:focus-visible {
      outline: 2px solid rgba(37, 99, 235, 0.55);
      outline-offset: 2px;
    }
    .${HANDOFF_CARD_CLASS} button:disabled {
      opacity: 0.55;
      cursor: default;
    }
`;
