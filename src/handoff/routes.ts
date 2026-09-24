/**
 * Where a native handoff goes, per provider, and what the Owner is told to check
 * there. One small typed descriptor: nothing here is an API, and nothing here is
 * evidence that a mode is on — the native page owns that, and the Owner confirms
 * it before pasting.
 *
 * No route ever carries source text, a question, a source URL or title, or any
 * identifier derived from them.
 */

import type { ProviderId } from '../domain/types';

export type RouteCategory = 'convenience' | 'base';

export interface HandoffRoute {
  providerId: ProviderId;
  /** The provider's own product name. */
  label: string;
  /** The provider's own name for its temporary conversation mode. */
  modeLabel: string;
  /**
   * A native entry that may pre-select the temporary mode. Observed, not
   * versioned: it can land on sign-in, an ordinary chat or a choice screen, and
   * none of those is success evidence. Null when no such entry is established.
   */
  convenienceUrl: string | null;
  /** The plain native new-chat page. Always usable; the Owner selects the mode. */
  baseUrl: string;
  /** Hosts a target of this provider may legitimately be on. */
  hosts: string[];
  /** What to do in the native page, in order. Short. */
  steps: string[];
  /** What the mode does and does not do, per the provider's own help. Short. */
  notes: string[];
}

const CHATGPT: HandoffRoute = {
  providerId: 'chatgpt',
  label: 'ChatGPT',
  modeLabel: 'Temporary Chat',
  convenienceUrl: 'https://chatgpt.com/?temporary-chat=true',
  baseUrl: 'https://chatgpt.com/',
  hosts: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com'],
  steps: [
    'Check that Temporary is selected at the top of the new chat. If it is not, select it.',
    'If ChatGPT asks, choose Unpersonalized for an answer that does not use your memory or custom instructions (Personalized also keeps the chat out of memory).',
    'Pick a model there if you want, paste, and send. Ask follow-ups in the same ChatGPT chat.'
  ],
  notes: [
    'A temporary chat is not saved to your history and does not create or update memories.',
    'Saving the chat in ChatGPT turns it into an ordinary chat.',
    'OpenAI may keep a safety copy for up to 30 days.'
  ]
};

const CLAUDE: HandoffRoute = {
  providerId: 'claude',
  label: 'Claude',
  modeLabel: 'Incognito chat',
  // An incognito query shortcut has not been established against a signed-in
  // page, so the base page is the release route.
  convenienceUrl: null,
  baseUrl: 'https://claude.ai/new',
  hosts: ['claude.ai'],
  steps: [
    'In the new chat (outside any Project), click the ghost icon at the upper right to start an Incognito chat. It shows an "Incognito chat" label when it is on.',
    'Pick a model there if you want, paste, and send. Ask follow-ups in the same Claude chat.'
  ],
  notes: [
    'Incognito chats do not use or add to memory; your profile preferences and styles can still apply.',
    'Claude may open Incognito in its previous chat experience, where file creation and code execution are not available.',
    'Closed Incognito chats cannot be reopened. Anthropic keeps them for 30 days by default, longer under some organization settings.'
  ]
};

const ROUTES: Record<ProviderId, HandoffRoute> = { chatgpt: CHATGPT, claude: CLAUDE };

export function routeFor(providerId: ProviderId): HandoffRoute {
  return ROUTES[providerId];
}

/** The URL to open, and which kind of entry it is. */
export function launchFor(providerId: ProviderId, category: RouteCategory = 'convenience'): {
  url: string;
  category: RouteCategory;
} {
  const route = routeFor(providerId);
  if (category === 'convenience' && route.convenienceUrl) {
    return { url: route.convenienceUrl, category: 'convenience' };
  }
  return { url: route.baseUrl, category: 'base' };
}

/** True when a URL is on one of the provider's own hosts (https only). */
export function isProviderUrl(providerId: ProviderId, url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && routeFor(providerId).hosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The one instruction shown with every handoff. A human safeguard, not a
 * technical guarantee: Aside cannot stop a paste into an ordinary chat.
 */
export const NATIVE_HANDOFF_INSTRUCTION =
  'Confirm the temporary mode in the native page before pasting. Then paste and send there. Aside does not automatically submit or save the reply.';

/** Default Why wording. Fixed text in the UI language; never generated. */
export const WHY_QUESTION =
  'Why does this step hold? Explain the reasoning and state any necessary assumptions.';
