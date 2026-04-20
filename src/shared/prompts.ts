import {
  BRANCH_TITLE_PREFIX,
  BRANCH_TITLE_SUFFIX
} from './constants';
import type { SelectionPayload } from './types';

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

function buildSharedInstructions(): string {
  return [
    'Before your answer, output exactly one line in this format:',
    `${BRANCH_TITLE_PREFIX} concise lower-case title${BRANCH_TITLE_SUFFIX}`,
    'Use at most 7 words for the title.',
    'The title must be based only on the local focus and the user question.',
    'Then continue with the answer on the next line.',
    'Treat the selected local focus as primary context.',
    'Stay local to that focus unless the user explicitly asks to broaden scope.',
    'Answer briefly by default.'
  ].join('\n');
}

function buildLocalSourceAnswers(selection: SelectionPayload): string {
  const assistantBlocks = selection.selectedBlocks.filter((block) => block.role === 'assistant');

  if (!assistantBlocks.length) {
    return '(no assistant source answer was captured)';
  }

  return assistantBlocks
    .map((block, index) =>
      [
        `LOCAL SOURCE ANSWER ${index + 1}`,
        `messageId: ${block.messageId}`,
        block.text
      ].join('\n')
    )
    .join('\n\n');
}

function buildLocalContextSection(selection: SelectionPayload): string {
  return [
    'Use only the local context below. Do not rely on the original conversation or any broader chat history.',
    'If the answer needs missing context, say what is missing briefly instead of guessing from the original conversation.',
    'Treat SELECTED PASSAGE as the primary focus. Use LOCAL SOURCE ANSWER only to clarify that passage.',
    '',
    'SELECTED PASSAGE',
    selection.selectedText,
    '',
    buildLocalSourceAnswers(selection)
  ].join('\n');
}

export function buildLocalInitialPrompt(
  selection: SelectionPayload,
  question: string
): PromptBuildResult {
  return {
    prompt: [
      buildSharedInstructions(),
      '',
      buildLocalContextSection(selection),
      '',
      'USER QUESTION',
      question
    ].join('\n')
  };
}

export function buildNativeBootstrapPrompt(selection: SelectionPayload): PromptBuildResult {
  return {
    prompt: [
      'Before your answer, output exactly one line in this format:',
      `${BRANCH_TITLE_PREFIX} concise lower-case title${BRANCH_TITLE_SUFFIX}`,
      'Use at most 7 words for the title.',
      'Base the title only on the local focus below.',
      'Then on the next line output exactly:',
      'Ready for your question.',
      'Do not add anything else.',
      '',
      buildLocalContextSection(selection),
      '',
      'BRANCH TASK',
      'Create a local branch context and wait for the user to ask the real follow-up question.'
    ].join('\n')
  };
}

export function buildFollowUpPrompt(
  selection: Pick<SelectionPayload, 'selectedText'>,
  question: string
): string {
  return [
    'Continue this branch conversation.',
    'Keep the selected local focus in mind as the default anchor for interpretation.',
    'Stay concise unless the user asks for a longer answer.',
    '',
    'LOCAL FOCUS',
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
