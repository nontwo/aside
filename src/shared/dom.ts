import type { ChatRole, RangeQuotes, SelectedBlock, SelectionPayload, TranscriptTurn } from './types';
import {
  compactWhitespace,
  createSyntheticMessageId,
  getRootConversationId,
  normalizeChatUrl
} from './utils';

const MESSAGE_SELECTORS = [
  'article[data-message-author-role]',
  '[data-message-author-role]',
  'main [data-testid^="conversation-turn-"]'
].join(',');

const CONTENT_SELECTORS = [
  '[data-message-content]',
  '.markdown',
  '.prose',
  '[class*="markdown"]',
  '[class*="prose"]',
  '.whitespace-pre-wrap',
  '[data-testid*="conversation-turn-content"]'
];

const STRUCTURED_CONTENT_SELECTORS = [
  '[data-message-content]',
  '.markdown',
  '.prose',
  '[class*="markdown"]',
  '[class*="prose"]',
  'p',
  'li',
  'pre',
  'code',
  'table',
  'blockquote',
  'h1',
  'h2',
  'h3'
].join(',');

const NON_CONTENT_SELECTORS = [
  'script',
  'style',
  'noscript',
  'button',
  'textarea',
  'input',
  'select',
  'option',
  'svg',
  '[role="menu"]',
  '[role="tooltip"]',
  '[data-radix-popper-content-wrapper]',
  '.katex-mathml',
  '.MathJax_Assistive_MathML',
  '.mjx-assistive-mml',
  'mjx-assistive-mml',
  'annotation',
  'annotation-xml',
  '.sr-only',
  '.visually-hidden'
].join(',');

const ASSISTANT_LABEL_PATTERNS = [
  /^chatgpt\s*(says?|said)?\s*[:：]\s*/i,
  /^chatgpt\s*说\s*[:：]\s*/i,
  /^assistant\s*[:：]\s*/i,
  /^gpt\s*[:：]\s*/i
];

const ASSISTANT_STATUS_PATTERNS = [
  /^已思考\s*\d+\s*[秒s]?(?:\s*已思考\s*\d+\s*[秒s]?)*$/i,
  /^思考\s*\d+\s*[秒s]?(?:\s*思考\s*\d+\s*[秒s]?)*$/i,
  /^已思考中?(?:\s*\d+\s*[秒s]?)?(?:\s*已思考中?(?:\s*\d+\s*[秒s]?)?)*$/i,
  /^思考中(?:\s*\d+\s*[秒s]?)?(?:\s*思考中(?:\s*\d+\s*[秒s]?)?)*$/i,
  /^thought for\s*\d+\s*s(?:\s*thought for\s*\d+\s*s)*$/i,
  /^reasoned for\s*\d+\s*s(?:\s*reasoned for\s*\d+\s*s)*$/i,
  /^thinking(?:\.\.\.)?$/i,
  /^思考中(?:\.\.\.)?$/i,
  /^analyzing(?:\.\.\.)?$/i,
  /^分析中(?:\.\.\.)?$/i,
  /^searching the web(?:\.\.\.)?$/i,
  /^正在搜索(?:网络|网页)(?:\.\.\.)?$/i
];

export function stripAssistantLabel(text: string): string {
  let next = compactWhitespace(text);
  for (const pattern of ASSISTANT_LABEL_PATTERNS) {
    next = next.replace(pattern, '').trim();
  }
  return next;
}

export function extractCleanNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return compactWhitespace(node.textContent ?? '');
  }

  const container = document.createElement('div');
  container.append(node.cloneNode(true));

  container.querySelectorAll<HTMLElement>(NON_CONTENT_SELECTORS).forEach((element) => {
    element.remove();
  });

  container.querySelectorAll<HTMLElement>('[hidden],[aria-busy="true"]').forEach((element) => {
    element.remove();
  });

  return compactWhitespace(container.innerText || container.textContent || '');
}

export function extractCleanRangeText(range: Range): string {
  const fragment = range.cloneContents();
  return extractCleanNodeText(fragment);
}

export function isLikelyAssistantStatusText(text: string): boolean {
  const normalized = compactWhitespace(stripAssistantLabel(text));
  if (!normalized) {
    return true;
  }

  if (
    normalized.length <= 64 &&
    /(已思考|思考中|分析中|正在搜索|thinking|thought for|reasoned for|searching the web)/i.test(
      normalized
    ) &&
    !/[。.!?]/.test(normalized)
  ) {
    return true;
  }

  return ASSISTANT_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function inferRole(element: HTMLElement): ChatRole | null {
  const directRole = element.dataset.messageAuthorRole as ChatRole | undefined;
  if (directRole === 'assistant' || directRole === 'user' || directRole === 'system') {
    return directRole;
  }

  const nestedRole = element.querySelector<HTMLElement>('[data-message-author-role]')?.dataset
    .messageAuthorRole as ChatRole | undefined;
  if (nestedRole === 'assistant' || nestedRole === 'user' || nestedRole === 'system') {
    return nestedRole;
  }

  return null;
}

function getMessageText(element: HTMLElement, role: ChatRole): string {
  const candidates = [
    ...CONTENT_SELECTORS.flatMap((selector) =>
      Array.from(element.querySelectorAll<HTMLElement>(selector))
    ),
    element
  ];

  const normalizedCandidates = candidates
    .map((candidate) => ({
      text: extractCleanNodeText(candidate),
      isRoot: candidate === element,
      isStructured:
        candidate !== element &&
        (candidate.matches(STRUCTURED_CONTENT_SELECTORS) ||
          Boolean(candidate.querySelector(STRUCTURED_CONTENT_SELECTORS)))
    }))
    .filter((candidate) => Boolean(candidate.text))
    .sort((left, right) => {
      const leftScore = (left.isStructured ? 2 : 0) + (left.isRoot ? 0 : 1);
      const rightScore = (right.isStructured ? 2 : 0) + (right.isRoot ? 0 : 1);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return right.text.length - left.text.length;
    });

  const preferred =
    role === 'assistant'
      ? normalizedCandidates.find((candidate) => !isLikelyAssistantStatusText(candidate.text))
      : normalizedCandidates[0];
  const longest = preferred?.text ?? normalizedCandidates[0]?.text ?? '';

  return role === 'assistant' ? stripAssistantLabel(longest) : longest;
}

function uniqueMessageElements(root: ParentNode = document): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(MESSAGE_SELECTORS));
  const filtered = nodes.filter((candidate, index) => {
    if (!(candidate instanceof HTMLElement)) {
      return false;
    }

    return !nodes.some((other, otherIndex) => {
      if (index === otherIndex) {
        return false;
      }
      return other.contains(candidate) && inferRole(other) === inferRole(candidate);
    });
  });

  return filtered.filter((element) => inferRole(element) !== null);
}

export interface DomTranscriptTurn extends TranscriptTurn {
  element: HTMLElement;
}

export interface SelectionDraft {
  rootConversationId: string;
  rootChatUrl: string;
  selectedText: string;
  rangeQuotes: RangeQuotes;
  fallbackScrollY: number;
  selectionRect: DOMRect;
  range: Range;
}

export function extractTranscript(root: ParentNode = document): DomTranscriptTurn[] {
  return uniqueMessageElements(root)
    .map((element, turnIndex) => {
      const role = inferRole(element);
      if (!role) {
        return null;
      }

      const text = getMessageText(element, role);
      if (!text) {
        return null;
      }

      const id = createSyntheticMessageId(role, turnIndex, text);
      element.dataset.asideMessageId = id;
      element.dataset.asideTurnIndex = String(turnIndex);

      return {
        id,
        role,
        turnIndex,
        text,
        excerpt: text.slice(0, 160),
        element
      };
    })
    .filter((turn): turn is DomTranscriptTurn => Boolean(turn));
}

function getQuoteContext(range: Range): RangeQuotes {
  const exact = extractCleanRangeText(range);
  const startContainerText = range.startContainer.textContent ?? '';
  const endContainerText = range.endContainer.textContent ?? '';

  return {
    exact,
    prefix: startContainerText.slice(Math.max(0, range.startOffset - 40), range.startOffset).trim(),
    suffix: endContainerText.slice(range.endOffset, range.endOffset + 40).trim()
  };
}

function hasVisibleRect(rect: DOMRect | DOMRectReadOnly | null | undefined): rect is DOMRect | DOMRectReadOnly {
  return Boolean(rect && (rect.width > 0 || rect.height > 0));
}

function getVisibleClientRect(range: Range): DOMRect | DOMRectReadOnly | null {
  if (typeof range.getClientRects === 'function') {
    const rects = Array.from(range.getClientRects());
    const firstVisibleRect = rects.find((rect) => hasVisibleRect(rect));
    if (firstVisibleRect) {
      return firstVisibleRect;
    }
  }

  if (typeof range.getBoundingClientRect === 'function') {
    const boundingRect = range.getBoundingClientRect();
    if (hasVisibleRect(boundingRect)) {
      return boundingRect;
    }
  }

  const anchorElement =
    (range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement) ??
    (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement);
  if (anchorElement) {
    const anchorRect = anchorElement.getBoundingClientRect();
    if (hasVisibleRect(anchorRect)) {
      return anchorRect;
    }
  }

  return null;
}

function getRangeRect(range: Range): DOMRect {
  const visibleRect = getVisibleClientRect(range);
  if (visibleRect) {
    return new DOMRect(visibleRect.x, visibleRect.y, visibleRect.width, visibleRect.height);
  }

  return new DOMRect(
    window.innerWidth / 2,
    Math.max(16, window.innerHeight / 4),
    1,
    1
  );
}

export function captureSelectionDraftFromRange(range: Range): SelectionDraft | null {
  const selectedText = extractCleanRangeText(range);
  if (!selectedText) {
    return null;
  }

  const selectionRect = getRangeRect(range);
  const rootChatUrl = normalizeChatUrl(window.location.href);
  return {
    rootConversationId: getRootConversationId(rootChatUrl),
    rootChatUrl,
    selectedText,
    rangeQuotes: getQuoteContext(range),
    fallbackScrollY: window.scrollY,
    selectionRect,
    range: range.cloneRange()
  };
}

function getIntersectingMessageElements(
  range: Range
): Array<{ element: HTMLElement; turnIndex: number }> {
  return uniqueMessageElements(document)
    .map((element, turnIndex) => ({ element, turnIndex }))
    .filter(({ element }) => {
      try {
        return range.intersectsNode(element);
      } catch {
        return false;
      }
    });
}

function buildSelectedBlockFromElement(element: HTMLElement, turnIndex: number): SelectedBlock | null {
  const role = inferRole(element);
  if (!role) {
    return null;
  }

  const text = getMessageText(element, role);
  if (!text) {
    return null;
  }

  return {
    messageId: createSyntheticMessageId(role, turnIndex, text),
    role,
    turnIndex,
    text,
    excerpt: text.slice(0, 160)
  };
}

export function buildSelectionPayloadFromDraft(draft: SelectionDraft): SelectionPayload | null {
  const selectedBlocks = getIntersectingMessageElements(draft.range)
    .map(({ element, turnIndex }) => buildSelectedBlockFromElement(element, turnIndex))
    .filter((block): block is SelectedBlock => Boolean(block));

  const anchorAssistant = [...selectedBlocks].reverse().find((block) => block.role === 'assistant');
  if (!anchorAssistant) {
    return null;
  }

  return {
    rootConversationId: draft.rootConversationId,
    rootChatUrl: draft.rootChatUrl,
    selectedText: draft.selectedText,
    selectedBlocks,
    branchBaseMessageId: anchorAssistant.messageId,
    rangeQuotes: draft.rangeQuotes,
    fallbackScrollY: draft.fallbackScrollY
  };
}

export function buildSelectionPayloadFromRange(range: Range): SelectionPayload | null {
  const draft = captureSelectionDraftFromRange(range);
  if (!draft) {
    return null;
  }

  return buildSelectionPayloadFromDraft(draft);
}

interface TextPoint {
  node: Text;
  offset: number;
}

interface NormalizedTextIndex {
  text: string;
  points: Array<{
    start: TextPoint;
    end: TextPoint;
  }>;
}

function shouldIgnoreTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return true;
  }

  if (parent.closest(NON_CONTENT_SELECTORS)) {
    return true;
  }

  if (parent.closest('[hidden],[aria-busy="true"]')) {
    return true;
  }

  return false;
}

function buildNormalizedTextIndex(element: HTMLElement): NormalizedTextIndex {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  const points: NormalizedTextIndex['points'] = [];
  let pendingWhitespace:
    | {
        node: Text;
        offset: number;
      }
    | null = null;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (shouldIgnoreTextNode(node)) {
      continue;
    }

    const value = node.textContent ?? '';
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (/\s/.test(char)) {
        if (!text.length) {
          continue;
        }

        pendingWhitespace ??= { node, offset: index };
        continue;
      }

      if (pendingWhitespace) {
        text += ' ';
        points.push({
          start: pendingWhitespace,
          end: { node: pendingWhitespace.node, offset: pendingWhitespace.offset + 1 }
        });
        pendingWhitespace = null;
      }

      text += char;
      points.push({
        start: { node, offset: index },
        end: { node, offset: index + 1 }
      });
    }
  }

  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    points.pop();
  }

  return {
    text,
    points
  };
}

function getTrailingMatchLength(value: string, expectedSuffix: string): number {
  const left = compactWhitespace(value);
  const right = compactWhitespace(expectedSuffix);
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.endsWith(right.slice(right.length - length))) {
      return length;
    }
  }
  return 0;
}

function getLeadingMatchLength(value: string, expectedPrefix: string): number {
  const left = compactWhitespace(value);
  const right = compactWhitespace(expectedPrefix);
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.startsWith(right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export function findQuotedTextRangeInElement(
  element: HTMLElement,
  selection: Pick<SelectionPayload, 'selectedText' | 'rangeQuotes'>
): Range | null {
  const normalizedText = compactWhitespace(selection.rangeQuotes.exact || selection.selectedText);
  if (!normalizedText) {
    return null;
  }

  const index = buildNormalizedTextIndex(element);
  if (!index.text || !index.points.length) {
    return null;
  }

  let bestMatch:
    | {
        start: number;
        end: number;
        score: number;
      }
    | undefined;

  const candidates = Array.from(
    index.text.matchAll(new RegExp(normalizedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))
  );

  for (const match of candidates) {
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }

    const end = start + normalizedText.length;
    const prefixText = index.text.slice(0, start);
    const suffixText = index.text.slice(end);
    const prefixMatch = selection.rangeQuotes.prefix
      ? getTrailingMatchLength(prefixText, selection.rangeQuotes.prefix)
      : 0;
    const suffixMatch = selection.rangeQuotes.suffix
      ? getLeadingMatchLength(suffixText, selection.rangeQuotes.suffix)
      : 0;
    const fullPrefix = selection.rangeQuotes.prefix
      ? compactWhitespace(prefixText).endsWith(compactWhitespace(selection.rangeQuotes.prefix))
      : false;
    const fullSuffix = selection.rangeQuotes.suffix
      ? compactWhitespace(suffixText).startsWith(compactWhitespace(selection.rangeQuotes.suffix))
      : false;
    const score =
      prefixMatch * 3 +
      suffixMatch * 3 +
      (fullPrefix ? 40 : 0) +
      (fullSuffix ? 40 : 0) -
      start * 0.0001;

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { start, end, score };
    }
  }

  if (!bestMatch) {
    return null;
  }

  const startPoint = index.points[bestMatch.start]?.start;
  const endPoint = index.points[bestMatch.end - 1]?.end;
  if (!startPoint || !endPoint) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function findTurnElementByAnchor(anchor: {
  selectedBlocks: SelectedBlock[];
  selectedText: string;
}): HTMLElement | null {
  const transcript = extractTranscript(document);
  const candidates = [...anchor.selectedBlocks].reverse();

  for (const block of candidates) {
    const turn = transcript.find((item) => item.id === block.messageId || item.turnIndex === block.turnIndex);
    if (turn?.element) {
      return turn.element;
    }
  }

  const fallback = transcript.find((turn) => turn.text.includes(anchor.selectedText));
  return fallback?.element ?? null;
}

export function getLatestAssistantText(root: ParentNode = document): string {
  const transcript = extractTranscript(root).filter((turn) => turn.role === 'assistant');
  return transcript.at(-1)?.text ?? '';
}
