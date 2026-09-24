import type { ChatRole } from '../types';
import { compactWhitespace } from '../utils';
import { CHATGPT_ORIGINS } from './origins';
import type { ConversationIdentity, ProviderAdapter } from './types';

const ORIGINS: string[] = [...CHATGPT_ORIGINS];

const MESSAGE_SELECTOR = [
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

const STRUCTURED_CONTENT_SELECTOR = [
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

const NON_CONTENT_SELECTOR = [
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

const CONVERSATION_PATH = /\/c\/([^/?#]+)/;
const PROJECT_PATH = /^\/g\/(g-p-[^/]+)/;

/** Non-chat routes that share the origin and must not host Aside UI. */
const NON_CHAT_PATHS = [/^\/auth\//, /^\/api\//, /^\/pricing/, /^\/policies/, /^\/share\/[^/]+\/continue/];

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) {
    return url;
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}

function isConversationUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return Boolean(parsed && CONVERSATION_PATH.test(parsed.pathname));
}

function identify(url: string, sessionDiscriminator: string): ConversationIdentity {
  const parsed = parseUrl(url);
  if (!parsed) {
    return {
      providerId: 'chatgpt',
      conversationId: null,
      containerId: null,
      conversationUrl: null,
      launchUrl: `${ORIGINS[0]}/`,
      containerUrl: null,
      rootLaunchUrl: `${ORIGINS[0]}/`,
      urlPrivacyHint: 'unknown',
      scopeKey: `chatgpt:session:${sessionDiscriminator}`
    };
  }

  const conversationId = parsed.pathname.match(CONVERSATION_PATH)?.[1] ?? null;
  const projectId = parsed.pathname.match(PROJECT_PATH)?.[1] ?? null;
  const origin = parsed.origin;

  const containerUrl = projectId ? `${origin}/g/${projectId}` : null;
  // Projects launch a new chat from their /project route; everything else from root.
  const launchUrl = containerUrl ? `${containerUrl}/project` : `${origin}/`;
  const rootLaunchUrl = `${origin}/`;

  // ChatGPT marks a temporary chat with a query parameter. It is a hint only:
  // the parameter can be absent on a temporary chat opened by other means, and
  // present on a URL the user has since converted.
  const temporaryParam = parsed.searchParams.get('temporary-chat');
  const urlPrivacyHint =
    temporaryParam === 'true' ? 'private' : conversationId ? 'persistent' : 'unknown';

  const scopeKey = conversationId
    ? `chatgpt:c:${conversationId}`
    : projectId
      ? `chatgpt:project:${projectId}:${sessionDiscriminator}`
      : `chatgpt:session:${sessionDiscriminator}`;

  return {
    providerId: 'chatgpt',
    conversationId,
    containerId: projectId,
    conversationUrl: conversationId ? normalizeUrl(url) : null,
    launchUrl,
    rootLaunchUrl,
    containerUrl,
    urlPrivacyHint,
    scopeKey
  };
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

function stripAssistantLabel(text: string): string {
  let next = compactWhitespace(text);
  for (const pattern of ASSISTANT_LABEL_PATTERNS) {
    next = next.replace(pattern, '').trim();
  }
  return next;
}

function isStatusText(text: string): boolean {
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

export const chatgptAdapter: ProviderAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  origins: ORIGINS,

  matches(url) {
    const parsed = parseUrl(url);
    return Boolean(parsed && ORIGINS.includes(parsed.origin));
  },

  isChatSurface(url) {
    const parsed = parseUrl(url);
    if (!parsed || !ORIGINS.includes(parsed.origin)) {
      return false;
    }
    return !NON_CHAT_PATHS.some((pattern) => pattern.test(parsed.pathname));
  },

  identify,
  normalizeUrl,
  isConversationUrl,

  transcript: {
    messageSelector: MESSAGE_SELECTOR,
    contentSelectors: CONTENT_SELECTORS,
    structuredContentSelector: STRUCTURED_CONTENT_SELECTOR,
    nonContentSelector: NON_CONTENT_SELECTOR,
    inferRole,
    stripAssistantLabel,
    isStatusText
  },

  layout: {
    // UNVERIFIED against the live site. These are a best-effort first pass, and on
    // 2026-09-22 a live run showed they do not match ChatGPT's real selection popup
    // (the "Ask ChatGPT / Share highlighted" pill), which is how Aside came to be
    // painted underneath it.
    //
    // They are deliberately NOT widened by guessing. A selector that over-matches
    // reserves a band the size of the reading column and collapses Aside to the
    // compact launcher for no reason, which is worse than missing: the real
    // guarantee is the paint-order recheck in root.ts (findOccludingRects), which
    // needs no knowledge of this markup at all. Narrow these further, or replace
    // them, only with evidence from a live page.
    nativeSelectionToolbarSelectors: [
      '[data-testid="selection-toolbar"]',
      '[class*="selection-tooltip"]',
      '[role="toolbar"]'
    ],
    reservedRegionSelectors: [
      { kind: 'sidebar', selector: 'nav[aria-label], #stage-slideover-sidebar, [data-testid="sidebar"]' },
      { kind: 'composer', selector: 'form[data-type="unified-composer"], #composer-background, main form' },
      { kind: 'header', selector: 'main header, #page-header' },
      { kind: 'tool-panel', selector: '[data-testid="canvas-panel"], [class*="canvas"]' }
    ],
    getConversationScrollContainer(doc) {
      const candidates = [
        doc.querySelector<HTMLElement>('main [class*="react-scroll-to-bottom"]'),
        doc.querySelector<HTMLElement>('main .overflow-y-auto'),
        doc.querySelector<HTMLElement>('main')
      ];
      return candidates.find((element) => Boolean(element)) ?? null;
    },
    getReadingColumnRect(doc) {
      // The reading column is where turns and the composer live — not <main>, which
      // also spans the gutter the rail needs. Returning null is better than a wrong
      // rectangle: the caller then falls back to the viewport midpoint.
      const column =
        doc.querySelector<HTMLElement>('article[data-message-author-role]') ??
        doc.querySelector<HTMLElement>('form[data-type="unified-composer"], main form');
      if (!column) {
        return null;
      }
      const rect = column.getBoundingClientRect();
      return rect.width > 0 ? rect : null;
    }
  },

  // The provider's own name for its temporary conversation mode. Aside names it
  // in the handoff guidance; it never operates the mode itself.
  privacy: {
    label: 'Temporary Chat'
  }
};
