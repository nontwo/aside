import type { ChatRole } from '../types';

export type ProviderId = 'chatgpt' | 'claude';

/**
 * How confident Aside is that a capability works on a provider.
 *
 * - `verified`     the adapter can positively observe the capability in the live DOM
 * - `fixture-only` implemented and exercised against local fixtures, but never
 *                  confirmed against a live logged-in account. Offered, because
 *                  refusing to offer it would be worse, but not claimed as proven
 * - `unverified`   the control exists in provider documentation but Aside could not
 *                  confirm it on this page/account, so the capability is not offered
 * - `unsupported`  the provider does not expose it at all in a way Aside can drive
 */
export type CapabilitySupport = 'verified' | 'fixture-only' | 'unverified' | 'unsupported';

/** Support levels under which Aside will attempt a surface. */
export function surfaceIsAvailable(support: CapabilitySupport): boolean {
  return support === 'verified' || support === 'fixture-only';
}

export type PrivacyMode = 'persistent' | 'private';

/** What the DOM says about the provider's private-mode control right now. */
export type PrivacyControlState = 'active' | 'inactive' | 'unknown' | 'missing';

export interface PrivacyCapabilityReport {
  /** The provider's own name for the mode, shown in the UI. */
  label: string;
  support: CapabilitySupport;
  state: PrivacyControlState;
  /** Why the support level is what it is; surfaced to the user verbatim. */
  detail: string;
  /** True when entering private mode leaves the current project/container. */
  leavesContainer: boolean;
}

/**
 * Identity of the page Aside is looking at.
 *
 * `conversationId` is null while the provider has not yet minted an addressable
 * conversation. Callers must scope by `scopeKey`, never by conversationId alone,
 * because every non-conversation page would otherwise collapse into one bucket.
 */
export interface ConversationIdentity {
  providerId: ProviderId;
  conversationId: string | null;
  /** Project / workspace container when one is observable from the URL. */
  containerId: string | null;
  /** Canonical, query-free URL of the conversation when addressable. */
  conversationUrl: string | null;
  /** URL that opens a NEW conversation in the same container. */
  launchUrl: string;
  /** Container (project) home URL, when the page is inside one. */
  containerUrl: string | null;
  /**
   * What the URL alone suggests about privacy. Never sufficient on its own:
   * the absence of a conversation URL does not prove private mode, and its
   * presence does not prove persistence.
   */
  urlPrivacyHint: PrivacyMode | 'unknown';
  /**
   * Stable key for panel/anchor scoping. Includes the provider and, when the
   * conversation is not addressable, a session-scoped discriminator so a
   * new chat, a project home and a shared link never share one bucket.
   */
  scopeKey: string;
}

export interface TranscriptAdapter {
  /** Elements that may be a conversation turn. */
  messageSelector: string;
  /** Preferred containers for a turn's rendered answer body. */
  contentSelectors: string[];
  /** Selector marking structurally meaningful content (prefers real markdown). */
  structuredContentSelector: string;
  /** Subtrees removed before text extraction (controls, assistive math, icons). */
  nonContentSelector: string;
  /** Resolve a turn element to a role, or null when it is not a turn. */
  inferRole(element: HTMLElement): ChatRole | null;
  /** Remove a provider-specific speaker prefix ("ChatGPT said:"). */
  stripAssistantLabel(text: string): string;
  /** True when the text is a thinking/searching status rather than an answer. */
  isStatusText(text: string): boolean;
}

/**
 * Rectangles Aside must not cover: the provider's own selection toolbar, the
 * composer, the sidebar, and any tool/artifact pane.
 */
export interface ReservedRegion {
  /** Diagnostic name, e.g. 'sidebar' | 'composer' | 'selection-toolbar'. */
  kind: string;
  rect: DOMRect;
}

export interface LayoutAdapter {
  /**
   * Selectors for the provider's own selection toolbar. Used only for
   * measurement and collision avoidance — never to hide or restyle it.
   */
  nativeSelectionToolbarSelectors: string[];
  /** Selectors for persistent chrome that Aside must stay clear of. */
  reservedRegionSelectors: Array<{ kind: string; selector: string }>;
  /** The element that scrolls the conversation, when it is not the document. */
  getConversationScrollContainer(doc: Document): HTMLElement | null;
  /** Bounds of the reading column, used to find safe left-side whitespace. */
  getReadingColumnRect(doc: Document): DOMRect | null;
}

export interface ComposerAdapter {
  /** Candidate selectors for the prompt input, best first. */
  composerSelectors: string[];
  /** Candidate selectors for the submit control. */
  sendButtonSelectors: string[];
  /** Selectors for the stop/generating indicator. */
  stopButtonSelectors: string[];
  /** Selectors for the private-mode control (temporary chat / incognito). */
  privacyControlSelectors: string[];
  /** Labels that positively identify the private-mode control. */
  privacyControlLabelPattern: RegExp;
  /** Label patterns that mean "private mode is currently OFF". */
  privacyInactiveLabelPattern: RegExp;
  /** Label patterns that mean "private mode is currently ON". */
  privacyActiveLabelPattern: RegExp;
}

export interface SurfaceSupport {
  /** Whether the provider can be driven inside an in-page iframe. */
  embedded: CapabilitySupport;
  /** Whether Aside can drive a provider tab/window it opened. */
  nativeWindow: CapabilitySupport;
  /** Human-readable reason shown when a surface is not available. */
  detail: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** Display name used in the UI. */
  label: string;
  /** Origins this adapter owns. Must match the manifest exactly. */
  origins: string[];
  /** True when the adapter should run on this URL. */
  matches(url: string): boolean;
  /** True when the URL is a chat surface rather than marketing/docs/settings. */
  isChatSurface(url: string): boolean;

  identify(url: string, sessionDiscriminator: string): ConversationIdentity;
  /** Canonical, query-free form used for comparison and storage. */
  normalizeUrl(url: string): string;
  /** True when the URL addresses a persisted conversation. */
  isConversationUrl(url: string): boolean;

  transcript: TranscriptAdapter;
  layout: LayoutAdapter;
  composer: ComposerAdapter;
  surfaces: SurfaceSupport;

  /** Static description of the provider's private mode. */
  privacy: {
    label: string;
    /** Documented constraints shown to the user before a private branch runs. */
    constraints: string[];
    leavesContainer: boolean;
  };
}
