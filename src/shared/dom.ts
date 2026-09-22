import type { ChatRole, RangeQuotes, SelectedBlock, SelectionPayload, TranscriptTurn } from './types';
import { chatgptAdapter } from './providers/chatgpt';
import type { TranscriptAdapter } from './providers/types';
import { compactWhitespace, createSyntheticMessageId, normalizeChatUrl } from './utils';

/**
 * Transcript reading is provider-specific, but everything built on top of it —
 * selection capture, re-anchoring, context assembly — is not. The active adapter is
 * set once per document by the content script; tests set it explicitly.
 */
let activeTranscript: TranscriptAdapter = chatgptAdapter.transcript;

export function setActiveTranscriptAdapter(adapter: TranscriptAdapter): void {
  activeTranscript = adapter;
}

export function getActiveTranscriptAdapter(): TranscriptAdapter {
  return activeTranscript;
}

/**
 * Scope of the document a selection is captured from. Provider-specific, because a
 * conversation id means different things on different providers and a page with no
 * addressable conversation still needs a stable, non-colliding scope.
 */
export interface DocumentScope {
  rootConversationId: string;
  rootChatUrl: string;
}

let activeScopeResolver: () => DocumentScope = () => {
  const rootChatUrl = normalizeChatUrl(window.location.href);
  return {
    rootConversationId: chatgptAdapter.identify(rootChatUrl, 'default').scopeKey,
    rootChatUrl
  };
};

export function setActiveScopeResolver(resolver: () => DocumentScope): void {
  activeScopeResolver = resolver;
}

export function stripAssistantLabel(text: string): string {
  return activeTranscript.stripAssistantLabel(text);
}

const BLOCK_LEVEL_SELECTORS = [
  'address',
  'article',
  'blockquote',
  'div',
  'dd',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
].join(',');

export function extractCleanNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return compactWhitespace(node.textContent ?? '');
  }

  const container = document.createElement('div');
  container.append(node.cloneNode(true));

  container.querySelectorAll<HTMLElement>(activeTranscript.nonContentSelector).forEach((element) => {
    element.remove();
  });

  container.querySelectorAll<HTMLElement>('[hidden],[aria-busy="true"]').forEach((element) => {
    element.remove();
  });

  // The container is never inserted into the document, so innerText is specified to fall
  // back to textContent. ChatGPT's rendered markdown has no whitespace between sibling
  // block elements, which fused the last word of a paragraph into the first word of the
  // next one. Write the boundaries in explicitly rather than depending on layout.
  container.querySelectorAll('br').forEach((element) => {
    element.replaceWith(document.createTextNode(' '));
  });
  container.querySelectorAll<HTMLElement>(BLOCK_LEVEL_SELECTORS).forEach((element) => {
    element.prepend(document.createTextNode(' '));
    element.append(document.createTextNode(' '));
  });

  return compactWhitespace(container.textContent ?? '');
}

/**
 * Text for the MODEL, as opposed to text for matching.
 *
 * extractCleanNodeText normalizes whitespace so a passage can be found again later.
 * That is exactly wrong for a prompt: it flattens code indentation, turns a list
 * into a run-on sentence and destroys table structure. This keeps the structure a
 * reader would see — and keeps LaTeX/MathML source rather than the duplicated
 * visual+assistive rendering of an equation.
 */
export function extractStructuredNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }

  const container = document.createElement('div');
  container.append(node.cloneNode(true));

  // Promote the equation source BEFORE stripping non-content. Every adapter lists
  // `annotation`/`.katex-mathml` as non-content — correctly, because it is the
  // assistive duplicate of the visual glyphs — but that subtree is also the only
  // place the TeX source lives. Stripping first would leave the flattened glyph
  // run, which is what the previous order did.
  container
    .querySelectorAll<HTMLElement>('[data-latex], annotation[encoding*="tex" i]')
    .forEach((element) => {
      const latex = element.getAttribute('data-latex') ?? element.textContent ?? '';
      if (!latex.trim()) {
        return;
      }
      // Replace the OUTERMOST equation wrapper, not the annotation and not the
      // nearest ancestor. The source usually sits inside `.katex-mathml`, which is
      // itself non-content: replacing only the inner `<math>` would leave the
      // substituted text inside a subtree that is stripped a moment later, and the
      // visible glyph run beside it would survive as the only remaining text.
      const equation =
        element.closest<HTMLElement>('.katex') ??
        element.closest<HTMLElement>('[data-latex]') ??
        element.closest<HTMLElement>('math') ??
        element;
      equation.replaceWith(document.createTextNode(` $${latex.trim()}$ `));
    });

  container.querySelectorAll<HTMLElement>(activeTranscript.nonContentSelector).forEach((element) => {
    element.remove();
  });
  container.querySelectorAll<HTMLElement>('[hidden],[aria-busy="true"]').forEach((element) => {
    element.remove();
  });

  return renderStructured(container).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const BLOCK_BREAK_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'TABLE',
  'PRE',
  'HR',
  'FIGURE'
]);

function renderStructured(root: Node, depth = 0): string {
  let out = '';

  root.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? '';
      return;
    }

    if (!(child instanceof Element)) {
      return;
    }

    const tag = child.tagName;

    if (tag === 'BR') {
      out += '\n';
      return;
    }

    if (tag === 'PRE') {
      // Code keeps its newlines and indentation verbatim.
      const code = child.textContent ?? '';
      out += `\n\n\u0060\u0060\u0060\n${code.replace(/\n+$/, '')}\n\u0060\u0060\u0060\n\n`;
      return;
    }

    if (tag === 'LI') {
      const marker = child.parentElement?.tagName === 'OL' ? `${indexOfListItem(child)}. ` : '- ';
      out += `\n${'  '.repeat(depth)}${marker}${renderStructured(child, depth + 1).trim()}`;
      return;
    }

    if (tag === 'TR') {
      const cells = Array.from(child.children).map((cell) =>
        renderStructured(cell, depth).replace(/\s+/g, ' ').trim()
      );
      out += `\n| ${cells.join(' | ')} |`;
      return;
    }

    if (BLOCK_BREAK_TAGS.has(tag)) {
      out += `\n\n${renderStructured(child, depth).trim()}\n\n`;
      return;
    }

    out += renderStructured(child, depth);
  });

  return out;
}

function indexOfListItem(item: Element): number {
  let index = 1;
  let sibling = item.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === 'LI') {
      index += 1;
    }
    sibling = sibling.previousElementSibling;
  }
  return index;
}

export function extractStructuredRangeText(range: Range): string {
  return extractStructuredNodeText(range.cloneContents());
}

export function extractCleanRangeText(range: Range): string {
  const fragment = range.cloneContents();
  return extractCleanNodeText(fragment);
}

export function isLikelyAssistantStatusText(text: string): boolean {
  return activeTranscript.isStatusText(text);
}

function inferRole(element: HTMLElement): ChatRole | null {
  return activeTranscript.inferRole(element);
}

function getMessageText(element: HTMLElement, role: ChatRole): string {
  const candidates = [
    ...activeTranscript.contentSelectors.flatMap((selector) =>
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
        (candidate.matches(activeTranscript.structuredContentSelector) ||
          Boolean(candidate.querySelector(activeTranscript.structuredContentSelector)))
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
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(activeTranscript.messageSelector));

  // inferRole walks the subtree, and this runs inside polling loops on conversations
  // with hundreds of turns, so resolve each role once and compare against ancestors
  // instead of every other candidate.
  const roles = new Map<HTMLElement, ChatRole | null>();
  nodes.forEach((node) => {
    roles.set(node, inferRole(node));
  });

  return nodes.filter((candidate) => {
    const role = roles.get(candidate) ?? null;
    if (role === null) {
      return false;
    }

    // Some ChatGPT layouts wrap a message element in an outer element that also
    // matches the message selector; keep only the innermost one for a given role.
    let ancestor = candidate.parentElement;
    while (ancestor) {
      if (roles.has(ancestor) && roles.get(ancestor) === role) {
        return false;
      }
      ancestor = ancestor.parentElement;
    }

    return true;
  });
}

// The toolbar promises a branch, but a branch needs an assistant answer to anchor to.
// Checking before showing it avoids offering Ask/Why/New-tab on a selection whose click
// can only be a silent no-op.
export function rangeTouchesAssistantMessage(range: Range): boolean {
  const boundaries = [range.startContainer, range.endContainer, range.commonAncestorContainer];

  const boundaryHit = boundaries.some((node) => {
    const element = node instanceof Element ? node : node.parentElement;
    const turn = element?.closest<HTMLElement>(activeTranscript.messageSelector);
    return Boolean(turn && inferRole(turn) === 'assistant');
  });

  if (boundaryHit) {
    return true;
  }

  // A drag from one user turn, through an assistant answer, into the next user turn has
  // no assistant message at either boundary — but it is exactly the selection this
  // feature is for, so look inside the range before giving up.
  const container = range.commonAncestorContainer;
  const scope = container instanceof Element ? container : container.parentElement;
  if (!scope) {
    return false;
  }

  return Array.from(scope.querySelectorAll<HTMLElement>(activeTranscript.messageSelector)).some((element) => {
    if (inferRole(element) !== 'assistant') {
      return false;
    }

    try {
      return range.intersectsNode(element);
    } catch {
      return false;
    }
  });
}

export function countTranscriptTurns(root: ParentNode = document): number {
  return uniqueMessageElements(root).length;
}

export function getRecentAssistantTexts(limit = 3, root: ParentNode = document): string[] {
  return uniqueMessageElements(root)
    .filter((element) => inferRole(element) === 'assistant')
    .slice(-Math.max(1, limit))
    .map((element) => getMessageText(element, 'assistant'))
    .filter(Boolean)
    .reverse();
}

export interface DomTranscriptTurn extends TranscriptTurn {
  element: HTMLElement;
}

export interface SelectionDraft {
  rootConversationId: string;
  rootChatUrl: string;
  selectedText: string;
  structuredSelectedText: string;
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

      // Nothing writes to a provider-owned element: the id is derived from the
      // element's own content and kept here, not stamped onto the page's DOM.
      const id = createSyntheticMessageId(role, turnIndex, text);

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

const QUOTE_CONTEXT_CHARS = 40;

function getBoundaryScope(container: Node): Element | null {
  const element = container instanceof Element ? container : container.parentElement;
  return element?.closest(activeTranscript.messageSelector) ?? element;
}

// Range offsets are character offsets only when the boundary container is a text node.
// Chrome routinely hands back an Element container for selections that end on a block
// boundary, where the offset is a child-node index; slicing textContent by it produced
// nonsense prefixes and suffixes that then mis-scored re-anchoring.
function getBoundaryContext(range: Range, side: 'before' | 'after'): string {
  const scope = getBoundaryScope(side === 'before' ? range.startContainer : range.endContainer);
  if (!scope) {
    return '';
  }

  try {
    const contextRange = document.createRange();
    if (side === 'before') {
      contextRange.setStart(scope, 0);
      contextRange.setEnd(range.startContainer, range.startOffset);
    } else {
      contextRange.setStart(range.endContainer, range.endOffset);
      contextRange.setEnd(scope, scope.childNodes.length);
    }

    const text = compactWhitespace(contextRange.toString());
    return side === 'before' ? text.slice(-QUOTE_CONTEXT_CHARS) : text.slice(0, QUOTE_CONTEXT_CHARS);
  } catch {
    return '';
  }
}

function getQuoteContext(range: Range): RangeQuotes {
  return {
    exact: extractCleanRangeText(range),
    prefix: getBoundaryContext(range, 'before'),
    suffix: getBoundaryContext(range, 'after')
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
  const { rootConversationId, rootChatUrl } = activeScopeResolver();
  return {
    rootConversationId,
    rootChatUrl,
    selectedText,
    structuredSelectedText: extractStructuredRangeText(range),
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
    structuredText: extractStructuredNodeText(element),
    excerpt: text.slice(0, 160)
  };
}

/** The user turn immediately before a given turn, when there is one. */
function findPrecedingQuestion(turnIndex: number): SelectedBlock | null {
  const elements = uniqueMessageElements(document);
  for (let index = turnIndex - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (!element) {
      continue;
    }
    if (inferRole(element) === 'user') {
      return buildSelectedBlockFromElement(element, index);
    }
  }
  return null;
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
    structuredSelectedText: draft.structuredSelectedText,
    precedingQuestion: findPrecedingQuestion(anchorAssistant.turnIndex) ?? undefined,
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

  if (parent.closest(activeTranscript.nonContentSelector)) {
    return true;
  }

  if (parent.closest('[hidden],[aria-busy="true"]')) {
    return true;
  }

  return false;
}

// extractCleanNodeText deletes these subtrees before it injects separators, so nothing
// inside one may contribute a boundary to the index either.
function strippedSubtreeSelector(): string {
  return `${activeTranscript.nonContentSelector},[hidden],[aria-busy="true"]`;
}

function isStrippedElement(node: Node): node is Element {
  return node instanceof Element && node.matches(strippedSubtreeSelector());
}

function isTextSeparatingElement(node: Node): boolean {
  if (!(node instanceof Element)) {
    return false;
  }

  return node.tagName === 'BR' || node.matches(BLOCK_LEVEL_SELECTORS);
}

function buildNormalizedTextIndex(element: HTMLElement): NormalizedTextIndex {
  // extractCleanNodeText writes a separator at every block boundary and in place of every
  // <br>, so this index has to produce the identical string or a passage that spans one of
  // those boundaries can never be re-anchored.
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      // Rejecting the element skips its whole subtree, which is what keeps a hidden
      // <div> from contributing a separator the extracted text does not have.
      return isStrippedElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  let text = '';
  const points: NormalizedTextIndex['points'] = [];
  let pendingWhitespace:
    | {
        node: Text;
        offset: number;
      }
    | null = null;

  let previousBlock: Element | null = null;
  let pendingBoundary = false;

  while (walker.nextNode()) {
    const current = walker.currentNode;

    if (current.nodeType !== Node.TEXT_NODE) {
      // Covers <br> and void blocks like <hr>, which the block-ancestor comparison below
      // cannot see because they are siblings rather than ancestors. Stripped subtrees
      // never reach here: the walker filter rejects them outright.
      pendingBoundary ||= isTextSeparatingElement(current);
      continue;
    }

    const node = current as Text;
    if (shouldIgnoreTextNode(node)) {
      continue;
    }

    const block = node.parentElement?.closest(BLOCK_LEVEL_SELECTORS) ?? null;
    if (text.length && (pendingBoundary || block !== previousBlock)) {
      pendingWhitespace ??= { node, offset: 0 };
    }
    pendingBoundary = false;
    previousBlock = block;

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

  // Identity first: the synthetic message id hashes the turn's own text, so it only
  // matches the message the passage actually came from.
  for (const block of candidates) {
    const turn = transcript.find((item) => item.id === block.messageId);
    if (turn?.element) {
      return turn.element;
    }
  }

  // Then content: the conversation may have grown or been edited, which shifts turn
  // indexes but leaves the quoted passage where it was. A branch always anchors to an
  // assistant answer, and the user's own question usually quotes the same phrase, so
  // assistant turns are searched first.
  const anchorRoles = new Set(anchor.selectedBlocks.map((block) => block.role));
  const quoted =
    transcript.find((turn) => turn.role === 'assistant' && turn.text.includes(anchor.selectedText)) ??
    transcript.find((turn) => anchorRoles.has(turn.role) && turn.text.includes(anchor.selectedText));
  if (quoted?.element) {
    return quoted.element;
  }

  // Positional guess last, and only when the role still agrees, so a turn index that
  // now points at a different message does not win over a real text match.
  for (const block of candidates) {
    const turn = transcript.find(
      (item) => item.turnIndex === block.turnIndex && item.role === block.role
    );
    if (turn?.element) {
      return turn.element;
    }
  }

  return null;
}

export function getLatestAssistantText(root: ParentNode = document): string {
  const transcript = extractTranscript(root).filter((turn) => turn.role === 'assistant');
  return transcript.at(-1)?.text ?? '';
}
