import type { ChatRole } from '../types';
import { compactWhitespace } from '../utils';
import { CLAUDE_ORIGINS } from './origins';
import type { ConversationIdentity, ProviderAdapter } from './types';

/**
 * Claude adapter.
 *
 * SELECTOR PROVENANCE — read before editing.
 *
 * Every selector here is a *candidate*, ordered so that stable, semantic hooks
 * (data-testid, aria-label, role) are tried before class-name heuristics. Claude's
 * interface is mid-migration: the Cowork/new-chat experience and the previous
 * experience can both be served depending on account rollout, and Incognito is
 * documented as living in the previous experience. Aside therefore never assumes a
 * single captured DOM, re-detects after navigation and remount, and reports a
 * capability as unavailable rather than guessing.
 *
 * These selectors are exercised against sanitized fixtures in the offline smoke
 * harness. They have NOT been verified against a live logged-in Claude account in
 * this change; see the capability matrix in the pull request.
 */

const ORIGINS: string[] = [...CLAUDE_ORIGINS];

// Claude marks user turns with a test id and renders assistant turns in a
// font-claude-message container. Both forms are matched, plus the generic
// data-testid message hooks, so a rollout that changes one does not break both.
const MESSAGE_SELECTOR = [
  '[data-testid="user-message"]',
  '[data-testid="assistant-message"]',
  '[data-test-render-count] .font-claude-message',
  '.font-claude-message',
  '[data-is-streaming]'
].join(',');

const CONTENT_SELECTORS = [
  '.standard-markdown',
  '[class*="standard-markdown"]',
  '.font-claude-message',
  '[class*="prose"]',
  '.whitespace-pre-wrap'
];

const STRUCTURED_CONTENT_SELECTOR = [
  '.standard-markdown',
  '[class*="standard-markdown"]',
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
  // Claude renders artifacts and tool output in their own panes; their text is not
  // part of the answer the user selected.
  '[data-testid="artifact-panel"]',
  '[class*="artifact-block-cell"]',
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
  /^claude\s*(says?|said)?\s*[:：]\s*/i,
  /^claude\s*说\s*[:：]\s*/i,
  /^assistant\s*[:：]\s*/i
];

const ASSISTANT_STATUS_PATTERNS = [
  /^thinking(?:\.\.\.|…)?$/i,
  /^思考中(?:\.\.\.|…)?$/i,
  /^pondering(?:\.\.\.|…)?$/i,
  /^analy[sz]ing(?:\.\.\.|…)?$/i,
  /^分析中(?:\.\.\.|…)?$/i,
  /^searching(?:\s+the\s+web)?(?:\.\.\.|…)?$/i,
  /^正在搜索(?:网络|网页)?(?:\.\.\.|…)?$/i,
  /^researching(?:\.\.\.|…)?$/i,
  /^thought for\s*\d+\s*s(?:econds?)?$/i,
  /^已思考\s*\d+\s*[秒s]?$/i
];

const CONVERSATION_PATH = /^\/chat\/([^/?#]+)/;
const PROJECT_PATH = /^\/project\/([^/?#]+)/;

/**
 * Routes on claude.ai that are not a chat surface. Aside must not mount on the
 * marketing site, the auth flow, or settings.
 */
const NON_CHAT_PATHS = [
  /^\/login/,
  /^\/magic-link/,
  /^\/settings/,
  /^\/api\//,
  /^\/admin/,
  /^\/referral/,
  /^\/upgrade/,
  /^\/pricing/
];

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
      providerId: 'claude',
      conversationId: null,
      containerId: null,
      conversationUrl: null,
      launchUrl: `${ORIGINS[0]}/new`,
      rootLaunchUrl: `${ORIGINS[0]}/new`,
      containerUrl: null,
      urlPrivacyHint: 'unknown',
      scopeKey: `claude:session:${sessionDiscriminator}`
    };
  }

  const conversationId = parsed.pathname.match(CONVERSATION_PATH)?.[1] ?? null;
  const projectId = parsed.pathname.match(PROJECT_PATH)?.[1] ?? null;
  const origin = parsed.origin;

  const containerUrl = projectId ? `${origin}/project/${projectId}` : null;
  // A new chat inside a project starts from the project page; otherwise /new.
  const launchUrl = containerUrl ?? `${origin}/new`;
  const rootLaunchUrl = `${origin}/new`;

  // Claude does not expose a documented incognito query parameter, so the URL tells
  // us nothing about privacy either way. Saying 'unknown' keeps callers from
  // treating an addressable /chat/<id> URL as proof of persistence.
  const urlPrivacyHint = 'unknown';

  const scopeKey = conversationId
    ? `claude:chat:${conversationId}`
    : projectId
      ? `claude:project:${projectId}:${sessionDiscriminator}`
      : `claude:session:${sessionDiscriminator}`;

  return {
    providerId: 'claude',
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
  const testId = element.getAttribute('data-testid');
  if (testId === 'user-message') {
    return 'user';
  }
  if (testId === 'assistant-message') {
    return 'assistant';
  }

  if (element.classList.contains('font-claude-message')) {
    return 'assistant';
  }

  // Streaming assistant turns carry data-is-streaming on their container.
  if (element.hasAttribute('data-is-streaming')) {
    return 'assistant';
  }

  // Fall back to a nested hook so a wrapper element still resolves.
  if (element.querySelector('[data-testid="user-message"]')) {
    return 'user';
  }
  if (
    element.querySelector('[data-testid="assistant-message"]') ??
    element.querySelector('.font-claude-message')
  ) {
    return 'assistant';
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
    /(thinking|pondering|analy[sz]ing|searching|researching|thought for|思考中|分析中|正在搜索)/i.test(
      normalized
    ) &&
    !/[。.!?]/.test(normalized)
  ) {
    return true;
  }

  return ASSISTANT_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  label: 'Claude',
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
    nativeSelectionToolbarSelectors: [
      '[data-testid="selection-toolbar"]',
      '[role="toolbar"]',
      '[class*="selection-menu"]'
    ],
    reservedRegionSelectors: [
      { kind: 'sidebar', selector: 'nav[aria-label], [data-testid="menu-sidebar"], aside' },
      { kind: 'composer', selector: 'fieldset div[contenteditable="true"], form' },
      { kind: 'header', selector: 'header' },
      {
        kind: 'tool-panel',
        // Artifact / file preview panes occupy the right side and must stay clear.
        selector: '[data-testid="artifact-panel"], [class*="artifact"], [data-testid="file-preview"]'
      }
    ],
    getConversationScrollContainer(doc) {
      const candidates = [
        doc.querySelector<HTMLElement>('[data-testid="chat-scroll-container"]'),
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
        doc.querySelector<HTMLElement>('.font-claude-message') ??
        doc.querySelector<HTMLElement>('fieldset div[contenteditable="true"], main form');
      if (!column) {
        return null;
      }
      const rect = column.getBoundingClientRect();
      return rect.width > 0 ? rect : null;
    }
  },

  composer: {
    composerSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-testid]',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      'button[aria-label="Send message" i]',
      'button[aria-label*="send" i]',
      'button[type="submit"]',
      'button',
      '[role="button"]'
    ],
    stopButtonSelectors: [
      'button[aria-label*="stop" i]',
      'button[aria-label*="停止"]',
      '[data-testid="stop-button"]'
    ],
    privacyControlSelectors: [
      'button[aria-label*="incognito" i]',
      'button[title*="incognito" i]',
      '[role="button"][aria-label*="incognito" i]',
      '[role="button"][title*="incognito" i]',
      '[role="menuitem"][aria-label*="incognito" i]',
      'button[aria-label*="无痕" ]',
      'button[title*="无痕"]'
    ],
    privacyControlLabelPattern: /incognito|无痕/i,
    privacyInactiveLabelPattern:
      /start incognito|new incognito|turn on incognito|enable incognito|incognito off|开启无痕|启用无痕/i,
    privacyActiveLabelPattern:
      /leave incognito|exit incognito|turn off incognito|disable incognito|incognito on|end incognito|关闭无痕|退出无痕/i
  },

  surfaces: {
    // This said 'unsupported', with a comment asserting that claude.ai sends
    // frame-ancestors headers blocking embedding. That was never checked, and the
    // evidence available contradicts it: claude.ai sends `X-Frame-Options:
    // SAMEORIGIN` and no frame-ancestors directive, and Aside's frame is a
    // same-origin child of the claude.ai page, which SAMEORIGIN permits.
    //
    // That evidence is suggestive, not conclusive — it comes from an
    // unauthenticated response — so this is not flipped to "supported" either.
    // It is attempted once, the outcome is observed from the rendered frame, and
    // a refusal falls back to a driven window for the rest of the session.
    // Upgraded from 'unverified' on evidence from a live logged-in account: the
    // frame loaded and completed its handshake at claude.ai/new, logged as
    // "frameRefused": false. It is 'fixture-only' rather than 'verified' because
    // one successful load on one account is not a guarantee for every account or
    // enterprise policy — a refusal is still detected at runtime and falls back.
    embedded: 'fixture-only',
    // Implemented and fixture-exercised, never run against a live Claude account.
    // See the SELECTOR PROVENANCE note at the top of this file.
    nativeWindow: 'fixture-only',
    detail:
      'Aside runs Claude branches in an in-page panel frame, which has been observed to load on a live account. If claude.ai refuses to be framed on yours, the branch falls back to a window Aside controls and stays there for the rest of the session.'
  },

  privacy: {
    label: 'Incognito chat',
    constraints: [
      'Claude documents Incognito as unavailable inside projects. Starting one from a project leaves the project, so its files and instructions do not travel with the branch.',
      'A closed Incognito chat cannot be reopened or converted into regular history, so a minimized Incognito branch is not recoverable after its window closes.',
      'Incognito is documented as part of the previous Claude experience, so the control may be absent on accounts already moved to the newer interface.',
      'Aside can only observe the page. It cannot prove anything about server-side retention.'
    ],
    leavesContainer: true
  }
};
