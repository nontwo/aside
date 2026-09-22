import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_CONTEXT_CHARS,
  createContext,
  describeContextSize,
  freezeContext,
  includedBlocks,
  measureContext,
  renderContextText,
  withBlockIncluded,
  withUserBackground
} from '../src/shared/context';
import type { BranchContext, ContextBlock } from '../src/shared/context';

function block(overrides: Partial<ContextBlock> & { id: string }): ContextBlock {
  return {
    role: 'assistant',
    text: 'source answer text',
    excerpt: 'source answer text',
    included: true,
    origin: 'touched',
    ...overrides
  };
}

function makeContext(blocks: ContextBlock[] = [block({ id: 'a1' })]): BranchContext {
  return createContext({
    providerId: 'chatgpt',
    selectedPassage: 'the convexity assumption',
    anchorText: 'the convexity assumption',
    sourceLabel: 'ChatGPT · conversation conv-1',
    blocks
  });
}

describe('context contents', () => {
  it('always carries the selected passage', () => {
    const text = renderContextText(makeContext());
    expect(text).toContain('SELECTED PASSAGE');
    expect(text).toContain('the convexity assumption');
  });

  it('labels each included answer with its message id', () => {
    const text = renderContextText(makeContext([block({ id: 'a1' }), block({ id: 'a2' })]));
    expect(text).toContain('SOURCE ANSWER 1 (id a1)');
    expect(text).toContain('SOURCE ANSWER 2 (id a2)');
  });

  it('leaves the preceding question out until the user includes it', () => {
    // Extra history is opt-in: the default must not widen what gets sent.
    const question = block({
      id: 'q1',
      role: 'user',
      origin: 'preceding-question',
      included: false,
      text: 'what about convexity?'
    });
    const context = makeContext([block({ id: 'a1' }), question]);

    expect(renderContextText(context)).not.toContain('what about convexity?');
    expect(includedBlocks(context)).toHaveLength(1);

    const widened = withBlockIncluded(context, 'q1', true);
    expect(renderContextText(widened)).toContain('PRECEDING QUESTION (id q1)');
    expect(renderContextText(widened)).toContain('what about convexity?');
  });

  it('lets the user remove an answer block that was included by default', () => {
    const context = withBlockIncluded(makeContext(), 'a1', false);
    expect(renderContextText(context)).not.toContain('source answer text');
  });

  it('includes background the user typed, and nothing when they typed none', () => {
    expect(renderContextText(makeContext())).not.toContain('BACKGROUND THE USER ADDED');

    const context = withUserBackground(makeContext(), 'assume full column rank');
    expect(renderContextText(context)).toContain('BACKGROUND THE USER ADDED');
    expect(renderContextText(context)).toContain('assume full column rank');
  });

  it('declares extraction limitations rather than hiding them', () => {
    const context = makeContext([
      block({ id: 'a1', limitation: 'a formula was only partly selected' })
    ]);
    const text = renderContextText(context);

    expect(text).toContain('EXTRACTION LIMITATIONS');
    expect(text).toContain('a formula was only partly selected');
  });
});

describe('context revisions', () => {
  it('bumps on every edit so an in-flight prompt can be pinned to one', () => {
    const context = makeContext();
    expect(context.revision).toBe(1);
    expect(withBlockIncluded(context, 'a1', false).revision).toBe(2);
    expect(withUserBackground(context, 'x').revision).toBe(2);
  });

  it('freezes the text so a later edit cannot change what was sent', () => {
    const context = makeContext();
    const frozen = freezeContext(context);

    const edited = withUserBackground(context, 'added after the attempt started');

    expect(frozen.revision).toBe(1);
    expect(frozen.text).not.toContain('added after the attempt started');
    expect(renderContextText(edited)).toContain('added after the attempt started');
  });
});

describe('context size', () => {
  it('reports usage without clipping anything', () => {
    const big = 'x'.repeat(DEFAULT_MAX_CONTEXT_CHARS + 500);
    const context = makeContext([block({ id: 'a1', text: big })]);
    const limits = measureContext(context);

    expect(limits.overBudget).toBe(true);
    // The passage and the answer are still present in full: the user decides what
    // to remove, rather than the prompt being silently truncated.
    expect(renderContextText(context)).toContain(big);
  });

  it('describes size as an approximation, never as a token promise', () => {
    const description = describeContextSize(measureContext(makeContext()));
    expect(description).toMatch(/^about /);
    expect(description).toMatch(/characters/);
    expect(description).not.toMatch(/token/i);
  });

  it('is under budget for an ordinary selection', () => {
    expect(measureContext(makeContext()).overBudget).toBe(false);
  });
});
