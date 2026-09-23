/**
 * Observing a provider's private conversation mode — as a typed observation,
 * not a boolean.
 *
 * Three things are kept apart because conflating them is exactly what produced
 * the "could not find the control" dead end:
 *
 *  - capability: whether the mode is offered in this document at all;
 *  - observed mode: what the page currently says the conversation is;
 *  - preparation step: how far the flow has got, and what would move it on.
 *
 * A missing selector is not an entitlement decision. A hidden or zero-size
 * element may sit inside a closed menu. Aside's own UI, a quoted passage that
 * happens to say "Incognito chat", a URL hint or a class substring are never
 * evidence of active privacy; only provider-owned semantic state is.
 */

import type { ComposerAdapter, TranscriptAdapter } from '../shared/providers/types';
import { getActionLabel, inferTemporaryChatState } from '../shared/send-controls';
import type {
  PrivacyAvailability,
  PrivacyControlDescriptor,
  PrivacyEvidenceKind,
  PrivacyNextAction,
  PrivacyObservedMode,
  PrivacyPreparationStep,
  PrivacyRecovery
} from '../shared/types';

export type PrivateAvailability = PrivacyAvailability;
export type ObservedMode = PrivacyObservedMode;
export type PreparationStep = PrivacyPreparationStep;
export type EvidenceKind = PrivacyEvidenceKind;
export type NextAction = PrivacyNextAction;
/** Sanitized: tag, role and state attributes only, never text beyond a short label. */
export type ControlDescriptor = PrivacyControlDescriptor;

export interface PrivacyObservation {
  availability: PrivateAvailability;
  mode: ObservedMode;
  step: PreparationStep;
  evidence: EvidenceKind;
  control: ControlDescriptor | null;
  /** The provider element to act on for `nextAction`, when there is one. */
  actionTarget: HTMLElement | null;
  nextAction: NextAction;
  /** Short, redacted reason for the panel. */
  reason: string;
  observedAt: number;
}

export interface ObserveOptions {
  document: Document;
  composer: ComposerAdapter;
  transcript: TranscriptAdapter;
  /** The composer element, when already acquired: narrows the search scope. */
  composerElement?: HTMLElement | null;
  /** Elements to exclude wholesale — Aside's own host. */
  excludeSelector?: string;
  /** The provider's own name for the mode, for the reason text. */
  label: string;
  now?: number;
}

const DEFAULT_EXCLUDE = '#aside-root';
const CHOOSER_TEXT = /personali[sz]ed|unpersonali[sz]ed|个性化/i;
const LOGIN_TEXT = /log in|sign in|登录|continue with google|continue with apple/i;

function isProviderOwned(element: Element, options: ObserveOptions): boolean {
  if (element.closest(options.excludeSelector ?? DEFAULT_EXCLUDE)) {
    return false;
  }
  // Quoted material inside a message must never satisfy the detector.
  if (element.closest(options.transcript.messageSelector)) {
    return false;
  }
  return true;
}

function isRendered(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) {
    return true;
  }
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.01;
}

function isDisabled(element: HTMLElement): boolean {
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
    if (element.disabled) {
      return true;
    }
  }
  return element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]') !== null;
}

function describeControl(element: HTMLElement): ControlDescriptor {
  const menu = element.closest<HTMLElement>('[role="menu"],[role="listbox"],[data-state]');
  const menuClosed =
    Boolean(menu) &&
    (menu!.getAttribute('data-state') === 'closed' ||
      menu!.getAttribute('aria-hidden') === 'true' ||
      !isRendered(menu!));
  return {
    tag: element.tagName,
    role: element.getAttribute('role'),
    label: getActionLabel(element).slice(0, 40),
    rendered: isRendered(element),
    disabled: isDisabled(element),
    ariaPressed: element.getAttribute('aria-pressed'),
    ariaChecked: element.getAttribute('aria-checked'),
    ariaExpanded: element.getAttribute('aria-expanded'),
    dataState: element.getAttribute('data-state'),
    inClosedMenu: menuClosed
  };
}

function queryAll<T extends Element>(root: ParentNode, selectors: string[]): T[] {
  const found: T[] = [];
  selectors.forEach((selector) => {
    try {
      root.querySelectorAll<T>(selector).forEach((element) => found.push(element));
    } catch {
      // A selector that does not parse in this engine is skipped, not fatal.
    }
  });
  return found;
}

function searchScopes(options: ObserveOptions): ParentNode[] {
  const scopes: ParentNode[] = [];
  const local = options.composerElement?.closest('form') ?? options.composerElement?.parentElement ?? null;
  if (local) {
    scopes.push(local);
  }
  scopes.push(options.document);
  return scopes;
}

/** The provider control that switches the mode, wherever it currently is. */
export function findPrivacyControls(options: ObserveOptions): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const controls: HTMLElement[] = [];
  searchScopes(options).forEach((scope) => {
    queryAll<HTMLElement>(scope, options.composer.privacyControlSelectors).forEach((element) => {
      if (seen.has(element) || !isProviderOwned(element, options)) {
        return;
      }
      if (!options.composer.privacyControlLabelPattern.test(getActionLabel(element))) {
        return;
      }
      seen.add(element);
      controls.push(element);
    });
  });
  return controls;
}

/**
 * The mode's own interface marker: Claude's "Incognito chat" label in its
 * header once incognito is active, ChatGPT's "Temporary chat" indicator. Only
 * outside message content and outside Aside, and only from the adapter's own
 * marker selectors — never a free-text scan of the page.
 */
export function findActiveInterfaceMarker(options: ObserveOptions): HTMLElement | null {
  const selectors = options.composer.privacyActiveInterfaceSelectors ?? [];
  const markers = queryAll<HTMLElement>(options.document, selectors).filter(
    (element) => isProviderOwned(element, options) && isRendered(element)
  );
  return markers[0] ?? null;
}

/** A modal asking for a personalization (or similar) choice before the first send. */
export function findChooserDialog(options: ObserveOptions): HTMLElement | null {
  const dialogs = queryAll<HTMLElement>(options.document, [
    '[role="dialog"]',
    '[role="alertdialog"]',
    ...(options.composer.privacyChooserSelectors ?? [])
  ]).filter((element) => isProviderOwned(element, options) && isRendered(element));
  return (
    dialogs.find((dialog) => {
      const text = dialog.textContent ?? '';
      const buttons = dialog.querySelectorAll('button,[role="button"],[role="radio"],[role="menuitemradio"]').length;
      return CHOOSER_TEXT.test(text) && buttons >= 2;
    }) ?? null
  );
}

/** A menu opener near the composer that could reveal a hidden mode control. */
export function findMenuTrigger(options: ObserveOptions): HTMLElement | null {
  const selectors = options.composer.privacyMenuTriggerSelectors ?? [];
  if (!selectors.length) {
    return null;
  }
  for (const scope of searchScopes(options)) {
    const trigger = queryAll<HTMLElement>(scope, selectors).find(
      (element) =>
        isProviderOwned(element, options) &&
        isRendered(element) &&
        !isDisabled(element) &&
        element.getAttribute('aria-expanded') !== 'true'
    );
    if (trigger) {
      return trigger;
    }
  }
  return null;
}

function looksLikeLoginPage(options: ObserveOptions): boolean {
  const doc = options.document;
  const hasComposer = queryAll<HTMLElement>(doc, options.composer.composerSelectors).some(
    (element) => isProviderOwned(element, options) && isRendered(element)
  );
  if (hasComposer) {
    return false;
  }
  const forms = Array.from(doc.querySelectorAll('form'));
  return forms.some((form) => LOGIN_TEXT.test(form.textContent ?? '') && form.querySelector('input[type="password"],input[type="email"]'));
}

/**
 * One observation of the target document. Pure with respect to the page: it
 * clicks nothing and types nothing. The caller decides what to do with
 * `nextAction`.
 */
export function observePrivateMode(options: ObserveOptions): PrivacyObservation {
  const now = options.now ?? Date.now();
  const base = { control: null as ControlDescriptor | null, actionTarget: null as HTMLElement | null, observedAt: now };

  if (options.document.readyState === 'loading') {
    return {
      ...base,
      availability: 'unknown',
      mode: 'unknown',
      step: 'page-loading',
      evidence: 'none',
      nextAction: 'wait-for-page',
      reason: 'The branch page is still loading.'
    };
  }

  if (looksLikeLoginPage(options)) {
    return {
      ...base,
      availability: 'unknown',
      mode: 'unknown',
      step: 'awaiting-login',
      evidence: 'none',
      nextAction: 'sign-in',
      reason: `The branch window is showing a sign-in page. Sign in there, then check again.`
    };
  }

  // 1. A chooser dialog means the mode was selected and the provider is asking a
  //    question only the Owner may answer.
  const chooser = findChooserDialog(options);
  if (chooser) {
    return {
      ...base,
      actionTarget: chooser,
      availability: 'available',
      mode: 'unknown',
      step: 'awaiting-choice',
      evidence: 'chooser-dialog',
      nextAction: 'choose-personalization',
      reason: `${options.label} is asking for a choice in the branch window. Make it there, then check again.`
    };
  }

  // 2. The provider's own active-interface marker: the strongest positive signal,
  //    and the only one available once the launch control has disappeared.
  const marker = findActiveInterfaceMarker(options);
  const controls = findPrivacyControls(options);
  const describedControls = controls.map((element) => ({ element, descriptor: describeControl(element) }));

  const activeControl = describedControls.find(
    ({ element, descriptor }) => descriptor.rendered && !descriptor.disabled && inferTemporaryChatState(element) === 'active'
  );
  if (activeControl) {
    return {
      ...base,
      control: activeControl.descriptor,
      availability: 'available',
      mode: 'private',
      step: 'ready',
      evidence: 'control-state',
      nextAction: 'none',
      reason: `${options.label} is on.`
    };
  }
  if (marker) {
    return {
      ...base,
      control: describedControls[0]?.descriptor ?? null,
      availability: 'available',
      mode: 'private',
      step: 'ready',
      evidence: 'interface-marker',
      nextAction: 'none',
      reason: `The branch window shows the ${options.label} interface.`
    };
  }

  // 3. A rendered, enabled control reporting inactive can be activated.
  const inactiveControl = describedControls.find(
    ({ element, descriptor }) => descriptor.rendered && !descriptor.disabled && inferTemporaryChatState(element) === 'inactive'
  );
  if (inactiveControl) {
    return {
      ...base,
      control: inactiveControl.descriptor,
      actionTarget: controls[describedControls.indexOf(inactiveControl)],
      availability: 'available',
      mode: 'normal',
      step: 'activating-mode',
      evidence: 'control-state',
      nextAction: 'activate-control',
      reason: `${options.label} is off; it can be turned on.`
    };
  }

  // 4. A rendered control whose state cannot be read: only the Owner can settle it.
  const unreadableControl = describedControls.find(({ descriptor }) => descriptor.rendered && !descriptor.disabled);
  if (unreadableControl) {
    return {
      ...base,
      control: unreadableControl.descriptor,
      actionTarget: controls[describedControls.indexOf(unreadableControl)],
      availability: 'available',
      mode: 'unknown',
      step: 'verifying-mode',
      evidence: 'control-state',
      nextAction: 'check-again',
      reason: `${options.label} has a control here but it does not report whether it is on. Turn it on in the branch window, then check again.`
    };
  }

  // 5. A disabled control: the provider offers the mode but not here.
  const disabledControl = describedControls.find(({ descriptor }) => descriptor.rendered && descriptor.disabled);
  if (disabledControl) {
    return {
      ...base,
      control: disabledControl.descriptor,
      availability: 'unavailable-in-this-context',
      mode: 'normal',
      step: 'blocked',
      evidence: 'control-disabled',
      nextAction: 'none',
      reason: `${options.label} is disabled in this branch window (often a project or workspace rule).`
    };
  }

  // 6. A control that exists but is not rendered — usually inside a closed menu.
  //    That is a step to take, not an entitlement verdict.
  const hiddenControl = describedControls[0];
  const menuTrigger = findMenuTrigger(options);
  if (hiddenControl || menuTrigger) {
    return {
      ...base,
      control: hiddenControl?.descriptor ?? null,
      actionTarget: menuTrigger,
      availability: 'not-observed-yet',
      mode: 'unknown',
      step: 'locating-control',
      evidence: hiddenControl ? 'control-hidden' : 'none',
      nextAction: menuTrigger ? 'open-menu' : 'check-again',
      reason: menuTrigger
        ? `${options.label} is behind a menu in the branch window.`
        : `${options.label} exists on this page but is not shown. Open it in the branch window, then check again.`
    };
  }

  // 7. Nothing observed. Unknown stays unknown: this is not proof of absence.
  return {
    ...base,
    availability: 'unknown',
    mode: 'unknown',
    step: 'locating-control',
    evidence: 'none',
    nextAction: 'check-again',
    reason: `Aside could not observe a ${options.label} control in the branch window yet. Start it there yourself, then check again.`
  };
}

/** What to tell the Owner, and which recovery controls to offer. */
export interface RecoveryAdvice {
  headline: string;
  offerCheckAgain: boolean;
  offerShowTarget: boolean;
  offerOrdinaryMode: boolean;
}

export function adviseRecovery(observation: PrivacyObservation, label: string): RecoveryAdvice {
  switch (observation.step) {
    case 'ready':
      return { headline: `${label} verified.`, offerCheckAgain: false, offerShowTarget: false, offerOrdinaryMode: false };
    case 'awaiting-choice':
      return {
        headline: `${label}: choose in the branch window, then Check again.`,
        offerCheckAgain: true,
        offerShowTarget: true,
        offerOrdinaryMode: false
      };
    case 'awaiting-login':
      return { headline: 'Sign in to the branch window, then Check again.', offerCheckAgain: true, offerShowTarget: true, offerOrdinaryMode: false };
    case 'page-loading':
      return { headline: 'The branch window is still loading.', offerCheckAgain: true, offerShowTarget: true, offerOrdinaryMode: false };
    case 'blocked':
      return {
        headline: `${label} is not available in this branch window.`,
        offerCheckAgain: true,
        offerShowTarget: true,
        offerOrdinaryMode: true
      };
    default:
      return {
        headline: `${label} could not be verified: nothing was typed or sent.`,
        offerCheckAgain: true,
        offerShowTarget: true,
        offerOrdinaryMode: true
      };
  }
}

/**
 * The observation as it travels to the panel: the DOM reference dropped, the
 * recovery advice folded in, the reporting build attached.
 */
export function summarizeObservation(
  observation: PrivacyObservation,
  label: string,
  buildId?: string
): PrivacyRecovery {
  const advice = adviseRecovery(observation, label);
  return {
    step: observation.step,
    availability: observation.availability,
    mode: observation.mode,
    evidence: observation.evidence,
    nextAction: observation.nextAction,
    reason: observation.reason,
    control: observation.control,
    offerCheckAgain: advice.offerCheckAgain,
    offerShowTarget: advice.offerShowTarget,
    offerOrdinaryMode: advice.offerOrdinaryMode,
    observedAt: observation.observedAt,
    buildId
  };
}

/** One short status line per preparation step, for the panel while it runs. */
export function describePreparationStep(
  recovery: Pick<PrivacyRecovery, 'step' | 'nextAction' | 'reason'>,
  label: string
): string {
  switch (recovery.step) {
    case 'page-loading':
      return 'Waiting for the branch window to load…';
    case 'awaiting-login':
      return 'Sign in to the branch window, then Check again.';
    case 'locating-control':
      return recovery.nextAction === 'open-menu'
        ? `Preparing ${label}: opening the menu…`
        : `Looking for the ${label} control…`;
    case 'activating-mode':
      return `Turning on ${label}…`;
    case 'awaiting-choice':
      return recovery.reason;
    case 'navigating':
      return 'Waiting for the branch window to finish navigating…';
    case 'verifying-mode':
      return `Verifying ${label}…`;
    case 'ready':
      return `${label} verified. Sending the question…`;
    case 'blocked':
      return recovery.reason;
    default:
      return recovery.reason;
  }
}
