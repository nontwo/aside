import { beforeEach, describe, expect, it } from 'vitest';

import { chatgptAdapter } from '../src/shared/providers';
import {
  buildSelectionPayloadFromRange,
  locatePassage,
  setActiveScopeResolver,
  setActiveTranscriptAdapter
} from '../src/shared/dom';
import type { SelectionPayload } from '../src/shared/types';

function render(answers: string[]): void {
  document.body.innerHTML = `<main>${answers
    .map(
      (answer, index) =>
        `<article data-message-author-role="user"><div class="markdown"><p>Question ${index}</p></div></article>` +
        `<article data-message-author-role="assistant"><div class="markdown"><p>${answer}</p></div></article>`
    )
    .join('')}</main>`;
}

function select(answerIndex: number, text: string): SelectionPayload {
  const paragraph = document.querySelectorAll('article[data-message-author-role="assistant"] p')[answerIndex] as HTMLElement;
  const node = paragraph.firstChild as Text;
  const start = node.data.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const payload = buildSelectionPayloadFromRange(range);
  if (!payload) {
    throw new Error('no payload');
  }
  return payload;
}

beforeEach(() => {
  setActiveTranscriptAdapter(chatgptAdapter.transcript);
  setActiveScopeResolver(() => ({ rootConversationId: 'chatgpt:c:a-1', rootChatUrl: 'https://chatgpt.com/c/a-1' }));
});

describe('returning to the passage', () => {
  it('finds the passage exactly in the message it came from', () => {
    render(['The convexity assumption keeps the bound tight.', 'Unrelated answer.']);
    const selection = select(0, 'convexity assumption');
    const found = locatePassage(selection);
    expect(found.status).toBe('exact');
    if (found.status === 'exact') {
      expect(found.range.toString()).toBe('convexity assumption');
    }
  });

  it('does not jump to a duplicate phrase in another message when the source message changed', () => {
    render(['The convexity assumption keeps the bound tight.', 'Here the convexity assumption fails badly.']);
    const selection = select(0, 'convexity assumption');
    // The first answer is regenerated: its identity and its text change.
    const first = document.querySelectorAll('article[data-message-author-role="assistant"] p')[0] as HTMLElement;
    first.textContent = 'A completely different first answer.';
    const found = locatePassage(selection);
    // The second message has the phrase, but not its recorded context.
    expect(found.status).toBe('not-found');
  });

  it('identity tells identical messages apart while it holds', () => {
    render(['Step: the convexity assumption holds.', 'Step: the convexity assumption holds.']);
    const found = locatePassage(select(1, 'convexity assumption'));
    expect(found.status).toBe('exact');
    if (found.status === 'exact') {
      const answers = document.querySelectorAll('article[data-message-author-role="assistant"]');
      expect(answers[1].contains(found.range.startContainer)).toBe(true);
    }
  });

  it('reports ambiguity instead of choosing, once identity no longer holds', () => {
    render(['Step: the convexity assumption holds.', 'Step: the convexity assumption holds.']);
    const selection = select(0, 'convexity assumption');
    // A turn inserted above shifts every position, so the recorded identity is gone
    // and two places agree equally well.
    const main = document.querySelector('main') as HTMLElement;
    main.insertAdjacentHTML(
      'afterbegin',
      '<article data-message-author-role="user"><div class="markdown"><p>Earlier</p></div></article>' +
        '<article data-message-author-role="assistant"><div class="markdown"><p>Earlier answer.</p></div></article>'
    );
    expect(locatePassage(selection).status).toBe('ambiguous');
  });

  it('uses the recorded context to pick the right occurrence inside one message', () => {
    render(['x holds for a; later, x holds for b.']);
    const selection = select(0, 'x holds for b');
    const found = locatePassage(selection);
    expect(found.status).toBe('exact');
    if (found.status === 'exact') {
      expect(found.range.toString()).toBe('x holds for b');
    }
  });

  it('says the passage changed when its message is still identifiable', () => {
    // The message id hashes the first 240 characters of the turn, so an edit
    // after them keeps the message identifiable while the passage changes.
    const head = 'Background sentence that stays exactly the same. '.repeat(6);
    render([`${head}Finally the bound stays tight here.`]);
    const selection = select(0, 'the bound stays tight');
    const paragraph = document.querySelector('article[data-message-author-role="assistant"] p') as HTMLElement;
    paragraph.textContent = `${head}Finally the bound becomes loose here.`;
    const found = locatePassage(selection);
    expect(found.status).toBe('message-only');
  });

  it('reports not-found when neither the message nor the passage is there', () => {
    render(['The convexity assumption keeps the bound tight.']);
    const selection = select(0, 'keeps the bound tight');
    const paragraph = document.querySelector('article[data-message-author-role="assistant"] p') as HTMLElement;
    paragraph.textContent = 'An entirely different answer.';
    expect(locatePassage(selection).status).toBe('not-found');
  });
});
