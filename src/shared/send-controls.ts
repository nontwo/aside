import { chatgptAdapter } from './providers/chatgpt';
import type { ComposerAdapter } from './providers/types';
import { compactWhitespace } from './utils';

/**
 * Privacy-control vocabulary is provider-specific ("Temporary Chat" vs "Incognito
 * chat"), so it comes from the active adapter rather than a shared word list.
 */
let activeComposerAdapter: ComposerAdapter = chatgptAdapter.composer;

export function setActiveComposerAdapter(adapter: ComposerAdapter): void {
  activeComposerAdapter = adapter;
}

export type TemporaryChatState = 'active' | 'inactive' | 'unknown';

export interface SendCandidateProfile {
  label: string;
  explicitSend: boolean;
  negative: boolean;
  temporaryChat: boolean;
  submitLike: boolean;
  sameForm: boolean;
}

export function getActionLabel(element: HTMLElement): string {
  return compactWhitespace(
    [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-testid'),
      element.innerText,
      element.textContent
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export function hasExplicitSendSemantics(candidate: HTMLElement): boolean {
  const label = getActionLabel(candidate).toLowerCase();
  return (
    candidate.getAttribute('data-testid') === 'send-button' ||
    /(?:^|[\s_-])(send|submit)(?:$|[\s_-])|发送|提交/.test(label)
  );
}

export function hasNegativeSendSemantics(candidate: HTMLElement): boolean {
  const label = getActionLabel(candidate).toLowerCase();
  if (activeComposerAdapter.privacyControlLabelPattern.test(label)) {
    return true;
  }
  return /group|voice|audio|upload|attach|search|share|sidebar|project|model|群聊|语音|听写|上传|附件|搜索|分享|边栏|项目|模型/.test(
    label
  );
}

export function isTemporaryChatControl(candidate: HTMLElement): boolean {
  return activeComposerAdapter.privacyControlLabelPattern.test(getActionLabel(candidate));
}

export function isSubmitLikeControl(candidate: HTMLElement): boolean {
  if (candidate.getAttribute('data-testid') === 'send-button') {
    return true;
  }

  if (candidate instanceof HTMLButtonElement) {
    return candidate.type === 'submit';
  }

  if (candidate instanceof HTMLInputElement) {
    return candidate.type === 'submit' || candidate.type === 'image';
  }

  return false;
}

const ACTIVE_STATE_VALUES = new Set(['true', 'active', 'is-active', 'checked', 'selected', 'enabled', 'on']);
const INACTIVE_STATE_VALUES = new Set([
  'false',
  'inactive',
  'is-inactive',
  'unchecked',
  'unselected',
  'disabled',
  'off'
]);

/**
 * This decides whether a branch is about to be written into the user's permanent chat
 * history, so it only trusts signals that actually mean "this toggle is on".
 *
 * The `class` attribute used to be part of the evidence, which made Tailwind variant
 * classes such as `open:bg-white` or `enabled:hover:bg-token-surface` read as ON while
 * temporary chat was OFF. Explicit ARIA state comes first, then the control's own label
 * (which ChatGPT flips between "turn on"/"turn off"), then narrower data-* state hints.
 */
export function inferTemporaryChatState(candidate: HTMLElement): TemporaryChatState {
  const ariaPressed = candidate.getAttribute('aria-pressed');
  const ariaChecked = candidate.getAttribute('aria-checked');

  if (ariaPressed === 'true' || ariaChecked === 'true') {
    return 'active';
  }

  if (ariaPressed === 'false' || ariaChecked === 'false') {
    return 'inactive';
  }

  const label = getActionLabel(candidate);
  if (activeComposerAdapter.privacyInactiveLabelPattern.test(label)) {
    return 'inactive';
  }

  if (activeComposerAdapter.privacyActiveLabelPattern.test(label)) {
    return 'active';
  }

  // Each attribute is judged on its own: joining them and matching the whole string means
  // a control that exposes two state attributes never matches anything.
  const stateAttributes = ['data-state', 'data-status', 'data-selected', 'data-active', 'aria-current']
    .map((name) => compactWhitespace(candidate.getAttribute(name) ?? '').toLowerCase())
    .filter(Boolean);

  if (stateAttributes.some((value) => ACTIVE_STATE_VALUES.has(value))) {
    return 'active';
  }

  if (stateAttributes.some((value) => INACTIVE_STATE_VALUES.has(value))) {
    return 'inactive';
  }

  // Class tokens are the weakest evidence, so only an exact token counts. Tailwind
  // variants all contain ':' ("disabled:opacity-50", "open:bg-white") and are skipped,
  // which is what used to make almost every ChatGPT button look like a settled toggle.
  const classTokens = (candidate.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((token) => token && !token.includes(':'))
    .map((token) => token.toLowerCase());

  if (classTokens.some((token) => ACTIVE_STATE_VALUES.has(token))) {
    return 'active';
  }

  if (classTokens.some((token) => INACTIVE_STATE_VALUES.has(token))) {
    return 'inactive';
  }

  return 'unknown';
}

export function getSendCandidateProfile(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null
): SendCandidateProfile {
  const sameForm = Boolean(composer?.closest('form') && candidate.closest('form') === composer.closest('form'));

  return {
    label: getActionLabel(candidate),
    explicitSend: hasExplicitSendSemantics(candidate),
    negative: hasNegativeSendSemantics(candidate),
    temporaryChat: isTemporaryChatControl(candidate),
    submitLike: isSubmitLikeControl(candidate),
    sameForm
  };
}

export function isAcceptableSendControl(profile: SendCandidateProfile): boolean {
  if (profile.negative || profile.temporaryChat) {
    return false;
  }

  return profile.explicitSend || profile.submitLike;
}
