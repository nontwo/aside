import type { BranchAttemptRef, BranchPanelEvent } from './types';

/**
 * Runtime validation and ownership checks for branch messages.
 *
 * Messages cross three trust boundaries — page postMessage, content script to
 * worker, worker to content script — so they are validated as data on arrival
 * rather than trusted because of their shape at compile time.
 */

const EVENT_KINDS = new Set(['status', 'debug-log', 'title', 'live', 'failed']);

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
  return typeof candidate.kind === 'string' && EVENT_KINDS.has(candidate.kind);
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
