import type { BranchAttemptRef, BranchPanelEvent, PrivacyRecovery } from './types';

/**
 * Runtime validation and ownership checks for branch messages.
 *
 * Messages cross three trust boundaries — page postMessage, content script to
 * worker, worker to content script — so they are validated as data on arrival
 * rather than trusted because of their shape at compile time.
 */

const EVENT_KINDS = new Set(['status', 'debug-log', 'title', 'live', 'failed', 'captured', 'preparation']);

const RECOVERY_STEPS = new Set([
  'page-loading',
  'awaiting-login',
  'locating-control',
  'activating-mode',
  'awaiting-choice',
  'navigating',
  'verifying-mode',
  'ready',
  'blocked'
]);
const RECOVERY_AVAILABILITY = new Set(['available', 'not-observed-yet', 'unavailable-in-this-context', 'unknown']);
const RECOVERY_MODES = new Set(['normal', 'private', 'unknown']);
const RECOVERY_EVIDENCE = new Set([
  'control-state',
  'interface-marker',
  'chooser-dialog',
  'control-hidden',
  'control-disabled',
  'none'
]);
const RECOVERY_ACTIONS = new Set([
  'open-menu',
  'activate-control',
  'choose-personalization',
  'wait-for-page',
  'sign-in',
  'check-again',
  'none'
]);

/**
 * A preparation record is data from another document: every enum is checked
 * against the closed set, the reason is bounded, and the control descriptor may
 * carry attributes only.
 */
export function isPrivacyRecovery(value: unknown): value is PrivacyRecovery {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.step !== 'string' ||
    !RECOVERY_STEPS.has(candidate.step) ||
    typeof candidate.availability !== 'string' ||
    !RECOVERY_AVAILABILITY.has(candidate.availability) ||
    typeof candidate.mode !== 'string' ||
    !RECOVERY_MODES.has(candidate.mode) ||
    typeof candidate.evidence !== 'string' ||
    !RECOVERY_EVIDENCE.has(candidate.evidence) ||
    typeof candidate.nextAction !== 'string' ||
    !RECOVERY_ACTIONS.has(candidate.nextAction) ||
    typeof candidate.reason !== 'string' ||
    candidate.reason.length > 600 ||
    typeof candidate.offerCheckAgain !== 'boolean' ||
    typeof candidate.offerShowTarget !== 'boolean' ||
    typeof candidate.offerOrdinaryMode !== 'boolean' ||
    typeof candidate.observedAt !== 'number'
  ) {
    return false;
  }
  if (candidate.buildId !== undefined && typeof candidate.buildId !== 'string') {
    return false;
  }
  if (candidate.control === null || candidate.control === undefined) {
    return true;
  }
  if (typeof candidate.control !== 'object') {
    return false;
  }
  const control = candidate.control as Record<string, unknown>;
  return (
    typeof control.tag === 'string' &&
    typeof control.label === 'string' &&
    control.label.length <= 80 &&
    typeof control.rendered === 'boolean' &&
    typeof control.disabled === 'boolean' &&
    typeof control.inClosedMenu === 'boolean'
  );
}

export function isBranchAttemptRef(value: unknown): value is BranchAttemptRef {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerId === 'string' &&
    candidate.providerId.length > 0 &&
    typeof candidate.panelId === 'string' &&
    candidate.panelId.length > 0 &&
    typeof candidate.attemptId === 'string' &&
    candidate.attemptId.length > 0
  );
}

export function isBranchPanelEvent(value: unknown): value is BranchPanelEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== 'string' || !EVENT_KINDS.has(candidate.kind)) {
    return false;
  }
  if (candidate.kind === 'preparation') {
    return isPrivacyRecovery(candidate.recovery);
  }
  if (candidate.kind === 'failed') {
    if (typeof candidate.reason !== 'string') {
      return false;
    }
    return candidate.recovery === undefined || isPrivacyRecovery(candidate.recovery);
  }
  if (candidate.kind === 'captured') {
    // Captured text crosses a trust boundary as data; every field is checked.
    if (!Array.isArray(candidate.messages)) {
      return false;
    }
    if (candidate.capture !== 'partial' && candidate.capture !== 'captured-through') {
      return false;
    }
    return candidate.messages.every((message) => {
      const entry = message as Record<string, unknown> | null;
      return (
        Boolean(entry) &&
        (entry!.role === 'user' || entry!.role === 'assistant') &&
        typeof entry!.text === 'string' &&
        typeof entry!.partial === 'boolean' &&
        typeof entry!.ordinal === 'number'
      );
    });
  }
  return true;
}

/**
 * True only when the message belongs to the attempt currently in flight.
 *
 * An event may never nominate itself as the new current attempt — that is exactly
 * how an orphaned window from a previous try takes over a retry.
 */
export function ownsAttempt(
  message: BranchAttemptRef,
  current: { providerId: string; panelId: string; attemptId: string } | null | undefined
): boolean {
  if (!current) {
    return false;
  }
  return (
    message.providerId === current.providerId &&
    message.panelId === current.panelId &&
    message.attemptId === current.attemptId
  );
}

/** Opaque, unguessable attempt id. */
export function createAttemptId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A run request carrying everything the branch tab needs, validated as data.
 *
 * Every other edge in this system validates on arrival; this one used to take the
 * message's word for it. A malformed `attemptId` here produces a branch that is
 * typed and sent while every event it emits is rejected by `ownsAttempt`, leaving
 * the panel to time out with no explanation — and an unrecognised `branchKind`
 * silently means "persistent", which is the wrong direction to guess in.
 */
export function isRunBranchPromptRequest(
  value: unknown
): value is { prompt: string; launchUrl: string; branchKind: 'persistent' | 'temporary' } {
  if (!isBranchAttemptRef(value)) {
    return false;
  }
  const candidate = value as unknown as Record<string, unknown>;
  return (
    typeof candidate.prompt === 'string' &&
    candidate.prompt.length > 0 &&
    typeof candidate.launchUrl === 'string' &&
    (candidate.branchKind === 'persistent' || candidate.branchKind === 'temporary')
  );
}
