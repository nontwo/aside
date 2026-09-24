/**
 * The prepared prompt for a scratch handoff: built from the selection the Owner
 * made, the question, what they removed and what they added — by the same
 * compiler and template as before, so the meaning of the context is unchanged.
 *
 * Pure: no DOM, no chrome.*. The card's preview and the clipboard write both
 * use `text` from one frozen PreparedPrompt, so they cannot differ.
 */

import { COMPILER_VERSION, buildContextPlan, describePlan, renderContextText } from '../context/plan';
import type { ContextPlan, PlanInput, SourceTurn } from '../context/plan';
import { TEMPLATE_VERSION, buildPrompt } from '../context/template';
import { DEFAULT_MAX_CONTEXT_CHARS } from '../shared/context';
import type { SelectionPayload } from '../shared/types';
import type { HandoffDraft, PreparedPrompt } from './types';

/** The turns Aside read for this selection, in order. */
export function sourceTurnsFor(selection: SelectionPayload): SourceTurn[] {
  const turns: SourceTurn[] = selection.selectedBlocks.map((block) => ({
    id: block.messageId,
    role: block.role,
    turnIndex: block.turnIndex,
    text: block.structuredText || block.text
  }));
  const preceding = selection.precedingQuestion;
  if (preceding && !turns.some((turn) => turn.id === preceding.messageId)) {
    turns.push({
      id: preceding.messageId,
      role: preceding.role,
      turnIndex: preceding.turnIndex,
      text: preceding.structuredText || preceding.text
    });
  }
  return turns.sort((left, right) => left.turnIndex - right.turnIndex);
}

/** The focus text as the prompt should carry it: structure-preserving, never the normalized quote. */
export function focusTextOf(selection: SelectionPayload): string {
  return selection.structuredSelectedText || selection.selectedText;
}

export function planForHandoff(
  selection: SelectionPayload,
  draft: HandoffDraft,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS
): ContextPlan {
  const turns = sourceTurnsFor(selection);
  const focusText = focusTextOf(selection);
  const anchorTurn =
    turns.find((turn) => turn.id === selection.branchBaseMessageId) ??
    [...turns].reverse().find((turn) => turn.role === 'assistant') ??
    turns[0] ?? {
      id: selection.branchBaseMessageId,
      role: 'assistant' as const,
      turnIndex: 0,
      text: focusText
    };
  const input: PlanInput = {
    focusText,
    anchorTurn,
    turns,
    question: draft.question.trim(),
    background: draft.background,
    excludedIds: draft.excludedBlockIds,
    // A handoff is a fresh native conversation: nothing from an earlier thread.
    history: [],
    unavailableReferences: [],
    enclosingEquations: selection.enclosingEquations ?? [],
    fidelityLimitations: selection.fidelity?.limitations ?? [],
    maxChars
  };
  return buildContextPlan(input);
}

const QUESTION_PLACEHOLDER = '(type your question)';

/**
 * Freeze one prompt revision. The revision only advances when the text
 * changes: re-copying an unchanged prompt reproduces the same string and the
 * same revision.
 */
export function preparePrompt(
  selection: SelectionPayload,
  draft: HandoffDraft,
  previous: PreparedPrompt | null
): PreparedPrompt {
  const plan = planForHandoff(selection, draft);
  const question = draft.question.trim();
  const text = buildPrompt({ contextText: renderContextText(plan), question: question || QUESTION_PLACEHOLDER });
  const revision = previous && previous.text === text ? previous.revision : (previous?.revision ?? 0) + 1;
  return {
    revision,
    text,
    question,
    compilerVersion: COMPILER_VERSION,
    templateVersion: TEMPLATE_VERSION,
    included: plan.blocks
      .filter((block) => block.included)
      .map((block) => ({ id: block.id, role: block.role, label: block.reason })),
    omitted: plan.blocks
      .filter((block) => !block.included)
      .map((block) => ({ id: block.id, label: block.reason, reason: block.omitReason === 'budget' ? 'budget' : 'user' })),
    missing: [...plan.missing],
    charCount: text.length,
    maxChars: plan.maxChars,
    overBudget: plan.overBudget
  };
}

/** One line for the card: what is in, what is left out, what is missing. */
export function summarizePlan(selection: SelectionPayload, draft: HandoffDraft): string {
  return describePlan(planForHandoff(selection, draft));
}
