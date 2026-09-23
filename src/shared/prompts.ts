import { BRANCH_TITLE_PREFIX, BRANCH_TITLE_SUFFIX } from './constants';
import type { SelectionPayload } from './types';
import { buildPrompt } from '../context/template';

interface PromptBuildResult {
  prompt: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingStatusPreamble(rawText: string): string {
  let next = rawText.trimStart();
  const patterns = [
    /^(?:已思考|思考中?)\s*\d*\s*[秒s]?\s*[>›»]?\s*/i,
    /^(?:thought for|reasoned for)\s*\d+\s*s\s*[>›»]?\s*/i,
    /^(?:thinking|analyzing|searching the web)\s*[>›»]?\s*/i
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const replaced = next.replace(pattern, '');
      if (replaced !== next) {
        next = replaced.trimStart();
        changed = true;
      }
    }
  }

  return next;
}

/**
 * The answer contract lives in src/context/template.ts and is shared by every
 * entry point. It no longer asks the model for a title line: titles are local,
 * derived from the question or the selection, and renameable.
 */
function buildLocalSourceAnswers(selection: SelectionPayload): string {
  const assistantBlocks = selection.selectedBlocks.filter((block) => block.role === 'assistant');

  if (!assistantBlocks.length) {
    return '(no source answer could be read from the page)';
  }

  return assistantBlocks
    .map((block, index) =>
      [
        `SOURCE ANSWER ${index + 1}`,
        `messageId: ${block.messageId}`,
        block.text
      ].join('\n')
    )
    .join('\n\n');
}

function buildLocalContextSection(selection: SelectionPayload): string {
  return [
    'SELECTED PASSAGE',
    selection.selectedText,
    '',
    buildLocalSourceAnswers(selection)
  ].join('\n');
}

/**
 * The one prompt builder. Ask, Why and New-tab, on both providers, assemble the
 * same way from the same frozen context, so the preview and the submission cannot
 * drift apart.
 */
export function buildBranchPrompt(input: {
  contextText: string;
  question: string;
}): PromptBuildResult {
  return { prompt: buildPrompt({ contextText: input.contextText, question: input.question }) };
}

export function buildLocalInitialPrompt(
  selection: SelectionPayload,
  question: string
): PromptBuildResult {
  return buildBranchPrompt({
    contextText: buildLocalContextSection(selection),
    question
  });
}

export function buildFollowUpPrompt(
  selection: Pick<SelectionPayload, 'selectedText'>,
  question: string
): string {
  return [
    'Continue this branch conversation.',
    'The passage below is the anchor for interpretation; your own knowledge is still available.',
    '',
    'SELECTED PASSAGE',
    selection.selectedText,
    '',
    'FOLLOW-UP QUESTION',
    question
  ].join('\n');
}

export function stripHiddenTitle(rawText: string): { title?: string; cleanText: string } {
  const sanitized = stripLeadingStatusPreamble(rawText);
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(BRANCH_TITLE_PREFIX)}\\s*(.*?)\\s*${escapeRegExp(BRANCH_TITLE_SUFFIX)}\\s*\\n?`,
    'i'
  );
  const match = sanitized.match(pattern);

  if (!match) {
    return {
      cleanText: sanitized.trimStart()
    };
  }

  return {
    title: match[1]?.trim(),
    cleanText: sanitized.replace(pattern, '').trimStart()
  };
}
