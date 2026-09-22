import { describe, expect, it } from 'vitest';

import { chatgptAdapter } from '../src/shared/providers';

/**
 * ChatGPT's layout selectors had no unit test at all. The Claude adapter has one
 * (tests/claude-fixtures.spec.ts); the older ChatGPT one was assumed correct
 * because the extension shipped, which is not the same thing — a live run on
 * 2026-09-22 found its selection-popup selectors match nothing on the real site.
 */
describe('ChatGPT layout selectors', () => {
  it('parses, so a malformed selector cannot silently disable a whole region', () => {
    const selectors = [
      ...chatgptAdapter.layout.reservedRegionSelectors.map((entry) => entry.selector),
      ...chatgptAdapter.layout.nativeSelectionToolbarSelectors
    ];

    expect(selectors.length).toBeGreaterThan(0);
    selectors.forEach((selector) => {
      expect(() => document.querySelectorAll(selector)).not.toThrow();
    });
  });

  it('does not match a plain button by its implicit ARIA role', () => {
    // The trap the harness fell into: `[role="toolbar"]` is an attribute selector.
    // A <button> has an implicit ARIA role of button and carries no role attribute,
    // so a stand-in built as a bare <button> matches none of these — which made the
    // old non-overlap test evidence about geometry, not about detection.
    document.body.innerHTML = '<button aria-label="Ask ChatGPT">Ask ChatGPT</button>';
    const standIn = document.querySelector('button')!;

    chatgptAdapter.layout.nativeSelectionToolbarSelectors.forEach((selector) => {
      expect(standIn.matches(selector)).toBe(false);
    });
  });

  it('keeps every reserved region kind that placement depends on', () => {
    const kinds = chatgptAdapter.layout.reservedRegionSelectors.map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['sidebar', 'composer', 'header']));
  });

  it('matches the regions it claims, on ChatGPT-shaped markup', () => {
    document.body.innerHTML = `
      <nav aria-label="Chat history"><a href="/c/1">Earlier chat</a></nav>
      <main>
        <header id="page-header">Model picker</header>
        <article data-message-author-role="assistant">
          <div class="markdown">An answer.</div>
        </article>
        <form data-type="unified-composer"><textarea></textarea></form>
      </main>
    `;

    const matched = chatgptAdapter.layout.reservedRegionSelectors
      .filter((entry) => document.querySelector(entry.selector))
      .map((entry) => entry.kind);

    expect(matched).toEqual(expect.arrayContaining(['sidebar', 'composer', 'header']));
  });
});
