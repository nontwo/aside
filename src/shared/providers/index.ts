import { chatgptAdapter } from './chatgpt';
import { claudeAdapter } from './claude';
import type { ProviderAdapter, ProviderId } from './types';

export * from './types';
export * from './origins';
export { chatgptAdapter } from './chatgpt';
export { claudeAdapter } from './claude';

export const PROVIDER_ADAPTERS: ProviderAdapter[] = [chatgptAdapter, claudeAdapter];

export function getAdapter(providerId: ProviderId): ProviderAdapter {
  const adapter = PROVIDER_ADAPTERS.find((candidate) => candidate.id === providerId);
  if (!adapter) {
    throw new Error(`Unknown Aside provider: ${providerId}`);
  }
  return adapter;
}

/**
 * Resolve the adapter that owns a URL, or null when Aside should not run there.
 * A selection never crosses providers: the adapter that owns the page the user
 * selected in is the adapter that runs the branch.
 */
export function findAdapterForUrl(url: string): ProviderAdapter | null {
  return PROVIDER_ADAPTERS.find((adapter) => adapter.matches(url)) ?? null;
}

export function findChatAdapterForUrl(url: string): ProviderAdapter | null {
  const adapter = findAdapterForUrl(url);
  return adapter?.isChatSurface(url) ? adapter : null;
}

/** All content-script match patterns, kept in step with public/manifest.json. */
export function allOriginMatchPatterns(): string[] {
  return PROVIDER_ADAPTERS.flatMap((adapter) => adapter.origins.map((origin) => `${origin}/*`));
}
