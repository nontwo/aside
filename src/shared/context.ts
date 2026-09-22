import type { ChatRole } from './types';

/**
 * The material a branch will submit, as a value the user can inspect and edit.
 *
 * One model for Ask, Why and New-tab on both providers, so what the preview shows
 * is what gets sent. Nothing here is inferred from a URL: a block is present only
 * because it was read out of the page.
 */

export type ContextBlockOrigin = 'touched' | 'preceding-question' | 'user-added';

export interface ContextBlock {
  id: string;
  role: ChatRole;
  /** Structured text, as the model will receive it. */
  text: string;
  /** Short label for the preview list. */
  excerpt: string;
  included: boolean;
  origin: ContextBlockOrigin;
  /** Set when extraction could not read the whole block. */
  limitation?: string;
}

export interface ContextLimits {
  /** Character ceiling for the assembled context. Characters, not tokens. */
  maxChars: number;
  usedChars: number;
  overBudget: boolean;
}

export interface BranchContext {
  /**
   * Bumped on every edit. An attempt captures the revision it started with, so a
   * later edit or a still-streaming source cannot change a prompt in flight.
   */
  revision: number;
  providerId: string;
  /** What the user actually selected, structured for the model. Never edited. */
  selectedPassage: string;
  /** Normalized form of the same selection, used only to find it again later. */
  anchorText: string;
  /** Where it came from, shown in the preview. */
  sourceLabel: string;
  blocks: ContextBlock[];
  /** Free text the user chose to add. Empty by default. */
  userBackground: string;
}

/**
 * Deliberately generous but finite. Aside cannot know the model's real window, so
 * this is a guard against sending something absurd, and it is always shown to the
 * user as an approximate character count rather than a token promise.
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 24_000;

export function createContext(input: {
  providerId: string;
  selectedPassage: string;
  anchorText: string;
  sourceLabel: string;
  blocks: ContextBlock[];
}): BranchContext {
  return {
    revision: 1,
    providerId: input.providerId,
    selectedPassage: input.selectedPassage,
    anchorText: input.anchorText,
    sourceLabel: input.sourceLabel,
    blocks: input.blocks,
    userBackground: ''
  };
}

export function withBlockIncluded(
  context: BranchContext,
  blockId: string,
  included: boolean
): BranchContext {
  return {
    ...context,
    revision: context.revision + 1,
    blocks: context.blocks.map((block) =>
      block.id === blockId ? { ...block, included } : block
    )
  };
}

export function withUserBackground(context: BranchContext, background: string): BranchContext {
  return { ...context, revision: context.revision + 1, userBackground: background };
}

export function includedBlocks(context: BranchContext): ContextBlock[] {
  return context.blocks.filter((block) => block.included);
}

/**
 * The context section of the prompt, exactly as it will be submitted. The preview
 * renders this same string, so there is no second code path to drift.
 */
export function renderContextText(context: BranchContext): string {
  const parts: string[] = ['SELECTED PASSAGE', context.selectedPassage];

  const answers = includedBlocks(context).filter((block) => block.role === 'assistant');
  answers.forEach((block, index) => {
    parts.push('', `SOURCE ANSWER ${index + 1} (id ${block.id})`, block.text);
  });

  const questions = includedBlocks(context).filter((block) => block.role === 'user');
  questions.forEach((block) => {
    parts.push('', `PRECEDING QUESTION (id ${block.id})`, block.text);
  });

  if (context.userBackground.trim()) {
    parts.push('', 'BACKGROUND THE USER ADDED', context.userBackground.trim());
  }

  const limitations = context.blocks
    .filter((block) => block.included && block.limitation)
    .map((block) => `- ${block.id}: ${block.limitation}`);
  if (limitations.length) {
    parts.push('', 'EXTRACTION LIMITATIONS', ...limitations);
  }

  return parts.join('\n');
}

export function measureContext(
  context: BranchContext,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS
): ContextLimits {
  const usedChars = renderContextText(context).length;
  return { maxChars, usedChars, overBudget: usedChars > maxChars };
}

/** Human-readable size, always labelled as an approximation. */
export function describeContextSize(limits: ContextLimits): string {
  const percent = Math.round((limits.usedChars / limits.maxChars) * 100);
  return `about ${limits.usedChars.toLocaleString()} characters (~${percent}% of Aside's ${limits.maxChars.toLocaleString()}-character limit)`;
}

/** A snapshot taken when an attempt starts, so a later edit cannot change it. */
export interface FrozenContext {
  revision: number;
  text: string;
  limits: ContextLimits;
}

export function freezeContext(
  context: BranchContext,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS
): FrozenContext {
  return {
    revision: context.revision,
    text: renderContextText(context),
    limits: measureContext(context, maxChars)
  };
}
