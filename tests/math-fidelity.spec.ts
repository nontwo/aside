import { beforeEach, describe, expect, it } from 'vitest';

import { chatgptAdapter } from '../src/shared/providers';
import {
  captureSelectionDraftFromRange,
  extractStructuredNodeText,
  extractStructuredSelection,
  setActiveScopeResolver,
  setActiveTranscriptAdapter
} from '../src/shared/dom';

/**
 * Realistic KaTeX markup: the visual `.katex-html` subtree carries glyphs and
 * position-only spans; the assistive `.katex-mathml` subtree carries the TeX
 * annotation. A browser selection made by the user starts and ends inside the
 * VISUAL subtree, which is exactly what `cloneContents()` then strips of its
 * source.
 */
function katex(tex: string, glyphs: string): string {
  return (
    `<span class="katex">` +
    `<span class="katex-mathml"><math><semantics><mrow></mrow>` +
    `<annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>` +
    `<span class="katex-html" aria-hidden="true"><span class="base">${glyphs}</span></span>` +
    `</span>`
  );
}

function setPage(inner: string): HTMLElement {
  document.body.innerHTML = `
    <main>
      <article data-message-author-role="user"><div class="markdown"><p>Explain the estimate.</p></div></article>
      <article data-message-author-role="assistant"><div class="markdown">${inner}</div></article>
    </main>`;
  return document.querySelector('article[data-message-author-role="assistant"] .markdown') as HTMLElement;
}

/** A Range whose endpoints are text offsets inside the given elements. */
function rangeBetween(startEl: Node, startOffset: number, endEl: Node, endOffset: number): Range {
  const range = document.createRange();
  range.setStart(startEl, startOffset);
  range.setEnd(endEl, endOffset);
  return range;
}

function firstText(element: Element | null): Text {
  const walker = document.createTreeWalker(element as Node, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) {
    throw new Error('no text node');
  }
  return node as Text;
}

beforeEach(() => {
  setActiveTranscriptAdapter(chatgptAdapter.transcript);
  setActiveScopeResolver(() => ({
    rootConversationId: 'chatgpt:c:math-1',
    rootChatUrl: 'https://chatgpt.com/c/math-1'
  }));
});

describe('math fidelity through the selection pipeline', () => {
  it('a selection made entirely inside the visual subtree keeps the TeX source', () => {
    // The mechanism behind the garbled previews: cloneContents() of a range inside
    // .katex-html carries glyphs only. The wrapper and annotation are outside it.
    const markdown = setPage(`<p>Then ${katex('S_2 \\\\ne S^2', 'S2≠S2')} holds.</p>`);
    const glyphs = markdown.querySelector('.katex-html .base') as HTMLElement;
    const glyphText = firstText(glyphs);
    const range = rangeBetween(glyphText, 0, glyphText, glyphText.length);

    const structured = extractStructuredSelection(range);
    expect(structured.text).toContain('$S_2 \\\\ne S^2$');
    expect(structured.text).not.toContain('S2≠S2');
    expect(structured.fidelity.equations).toEqual([{ source: 'S_2 \\\\ne S^2', coverage: 'full' }]);
    expect(structured.fidelity.limitations).toEqual([]);
  });

  it('distinguishes a subscript from a superscript and a negated relation from equality', () => {
    const markdown = setPage(`<p>${katex('x_i', 'xi')} and ${katex('x^i', 'xi')} and ${katex('a \\\\ne b', 'a≠b')}</p>`);
    const paragraph = markdown.querySelector('p') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    const text = extractStructuredSelection(range).text;
    expect(text).toContain('$x_i$');
    expect(text).toContain('$x^i$');
    expect(text).toContain('$a \\\\ne b$');
    expect(text).not.toMatch(/\\bxi\\b/);
  });

  it('a selection crossing a math/text boundary keeps both the prose and the source', () => {
    const markdown = setPage(`<p>where ${katex('\\\\hat\\\\beta', 'β̂')} is the estimator</p>`);
    const paragraph = markdown.querySelector('p') as HTMLElement;
    const leading = paragraph.firstChild as Text; // "where "
    const glyphs = firstText(markdown.querySelector('.katex-html') as Element);
    const range = rangeBetween(leading, 2, glyphs, glyphs.length);

    const structured = extractStructuredSelection(range);
    expect(structured.text).toContain('ere');
    expect(structured.text).toContain('$\\\\hat\\\\beta$');
    expect(structured.text).not.toContain('β̂');
  });

  it('a selection of part of an equation is reported as partial with the whole source as context', () => {
    const markdown = setPage(`<p>${katex('\\\\int_0^T H_t\\\\,dW_t = 0', '∫0T Ht dWt = 0')}</p>`);
    const glyphs = firstText(markdown.querySelector('.katex-html .base') as Element);
    // Only the first few glyphs: the user dragged across part of the formula.
    const range = rangeBetween(glyphs, 0, glyphs, 3);

    const structured = extractStructuredSelection(range);
    expect(structured.fidelity.equations[0].coverage).toBe('partial');
    expect(structured.enclosingEquations).toEqual(['\\\\int_0^T H_t\\\\,dW_t = 0']);
    expect(structured.text).toMatch(/covers only part of the equation/);
    expect(structured.fidelity.limitations[0]).toMatch(/part of an equation/);
  });

  it('handles mixed Chinese prose around a formula', () => {
    const markdown = setPage(`<p>因此 ${katex('\\\\mathbb{E}[X_n] = 0', 'E[Xn] = 0')} 成立。</p>`);
    const paragraph = markdown.querySelector('p') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    const text = extractStructuredSelection(range).text;
    expect(text).toContain('因此');
    expect(text).toContain('$\\\\mathbb{E}[X_n] = 0$');
    expect(text).toContain('成立');
    expect(text).not.toContain('E[Xn]');
  });

  it('keeps duplicate formulas distinct by position rather than merging them', () => {
    const markdown = setPage(
      `<p>First ${katex('S^2', 'S2')}.</p><p>Second ${katex('S^2', 'S2')} again.</p>`
    );
    const second = markdown.querySelectorAll('p')[1] as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(second);

    const structured = extractStructuredSelection(range);
    expect(structured.text).toContain('Second $S^2$ again.');
    expect(structured.fidelity.equations).toHaveLength(1);
  });

  it('discloses an equation whose source is not exposed instead of pretending', () => {
    const markdown = setPage(
      `<p>see <span class="katex"><span class="katex-html"><span class="base">a2+b2</span></span></span> here</p>`
    );
    const paragraph = markdown.querySelector('p') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    const structured = extractStructuredSelection(range);
    expect(structured.fidelity.unreadableEquations).toBe(1);
    expect(structured.fidelity.limitations.join(' ')).toMatch(/no readable source/);
  });

  it('the whole message text (used for source blocks) reads the same source', () => {
    const markdown = setPage(`<p>Given ${katex('S_2 \\\\ne S^2', 'S2≠S2')}.</p>`);
    expect(extractStructuredNodeText(markdown)).toContain('$S_2 \\\\ne S^2$');
  });

  it('the captured draft carries fidelity and the structured focus, not the glyph run', () => {
    const markdown = setPage(`<p>Then ${katex('S_2 \\\\ne S^2', 'S2≠S2')} holds.</p>`);
    const glyphs = firstText(markdown.querySelector('.katex-html .base') as Element);
    const range = rangeBetween(glyphs, 0, glyphs, glyphs.length);

    const draft = captureSelectionDraftFromRange(range);
    expect(draft?.structuredSelectedText).toContain('$S_2 \\\\ne S^2$');
    // The normalized anchor text is for finding the passage again, and stays glyphs.
    expect(draft?.selectedText).toContain('S2≠S2');
    expect(draft?.fidelity.equations[0].coverage).toBe('full');
  });
});
