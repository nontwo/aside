/**
 * Canonical origins for each provider.
 *
 * Kept in its own module so the service worker can validate tab hostnames without
 * pulling both full adapters (and every selector table) into the worker bundle,
 * while still having exactly one source of truth.
 */
export const CHATGPT_ORIGINS = ['https://chatgpt.com', 'https://chat.openai.com'] as const;
export const CLAUDE_ORIGINS = ['https://claude.ai'] as const;

export const ALL_PROVIDER_ORIGINS: readonly string[] = [...CHATGPT_ORIGINS, ...CLAUDE_ORIGINS];

export function providerHostnames(): Set<string> {
  return new Set(ALL_PROVIDER_ORIGINS.map((origin) => new URL(origin).hostname));
}
