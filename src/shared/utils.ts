import type { ChatRole } from './types';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function createSyntheticMessageId(role: ChatRole, turnIndex: number, text: string): string {
  return `${role}:${turnIndex}:${hashString(text.slice(0, 240))}`;
}

export function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

export function parseConversationIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/c\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getRootConversationId(url: string): string {
  return parseConversationIdFromUrl(url) ?? 'chat-home';
}

export function normalizeChatUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function getChatContainerBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const conversationIndex = parsed.pathname.indexOf('/c/');
    parsed.hash = '';
    parsed.search = '';

    if (conversationIndex >= 0) {
      const prefix = parsed.pathname.slice(0, conversationIndex);
      parsed.pathname = prefix || '/';
      return parsed.toString();
    }

    return parsed.toString();
  } catch {
    return 'https://chatgpt.com/';
  }
}

export function getChatContainerLaunchUrl(url: string): string {
  try {
    const baseUrl = new URL(getChatContainerBaseUrl(url));
    if (/^\/g\/g-p-[^/]+$/.test(baseUrl.pathname)) {
      baseUrl.pathname = `${baseUrl.pathname}/project`;
    }
    return baseUrl.toString();
  } catch {
    return 'https://chatgpt.com/';
  }
}

export function getProjectContainerUrl(url: string): string | undefined {
  try {
    const baseUrl = new URL(getChatContainerBaseUrl(url));
    return /^\/g\/g-p-[^/]+$/.test(baseUrl.pathname) ? baseUrl.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function isSameChatContainer(leftUrl: string, rightUrl: string): boolean {
  return getChatContainerBaseUrl(leftUrl) === getChatContainerBaseUrl(rightUrl);
}

export function getBranchLaunchUrl(url: string): string {
  return getChatContainerLaunchUrl(url);
}

export function sortByCreatedAt<T extends { createdAt: number }>(values: T[]): T[] {
  return [...values].sort((left, right) => left.createdAt - right.createdAt);
}

export function safeLower(value: string): string {
  return value.toLowerCase();
}
