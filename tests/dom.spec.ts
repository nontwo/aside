import {
  buildSelectionPayloadFromDraft,
  buildSelectionPayloadFromRange,
  captureSelectionDraftFromRange,
  countTranscriptTurns,
  extractCleanNodeText,
  extractStructuredNodeText,
  extractTranscript,
  findQuotedTextRangeInElement,
  findTurnElementByAnchor,
  getRecentAssistantTexts,
  isLikelyAssistantStatusText,
  rangeTouchesAssistantMessage,
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
    // Scope is provider-qualified now: a page with no addressable conversation gets a
    // session-scoped key rather than one global catch-all shared with every other page.
    expect(draft?.rootConversationId).toBe('chatgpt:session:default');
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

describe('transcript polling helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <div data-message-author-role="assistant">
          <article data-message-author-role="assistant">
            <div class="markdown">Wrapped assistant answer.</div>
          </article>
        </div>
        <article data-message-author-role="user">
          <div>A question.</div>
        </article>
        <article data-message-author-role="assistant">
          <div class="markdown">Latest assistant answer.</div>
        </article>
      </main>
    `;
  });

  it('counts a nested wrapper and its inner message as one turn', () => {
    expect(countTranscriptTurns(document)).toBe(3);
    expect(extractTranscript(document)).toHaveLength(3);
  });

  it('returns recent assistant texts newest first without rebuilding every turn', () => {
    const texts = getRecentAssistantTexts(2, document);

    expect(texts[0]).toBe('Latest assistant answer.');
    expect(texts[1]).toBe('Wrapped assistant answer.');
  });
});

describe('origin re-anchoring', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="assistant">
          <div class="markdown">An answer about convexity and relaxations.</div>
        </article>
        <article data-message-author-role="user">
          <div>Another question.</div>
        </article>
        <article data-message-author-role="assistant">
          <div class="markdown">A completely different answer about caching.</div>
        </article>
      </main>
    `;
  });

  it('prefers the message whose synthetic id still matches', () => {
    const turns = extractTranscript(document);
    const target = turns[2];

    const element = findTurnElementByAnchor({
      selectedBlocks: [
        {
          messageId: target.id,
          role: target.role,
          turnIndex: target.turnIndex,
          text: target.text,
          excerpt: target.excerpt
        }
      ],
      selectedText: 'caching'
    });

    expect(element).toBe(target.element);
  });

  it('falls back to the quoted text rather than a turn index that now points elsewhere', () => {
    // The conversation grew since the branch was created, so turnIndex 0 is no longer
    // the message the passage came from. A stale index must not beat a real text match.
    const element = findTurnElementByAnchor({
      selectedBlocks: [
        {
          messageId: 'assistant:0:staleHash',
          role: 'assistant',
          turnIndex: 0,
          text: 'A completely different answer about caching.',
          excerpt: 'A completely different answer about caching.'
        }
      ],
      selectedText: 'different answer about caching'
    });

    expect(element).toBe(extractTranscript(document)[2].element);
  });

  it('uses the turn index only when the role still agrees', () => {
    const element = findTurnElementByAnchor({
      selectedBlocks: [
        {
          messageId: 'assistant:1:staleHash',
          role: 'assistant',
          turnIndex: 1,
          text: 'text that is no longer present',
          excerpt: 'text that is no longer present'
        }
      ],
      selectedText: 'text that is no longer present'
    });

    // Turn 1 is now a user turn, so the positional guess is rejected instead of
    // scrolling the reader to somebody else's message.
    expect(element).toBeNull();
  });
});

describe('block-boundary text extraction', () => {
  beforeEach(() => {
    // ChatGPT's rendered markdown has no whitespace between sibling block elements.
    document.body.innerHTML =
      '<main><article data-message-author-role="assistant"><div class="markdown">' +
      '<p>First sentence ends here.</p><p>Second sentence starts here.</p>' +
      '<ul><li>alpha</li><li>beta</li></ul>' +
      '</div></article></main>';
  });

  it('does not fuse the last word of a block into the first word of the next', () => {
    const text = extractCleanNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('ends here. Second sentence');
    expect(text).not.toContain('here.Second');
    expect(text).toContain('alpha beta');
  });

  it('re-anchors a selection that spans a block boundary', () => {
    const markdown = document.querySelector('.markdown') as HTMLElement;
    const first = markdown.querySelectorAll('p')[0].firstChild as Text;
    const second = markdown.querySelectorAll('p')[1].firstChild as Text;

    const range = document.createRange();
    range.setStart(first, first.length - 'ends here.'.length);
    range.setEnd(second, 'Second sentence'.length);

    const draft = captureSelectionDraftFromRange(range);
    expect(draft?.selectedText).toBe('ends here. Second sentence');

    const found = findQuotedTextRangeInElement(markdown, {
      selectedText: draft!.selectedText,
      rangeQuotes: draft!.rangeQuotes
    });

    expect(found).not.toBeNull();
    expect(found!.toString().replace(/\s+/g, ' ')).toBe('ends here.Second sentence');
  });

  it('builds quote context from an element boundary without slicing by child index', () => {
    const markdown = document.querySelector('.markdown') as HTMLElement;
    const paragraph = markdown.querySelectorAll('p')[1];

    // An Element container whose offset is a child-node index, not a character offset.
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEnd(paragraph.firstChild as Text, 'Second sentence'.length);

    const draft = captureSelectionDraftFromRange(range);

    expect(draft?.rangeQuotes.exact).toBe('Second sentence');
    expect(draft?.rangeQuotes.prefix).toContain('First sentence ends here.');
    expect(draft?.rangeQuotes.suffix).toContain('starts here.');
  });
});

describe('selection text and re-anchoring index agree', () => {
  // extractCleanNodeText (which produces the selected passage and the prompt context) and
  // the internal index used by findQuotedTextRangeInElement (which finds that passage
  // again later) must produce the same string, or "Jump to origin" silently degrades.
  const shapes: Array<{ name: string; html: string; pick: string }> = [
    {
      name: 'sibling paragraphs',
      html: '<p>Alpha ends here.</p><p>Beta starts here.</p>',
      pick: 'ends here. Beta starts'
    },
    {
      name: 'list items',
      html: '<ul><li>first item</li><li>second item</li></ul>',
      pick: 'first item second item'
    },
    {
      name: 'inline markup inside one paragraph',
      html: '<p>use the <code>relax()</code> helper here</p>',
      pick: 'use the relax() helper'
    },
    {
      name: 'line breaks',
      html: '<p>line one<br>line two</p>',
      pick: 'line one line two'
    },
    {
      name: 'text and block mixed in a div',
      html: '<div>leading text<p>nested block</p>trailing text</div>',
      pick: 'leading text nested block trailing'
    },
    {
      name: 'table cells',
      html: '<table><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>',
      pick: 'cell one cell two'
    },
    {
      name: 'horizontal rule between text',
      html: '<div>before rule<hr>after rule</div>',
      pick: 'before rule after rule'
    }
  ];

  shapes.forEach(({ name, html, pick }) => {
    it(`re-anchors a passage across ${name}`, () => {
      document.body.innerHTML = `<main><article data-message-author-role="assistant"><div class="markdown">${html}</div></article></main>`;
      const markdown = document.querySelector('.markdown') as HTMLElement;

      expect(extractCleanNodeText(markdown)).toContain(pick);

      const found = findQuotedTextRangeInElement(markdown, {
        selectedText: pick,
        rangeQuotes: { exact: pick, prefix: '', suffix: '' }
      });

      expect(found, `${name} should re-anchor`).not.toBeNull();
      // The recovered range must cover the same words, ignoring how the DOM splits them.
      expect(found!.toString().replace(/\s+/g, '')).toBe(pick.replace(/\s+/g, ''));
    });
  });
});

describe('extraction and re-anchoring agree on generated markup', () => {
  // A property check rather than another hand-written shape: extractCleanNodeText and the
  // index behind findQuotedTextRangeInElement build the same string two different ways,
  // and every divergence silently breaks "Jump to origin" for some real answer.
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WRAPPERS = ['p', 'div', 'span', 'em', 'li', 'ul', 'td', 'pre', 'code', 'h2', 'blockquote'];
  // Markup ChatGPT renders that must not contribute text or separators.
  const STRIPPED = [
    '<span class="sr-only">screen reader</span>',
    '<div class="sr-only"><p>screen reader block</p></div>',
    '<div role="menu">menu</div>',
    '<div hidden><p>hidden</p></div>',
    '<span aria-busy="true"><div>busy</div></span>',
    '<button><div>Copy</div></button>',
    '<svg><text>icon</text></svg>'
  ];

  function generate(random: () => number, depth: number, counter: { value: number }): string {
    const roll = random();
    if (depth <= 0 || roll < 0.35) {
      counter.value += 1;
      return `word${counter.value}`;
    }
    if (roll < 0.5) {
      return STRIPPED[Math.floor(random() * STRIPPED.length)];
    }
    if (roll < 0.57) {
      return '<br>';
    }
    if (roll < 0.62) {
      return '<hr>';
    }

    const tag = WRAPPERS[Math.floor(random() * WRAPPERS.length)];
    const childCount = 1 + Math.floor(random() * 3);
    let inner = '';
    for (let index = 0; index < childCount; index += 1) {
      inner += generate(random, depth - 1, counter);
    }
    return `<${tag}>${inner}</${tag}>`;
  }

  it('re-anchors the extracted text of 400 generated answers', () => {
    const random = makeRandom(12345);
    const mismatches: string[] = [];

    for (let iteration = 0; iteration < 400; iteration += 1) {
      const counter = { value: 0 };
      let html = '';
      const topLevel = 1 + Math.floor(random() * 3);
      for (let index = 0; index < topLevel; index += 1) {
        html += generate(random, 3, counter);
      }

      document.body.innerHTML = `<main><article data-message-author-role="assistant"><div class="markdown">${html}</div></article></main>`;
      const markdown = document.querySelector('.markdown') as HTMLElement;
      const extracted = extractCleanNodeText(markdown);
      if (!extracted) {
        continue;
      }

      const found = findQuotedTextRangeInElement(markdown, {
        selectedText: extracted,
        rangeQuotes: { exact: extracted, prefix: '', suffix: '' }
      });

      if (!found) {
        mismatches.push(`${JSON.stringify(extracted)} from ${html}`);
      }
    }

    expect(mismatches.slice(0, 3)).toEqual([]);
  });
});

describe('assistant gating and anchor resolution edge cases', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user">
          <div>What about the convexity assumption?</div>
        </article>
        <article data-message-author-role="assistant">
          <div class="markdown">The convexity assumption keeps the relaxation tight.</div>
        </article>
        <article data-message-author-role="user">
          <div>And after that?</div>
        </article>
      </main>
    `;
  });

  it('offers the toolbar for a selection that wraps an assistant answer between two user turns', () => {
    const firstUser = document.querySelectorAll('article')[0].querySelector('div')!.firstChild as Text;
    const lastUser = document.querySelectorAll('article')[2].querySelector('div')!.firstChild as Text;

    const range = document.createRange();
    range.setStart(firstUser, 0);
    range.setEnd(lastUser, lastUser.length);

    // Neither boundary is inside an assistant message, but one sits in the middle.
    expect(rangeTouchesAssistantMessage(range)).toBe(true);
  });

  it('does not offer the toolbar for a selection with no assistant answer in it', () => {
    const lastUser = document.querySelectorAll('article')[2].querySelector('div')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(lastUser, 0);
    range.setEnd(lastUser, lastUser.length);

    expect(rangeTouchesAssistantMessage(range)).toBe(false);
  });

  it('jumps to the assistant answer, not the user question that quotes it', () => {
    const transcript = extractTranscript(document);
    const assistantTurn = transcript[1];

    const element = findTurnElementByAnchor({
      // A stale id, as happens when a branch is opened while the answer is still streaming.
      selectedBlocks: [
        {
          messageId: 'assistant:1:staleHash',
          role: 'assistant',
          turnIndex: 1,
          text: assistantTurn.text,
          excerpt: assistantTurn.excerpt
        }
      ],
      selectedText: 'convexity assumption'
    });

    expect(element).toBe(assistantTurn.element);
  });
});

describe('structured extraction for the model', () => {
  it('keeps code newlines and indentation instead of flattening them', () => {
    document.body.innerHTML =
      '<div class="markdown"><p>Try this:</p><pre><code>def f(x):\n    return x + 1</code></pre></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('def f(x):\n    return x + 1');
    // The matching form deliberately flattens; the model form must not.
    expect(extractCleanNodeText(document.querySelector('.markdown') as HTMLElement)).not.toContain(
      '\n    return'
    );
  });

  it('keeps list structure rather than running items together', () => {
    document.body.innerHTML =
      '<div class="markdown"><ul><li>first</li><li>second</li></ul></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('- first');
    expect(text).toContain('- second');
  });

  it('numbers ordered list items', () => {
    document.body.innerHTML =
      '<div class="markdown"><ol><li>alpha</li><li>beta</li><li>gamma</li></ol></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('1. alpha');
    expect(text).toContain('2. beta');
    expect(text).toContain('3. gamma');
  });

  it('keeps table rows separable', () => {
    document.body.innerHTML =
      '<div class="markdown"><table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('| a | b |');
    expect(text).toContain('| c | d |');
  });

  it('prefers LaTeX source over duplicated visual and assistive math', () => {
    document.body.innerHTML =
      '<div class="markdown"><p>Given <span data-latex="\\hat\\beta = (X^TX)^{-1}X^Ty">' +
      '<span class="katex-html">β̂ = (XᵀX)⁻¹Xᵀy</span>' +
      '<span class="katex-mathml">beta hat equals</span></span> we proceed.</p></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('$\\hat\\beta = (X^TX)^{-1}X^Ty$');
    // The assistive duplicate must not be included alongside it.
    expect(text).not.toContain('beta hat equals');
  });

  it('reads the TeX source out of KaTeX markup that carries no data-latex', () => {
    // The regression: every adapter lists `annotation`/`.katex-mathml` as
    // non-content, correctly, but that subtree is also the only place the source
    // lives. Stripping non-content first left the flattened glyph run, which is
    // exactly what the extraction exists to avoid.
    document.body.innerHTML =
      '<div class="markdown"><p>Given <span class="katex">' +
      '<span class="katex-mathml"><math><semantics>' +
      '<annotation encoding="application/x-tex">\\frac{\\partial L}{\\partial \\theta}</annotation>' +
      '</semantics></math></span>' +
      '<span class="katex-html" aria-hidden="true">∂L∂θ</span>' +
      '</span> is the gradient.</p></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('$\\frac{\\partial L}{\\partial \\theta}$');
    expect(text).not.toContain('∂L∂θ');
    expect(text).toContain('is the gradient.');
  });

  it('leaves no Aside attributes on the provider-s own message elements', () => {
    // Nothing writes to a provider-owned element. Reading the transcript used to
    // stamp two dataset attributes on every message node, re-written on every
    // poll and never removed.
    extractTranscript(document);

    document.querySelectorAll<HTMLElement>('article, .markdown').forEach((element) => {
      const attributes = Array.from(element.attributes).map((attribute) => attribute.name);
      expect(attributes.filter((name) => name.includes('aside'))).toEqual([]);
    });
  });

  it('drops provider controls from the model text', () => {
    document.body.innerHTML =
      '<div class="markdown"><p>Answer text.</p><button>Copy</button></div>';
    const text = extractStructuredNodeText(document.querySelector('.markdown') as HTMLElement);

    expect(text).toContain('Answer text.');
    expect(text).not.toContain('Copy');
  });
});
