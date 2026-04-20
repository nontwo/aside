import {
  buildSelectionPayloadFromDraft,
  buildSelectionPayloadFromRange,
  captureSelectionDraftFromRange,
  extractCleanNodeText,
  extractTranscript,
  findQuotedTextRangeInElement,
  isLikelyAssistantStatusText,
  stripAssistantLabel
} from '../src/shared/dom';

describe('DOM transcript helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="assistant">
          <div class="markdown">First assistant explanation.</div>
        </article>
        <article data-message-author-role="user">
          <div>Follow-up question from the user.</div>
        </article>
        <article data-message-author-role="assistant">
          <div class="markdown">Second assistant explanation for the selected passage.</div>
        </article>
      </main>
    `;
  });

  it('extracts ordered transcript turns from ChatGPT-like markup', () => {
    const turns = extractTranscript(document);

    expect(turns).toHaveLength(3);
    expect(turns[0].role).toBe('assistant');
    expect(turns[1].role).toBe('user');
    expect(turns[2].role).toBe('assistant');
  });

  it('creates a selection payload anchored to the last assistant message touched', () => {
    const firstNode = document.querySelector('.markdown')?.firstChild;
    const secondNode = document.querySelectorAll('.markdown')[1]?.firstChild;
    expect(firstNode).toBeTruthy();
    expect(secondNode).toBeTruthy();

    const range = document.createRange();
    range.setStart(firstNode as Text, 6);
    range.setEnd(secondNode as Text, 20);

    const payload = buildSelectionPayloadFromRange(range);
    expect(payload).not.toBeNull();
    expect(payload?.selectedBlocks).toHaveLength(3);
    expect(payload?.branchBaseMessageId).toBe(payload?.selectedBlocks.at(-1)?.messageId);
  });

  it('captures a lightweight selection draft before payload materialization', () => {
    const secondNode = document.querySelectorAll('.markdown')[1]?.firstChild;
    expect(secondNode).toBeTruthy();

    const range = document.createRange();
    range.setStart(secondNode as Text, 0);
    range.setEnd(secondNode as Text, 18);

    const draft = captureSelectionDraftFromRange(range);
    expect(draft).not.toBeNull();
    expect(draft?.selectedText).toBe('Second assistant e');
    expect(draft?.rootConversationId).toBe('chat-home');
    expect(draft?.rangeQuotes.exact).toBe('Second assistant e');
  });

  it('materializes a selection payload from a draft using only touched message blocks', () => {
    const firstNode = document.querySelector('.markdown')?.firstChild;
    const secondNode = document.querySelectorAll('.markdown')[1]?.firstChild;
    expect(firstNode).toBeTruthy();
    expect(secondNode).toBeTruthy();

    const range = document.createRange();
    range.setStart(firstNode as Text, 6);
    range.setEnd(secondNode as Text, 20);

    const draft = captureSelectionDraftFromRange(range);
    expect(draft).not.toBeNull();

    const payload = buildSelectionPayloadFromDraft(draft!);
    expect(payload).not.toBeNull();
    expect(payload?.selectedBlocks).toHaveLength(3);
    expect(payload?.selectedBlocks.map((block) => block.role)).toEqual([
      'assistant',
      'user',
      'assistant'
    ]);
    expect(payload?.branchBaseMessageId).toBe(payload?.selectedBlocks.at(-1)?.messageId);
  });

  it('treats reasoning status labels as non-answer text', () => {
    expect(stripAssistantLabel('ChatGPT 说: 已思考 6s')).toBe('已思考 6s');
    expect(isLikelyAssistantStatusText('已思考 6s 已思考 6s')).toBe(true);
    expect(isLikelyAssistantStatusText('按日元算，约是 11.7 万日元。')).toBe(false);
  });

  it('strips assistive math markup from extracted text', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <span class="katex">
        <span class="katex-mathml">7.12\\times20000=142400</span>
        <span class="katex-html" aria-hidden="true">7.12×20000=142400</span>
      </span>
    `;

    expect(extractCleanNodeText(wrapper)).toBe('7.12×20000=142400');
  });

  it('reanchors the exact selected occurrence using quote context when text repeats', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="assistant">
          <div class="markdown">
            <p>First repeated text ending.</p>
            <p>Second repeated text target.</p>
          </div>
        </article>
      </main>
    `;

    const element = document.querySelector('.markdown') as HTMLElement;
    const range = findQuotedTextRangeInElement(element, {
      selectedText: 'repeated text',
      rangeQuotes: {
        exact: 'repeated text',
        prefix: 'Second ',
        suffix: ' target.'
      }
    });

    expect(range).not.toBeNull();
    expect(range?.toString()).toBe('repeated text');
    expect(range?.startContainer.textContent).toContain('Second repeated text target.');
  });

  it('reanchors quoted selections across inline markup boundaries', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="assistant">
          <div class="markdown">
            <p>Alpha <strong>selected</strong> text beta.</p>
          </div>
        </article>
      </main>
    `;

    const element = document.querySelector('.markdown') as HTMLElement;
    const range = findQuotedTextRangeInElement(element, {
      selectedText: 'selected text',
      rangeQuotes: {
        exact: 'selected text',
        prefix: 'Alpha ',
        suffix: ' beta.'
      }
    });

    expect(range).not.toBeNull();
    expect(range?.toString()).toBe('selected text');
  });
});
