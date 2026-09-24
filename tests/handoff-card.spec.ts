import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HandoffCard, writeClipboardText, type HandoffCardDeps } from '../src/content/handoff-card';
import { preparePrompt } from '../src/handoff/prompt';
import type { HandoffRequest, HandoffResponse, ScratchHandoff } from '../src/handoff/types';

const MARKER = 'card-marker-51c9';

function session(overrides: Partial<ScratchHandoff> = {}): ScratchHandoff {
  return {
    sessionId: 'sess-1',
    epoch: 1,
    providerId: 'chatgpt',
    policy: 'temporary-intended',
    entry: 'why',
    source: { tabId: 1, windowId: 1, scopeKey: 'chatgpt:c:1', url: 'https://chatgpt.com/c/1', open: true, title: 'Source chat' },
    selection: {
      rootConversationId: 'chatgpt:c:1',
      rootChatUrl: 'https://chatgpt.com/c/1',
      selectedText: `S2≠S2 ${MARKER}`,
      structuredSelectedText: `$S_2 \\ne S^2$ ${MARKER}`,
      selectedBlocks: [
        { messageId: 'assistant:1:x', role: 'assistant', turnIndex: 1, text: `Then S2≠S2 ${MARKER} holds.`, structuredText: `Then $S_2 \\ne S^2$ ${MARKER} holds.`, excerpt: 'Then' }
      ],
      branchBaseMessageId: 'assistant:1:x',
      rangeQuotes: { exact: `S2≠S2 ${MARKER}`, prefix: 'Then ', suffix: ' holds.' },
      fallbackScrollY: 0
    },
    draft: { question: 'Why does this step hold? Explain the reasoning and state any necessary assumptions.', excludedBlockIds: [], background: '' },
    copied: null,
    clipboard: 'idle',
    target: {
      state: 'none',
      kind: 'window',
      route: null,
      tabId: null,
      windowId: null,
      windowCreated: false,
      ownership: 'owned',
      conversationPaths: [],
      openingSince: null
    },
    hidden: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

interface Harness {
  card: HandoffCard;
  sent: HandoffRequest[];
  clipboard: string[];
  notices: string[];
  deps: HandoffCardDeps;
  disposed: boolean;
}

function makeCard(
  options: {
    clipboardOk?: boolean;
    clipboardDelayMs?: number;
    respond?: (message: HandoffRequest) => HandoffResponse | null;
    initial?: Partial<ScratchHandoff>;
  } = {}
): Harness {
  let current = session(options.initial);
  const harness = { sent: [] as HandoffRequest[], clipboard: [] as string[], notices: [] as string[], disposed: false } as Harness;
  const deps: HandoffCardDeps = {
    buildId: 'b',
    mount: (element) => document.body.append(element),
    notify: (message) => harness.notices.push(message),
    send: async (message) => {
      harness.sent.push(message);
      if (options.respond) {
        return options.respond(message);
      }
      if (message.type === 'HANDOFF_OPEN') {
        const opened = message.focusOnly || current.target.state === 'open';
        current = {
          ...current,
          epoch: current.epoch + 1,
          target: { ...current.target, state: 'open', tabId: 9, windowId: 9, windowCreated: true, route: 'convenience' }
        };
        return { ok: true, code: opened ? 'focused-existing' : 'opened', buildId: 'b', session: current };
      }
      if (message.type === 'HANDOFF_COPIED') {
        current = { ...current, epoch: current.epoch + 1, clipboard: message.ok ? 'copied' : 'failed', copied: message.prompt };
        return { ok: true, code: 'ok', buildId: 'b', session: current };
      }
      if (message.type === 'HANDOFF_UPDATE') {
        current = { ...current, epoch: current.epoch + 1, draft: message.draft ?? current.draft, hidden: message.hidden ?? current.hidden };
        return { ok: true, code: 'ok', buildId: 'b', session: current };
      }
      if (message.type === 'HANDOFF_END') {
        return { ok: true, code: 'ok', buildId: 'b', session: null, targetClosed: current.target.state === 'open' };
      }
      if (message.type === 'HANDOFF_SAVE_NOTE') {
        return { ok: true, code: 'ok', buildId: 'b', session: current, questionId: 'q1' };
      }
      return { ok: true, code: 'ok', buildId: 'b' };
    },
    writeClipboard: async (text) => {
      await new Promise((resolve) => setTimeout(resolve, options.clipboardDelayMs ?? 0));
      if (options.clipboardOk === false) {
        return { ok: false, code: 'clipboard-denied' };
      }
      harness.clipboard.push(text);
      return { ok: true, code: 'ok' };
    },
    jumpToPassage: () => 'exact',
    openLibrary: () => undefined,
    onVisibilityChange: () => undefined,
    onDisposed: () => {
      harness.disposed = true;
    }
  };
  harness.deps = deps;
  harness.card = new HandoffCard(current, deps);
  harness.card.mount();
  return harness;
}

function q<T extends Element>(harness: Harness, role: string): T {
  const element = harness.card.element.querySelector(`[data-aside-role="${role}"]`);
  if (!element) {
    throw new Error(`missing ${role}`);
  }
  return element as T;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('handoff card: nothing happens without a click', () => {
  it('rendering the card writes no clipboard, opens nothing and saves nothing', async () => {
    const harness = makeCard();
    await flush();
    expect(harness.clipboard).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(q(harness, 'handoff-label').textContent).toBe('Temporary handoff · Not saved in Aside');
    expect(q(harness, 'handoff-instruction').textContent).toMatch(/Confirm the temporary mode in the native page before pasting/);
  });

  it('shows the Why question ready to go, and the passage with its TeX source', () => {
    const harness = makeCard();
    expect(q<HTMLTextAreaElement>(harness, 'handoff-question').value).toMatch(/^Why does this step hold\?/);
    expect(q(harness, 'handoff-focus').textContent).toContain('$S_2 \\ne S^2$');
    expect(q<HTMLButtonElement>(harness, 'handoff-copy-open').disabled).toBe(false);
  });
});

describe('handoff card: the copied text is the previewed text', () => {
  it('Copy & open copies exactly the preview, then opens once', async () => {
    const harness = makeCard();
    const preview = q(harness, 'handoff-prompt').textContent;
    q<HTMLButtonElement>(harness, 'handoff-copy-open').click();
    await flush();
    await flush();
    expect(harness.clipboard).toEqual([preview]);
    expect(harness.clipboard[0]).toContain('$S_2 \\ne S^2$');
    const types = harness.sent.map((message) => message.type);
    expect(types).toEqual(['HANDOFF_COPIED', 'HANDOFF_OPEN']);
    const copied = harness.sent[0] as Extract<HandoffRequest, { type: 'HANDOFF_COPIED' }>;
    expect(copied.prompt?.text).toBe(preview);
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/Copied: this exact prompt/);
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/Nothing has been sent/);
    // After opening, the primary action only focuses the chat: no re-copy.
    expect(q(harness, 'handoff-copy-open').textContent).toBe('Continue in ChatGPT');
  });

  it('an edit after copying is flagged and makes a new revision', async () => {
    const harness = makeCard();
    q<HTMLButtonElement>(harness, 'handoff-copy').click();
    await flush();
    const question = q<HTMLTextAreaElement>(harness, 'handoff-question');
    question.value = 'Why exactly?';
    question.dispatchEvent(new Event('input'));
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/Edited since you copied it/);
    expect(q(harness, 'handoff-prompt').textContent).toContain('QUESTION\nWhy exactly?');
    q<HTMLButtonElement>(harness, 'handoff-copy').click();
    await flush();
    expect(harness.clipboard).toHaveLength(2);
    expect(harness.clipboard[1]).toContain('QUESTION\nWhy exactly?');
    const revisions = harness.sent
      .filter((message): message is Extract<HandoffRequest, { type: 'HANDOFF_COPIED' }> => message.type === 'HANDOFF_COPIED')
      .map((message) => message.prompt?.revision);
    expect(revisions[1]).toBeGreaterThan(revisions[0] as number);
  });

  it('removing context in the card removes it from the copied text', async () => {
    const harness = makeCard({
      initial: {
        selection: {
          ...session().selection,
          precedingQuestion: { messageId: 'user:0:q', role: 'user', turnIndex: 0, text: `Earlier question ${MARKER}`, excerpt: 'Earlier' }
        }
      }
    });
    expect(q(harness, 'handoff-prompt').textContent).toContain('Earlier question');
    const toggle = harness.card.element.querySelector<HTMLInputElement>('input[data-block-id$="#preceding"]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(q(harness, 'handoff-prompt').textContent).not.toContain('Earlier question');
    q<HTMLButtonElement>(harness, 'handoff-copy').click();
    await flush();
    expect(harness.clipboard[0]).not.toContain('Earlier question');
    // The focus has no enabled toggle.
    const focusToggle = harness.card.element.querySelector<HTMLInputElement>('input[data-block-id$="#focus"]') as HTMLInputElement;
    expect(focusToggle.disabled).toBe(true);
  });
});

describe('handoff card: failures are local and recoverable', () => {
  it('a clipboard refusal is reported, offers the exact text for a manual copy, and still opens the chat', async () => {
    const harness = makeCard({ clipboardOk: false });
    q<HTMLButtonElement>(harness, 'handoff-copy-open').click();
    await flush();
    await flush();
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/Not copied/);
    const manual = q<HTMLTextAreaElement>(harness, 'handoff-manual-copy');
    expect(manual.hidden).toBe(false);
    expect(manual.value).toBe(q(harness, 'handoff-prompt').textContent);
    const copied = harness.sent.find((message) => message.type === 'HANDOFF_COPIED') as Extract<HandoffRequest, { type: 'HANDOFF_COPIED' }>;
    expect(copied.ok).toBe(false);
    expect(copied.prompt).toBeNull();
    // Opening is independent of the copy.
    expect(harness.sent.map((message) => message.type)).toContain('HANDOFF_OPEN');
  });

  it('an open failure keeps the copied state and offers to try again', async () => {
    const harness = makeCard({
      respond: (message) =>
        message.type === 'HANDOFF_OPEN'
          ? { ok: false, code: 'open-failed', buildId: 'b', session: session({ clipboard: 'copied' }) }
          : { ok: true, code: 'ok', buildId: 'b' }
    });
    q<HTMLButtonElement>(harness, 'handoff-copy-open').click();
    await flush();
    await flush();
    expect(harness.clipboard).toHaveLength(1);
    expect(q(harness, 'handoff-target-status').textContent).toMatch(/could not be opened/);
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/Copied/);
  });

  it('double clicks while a slow copy is in flight do not copy or open twice', async () => {
    const harness = makeCard({ clipboardDelayMs: 30 });
    const primary = q<HTMLButtonElement>(harness, 'handoff-copy-open');
    primary.click();
    primary.click();
    primary.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.clipboard).toHaveLength(1);
    expect(harness.sent.filter((message) => message.type === 'HANDOFF_OPEN')).toHaveLength(1);
  });

  it('the session and revision are bound at click time, before any await', async () => {
    const harness = makeCard({ clipboardDelayMs: 20 });
    q<HTMLButtonElement>(harness, 'handoff-copy-open').click();
    // Typing during the slow copy does not change what was copied.
    const question = q<HTMLTextAreaElement>(harness, 'handoff-question');
    question.value = 'A different question typed meanwhile';
    question.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.clipboard[0]).toMatch(/Why does this step hold\?/);
    expect(harness.clipboard[0]).not.toMatch(/A different question/);
    // What the worker records as copied is the frozen revision, not the edit.
    const copied = harness.sent.find((message) => message.type === 'HANDOFF_COPIED') as Extract<HandoffRequest, { type: 'HANDOFF_COPIED' }>;
    expect(copied.prompt?.text).toBe(harness.clipboard[0]);
    expect(copied.prompt?.text).not.toMatch(/A different question/);
  });
});

describe('handoff card: clipboard clearing is explicit', () => {
  it('never clears the clipboard on its own, and says what clearing does', async () => {
    const harness = makeCard();
    q<HTMLButtonElement>(harness, 'handoff-copy').click();
    await flush();
    q<HTMLButtonElement>(harness, 'handoff-hide').click();
    await flush();
    expect(harness.clipboard).toHaveLength(1);
    const clear = q<HTMLButtonElement>(harness, 'handoff-clear-clipboard');
    expect(clear.textContent).toMatch(/replaces its contents/);
    clear.click();
    await flush();
    expect(harness.clipboard.at(-1)).toBe('');
    expect(harness.notices.at(-1)).toMatch(/Clipboard history or synced clipboards may still hold/);
  });
});

describe('handoff card: honest clipboard claims', () => {
  it('after Clear clipboard, never claims the prompt is on the clipboard, even when restored', async () => {
    const harness = makeCard();
    q<HTMLButtonElement>(harness, 'handoff-copy').click();
    await flush();
    q<HTMLButtonElement>(harness, 'handoff-clear-clipboard').click();
    await flush();
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/no longer on the clipboard/);
    const replaced = harness.sent.filter((message) => message.type === 'HANDOFF_COPIED').at(-1) as Extract<HandoffRequest, { type: 'HANDOFF_COPIED' }>;
    expect(replaced.replaced).toBe(true);
  });

  it('a card restored from a recorded copy says "copied earlier", not "on the clipboard"', () => {
    const prompt = preparePrompt(session().selection, session().draft, null);
    const harness = makeCard({ initial: { clipboard: 'copied', copied: prompt } });
    expect(q(harness, 'handoff-clipboard-status').textContent).toMatch(/Copied earlier/);
    expect(q(harness, 'handoff-clipboard-status').textContent).not.toMatch(/this exact prompt is on the clipboard/);
  });

  it('a focus refusal leaves the question in place and says so', async () => {
    const harness = makeCard({
      respond: (message) =>
        message.type === 'HANDOFF_OPEN'
          ? { ok: false, code: 'focus-failed', buildId: 'b', session: session({ target: { ...session().target, state: 'open', tabId: 9 } }) }
          : { ok: true, code: 'ok', buildId: 'b' }
    });
    q<HTMLButtonElement>(harness, 'handoff-open').click();
    await flush();
    await flush();
    expect(harness.disposed).toBe(false);
    expect(q(harness, 'handoff-target-status').textContent).toMatch(/did not switch to it/);
  });
});

describe('handoff card: explicit local note', () => {
  it('previews what will be saved and sends nothing until Save', async () => {
    const harness = makeCard();
    q<HTMLButtonElement>(harness, 'handoff-save-note-open').click();
    const preview = q(harness, 'handoff-note-preview').textContent ?? '';
    expect(preview).toContain('Source: Source chat');
    expect(preview).toContain('$S_2 \\ne S^2$');
    expect(preview).toMatch(/Question: Why does this step hold\?/);
    expect(harness.card.element.textContent).toMatch(/permanent local record/);
    expect(harness.sent.filter((message) => message.type === 'HANDOFF_SAVE_NOTE')).toEqual([]);
    q<HTMLButtonElement>(harness, 'handoff-note-cancel').click();
    expect(harness.sent.filter((message) => message.type === 'HANDOFF_SAVE_NOTE')).toEqual([]);
  });

  it('reports a failed save honestly and keeps the note', async () => {
    const harness = makeCard({
      respond: (message) =>
        message.type === 'HANDOFF_SAVE_NOTE'
          ? { ok: false, code: 'save-failed', buildId: 'b' }
          : { ok: true, code: 'ok', buildId: 'b', session: session() }
    });
    q<HTMLButtonElement>(harness, 'handoff-save-note-open').click();
    const note = q<HTMLTextAreaElement>(harness, 'handoff-note-text');
    note.value = 'my takeaway';
    q<HTMLButtonElement>(harness, 'handoff-note-save').click();
    await flush();
    await flush();
    expect(q(harness, 'handoff-note-status').textContent).toMatch(/Not saved/);
    expect(note.value).toBe('my takeaway');
  });

  it('a saved note says the temporary question itself is still not saved', async () => {
    const harness = makeCard();
    q<HTMLButtonElement>(harness, 'handoff-save-note-open').click();
    q<HTMLTextAreaElement>(harness, 'handoff-note-excerpt').value = 'pasted answer part';
    q<HTMLButtonElement>(harness, 'handoff-note-save').click();
    await flush();
    await flush();
    const save = harness.sent.find((message) => message.type === 'HANDOFF_SAVE_NOTE') as Extract<HandoffRequest, { type: 'HANDOFF_SAVE_NOTE' }>;
    expect(save.excerpt).toBe('pasted answer part');
    expect(harness.notices.at(-1)).toMatch(/temporary question itself is still not saved/);
  });
});

describe('handoff card: ending', () => {
  it('asks first, then clears the card and says what happened to the native tab', async () => {
    const harness = makeCard();
    q<HTMLButtonElement>(harness, 'handoff-copy-open').click();
    await flush();
    await flush();
    q<HTMLButtonElement>(harness, 'handoff-end').click();
    expect(harness.sent.filter((message) => message.type === 'HANDOFF_END')).toEqual([]);
    expect(harness.card.element.textContent).toMatch(/cannot be reopened after it is closed/);
    q<HTMLButtonElement>(harness, 'handoff-end-confirm').click();
    await flush();
    const end = harness.sent.find((message) => message.type === 'HANDOFF_END') as Extract<HandoffRequest, { type: 'HANDOFF_END' }>;
    expect(end.closeTarget).toBe(true);
    expect(harness.disposed).toBe(true);
    expect(document.body.textContent).not.toContain(MARKER);
    expect(harness.notices.at(-1)).toBe('Cleared from Aside.');
  });

  it('still clears the page when the worker cannot be reached', async () => {
    const harness = makeCard({ respond: () => null });
    q<HTMLButtonElement>(harness, 'handoff-end').click();
    q<HTMLButtonElement>(harness, 'handoff-end-confirm').click();
    await flush();
    expect(harness.disposed).toBe(true);
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('a target closed elsewhere drops the card and its text', () => {
    const harness = makeCard();
    harness.card.markEnded('The ChatGPT tab for this question was closed, so the temporary question was cleared from Aside.');
    expect(harness.disposed).toBe(true);
    expect(document.body.textContent).not.toContain(MARKER);
    // Late updates cannot bring it back.
    harness.card.adoptSession(session({ epoch: 9 }));
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('Escape inside the card hides it; the session is kept', async () => {
    const harness = makeCard();
    harness.card.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(harness.card.hidden).toBe(true);
    expect(harness.disposed).toBe(false);
    const update = harness.sent.find((message) => message.type === 'HANDOFF_UPDATE') as Extract<HandoffRequest, { type: 'HANDOFF_UPDATE' }>;
    expect(update.hidden).toBe(true);
  });
});

describe('clipboard writer', () => {
  it('uses the async clipboard API when it is allowed', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const result = await writeClipboardText('abc', document.body);
    expect(result).toEqual({ ok: true, code: 'ok' });
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('falls back to a selection copy, and reports a refusal without leaving the text in the page', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('Document is not focused', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    (document as unknown as { execCommand: (command: string) => boolean }).execCommand = () => false;
    const result = await writeClipboardText(`secret ${MARKER}`, document.body);
    expect(result).toEqual({ ok: false, code: 'clipboard-denied' });
    // A textarea's value is not in innerHTML: check the elements themselves.
    const areas = Array.from(document.querySelectorAll('textarea'));
    expect(areas.some((area) => area.value.includes(MARKER))).toBe(false);
    expect(areas).toHaveLength(0);
  });
});

describe('prepared prompt in the card matches the pure compiler', () => {
  it('preview equals preparePrompt for the same draft', () => {
    const harness = makeCard();
    const expected = preparePrompt(session().selection, session().draft, null).text;
    expect(q(harness, 'handoff-prompt').textContent).toBe(expected);
  });
});
