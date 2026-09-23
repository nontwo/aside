import { describe, expect, it } from 'vitest';

import {
  createAttemptId,
  isBranchAttemptRef,
  isBranchPanelEvent,
  isPrivacyRecovery,
  isRunBranchPromptRequest,
  ownsAttempt
} from '../src/shared/branch-attempt';

const current = { providerId: 'chatgpt', panelId: 'panel-1', attemptId: 'attempt-2' };

describe('branch message validation', () => {
  it('accepts a well-formed reference', () => {
    expect(isBranchAttemptRef(current)).toBe(true);
  });

  it('rejects references that are missing or malformed', () => {
    // These arrive across postMessage and runtime messaging, so they are data.
    expect(isBranchAttemptRef(null)).toBe(false);
    expect(isBranchAttemptRef('panel-1')).toBe(false);
    expect(isBranchAttemptRef({ panelId: 'panel-1', attemptId: 'a' })).toBe(false);
    expect(isBranchAttemptRef({ providerId: 'chatgpt', panelId: '', attemptId: 'a' })).toBe(false);
    expect(isBranchAttemptRef({ providerId: 'chatgpt', panelId: 'p', attemptId: 42 })).toBe(false);
  });

  it('only accepts known event kinds', () => {
    expect(isBranchPanelEvent({ kind: 'live' })).toBe(true);
    expect(isBranchPanelEvent({ kind: 'failed', reason: 'x' })).toBe(true);
    expect(isBranchPanelEvent({ kind: 'take-over' })).toBe(false);
    expect(isBranchPanelEvent({})).toBe(false);
    expect(isBranchPanelEvent(undefined)).toBe(false);
  });

  it('validates a private-mode preparation record as data', () => {
    const recovery = {
      step: 'awaiting-choice',
      availability: 'available',
      mode: 'unknown',
      evidence: 'chooser-dialog',
      nextAction: 'choose-personalization',
      reason: 'Temporary Chat is asking for a choice in the branch window.',
      control: null,
      offerCheckAgain: true,
      offerShowTarget: true,
      offerOrdinaryMode: false,
      observedAt: 1,
      buildId: 'abc'
    };
    expect(isPrivacyRecovery(recovery)).toBe(true);
    expect(isBranchPanelEvent({ kind: 'preparation', recovery })).toBe(true);
    expect(isBranchPanelEvent({ kind: 'failed', reason: 'x', recovery })).toBe(true);

    // Every enum is closed: a step or action the panel does not know is rejected,
    // not rendered as a button.
    expect(isPrivacyRecovery({ ...recovery, step: 'take-over' })).toBe(false);
    expect(isPrivacyRecovery({ ...recovery, nextAction: 'run-script' })).toBe(false);
    expect(isPrivacyRecovery({ ...recovery, offerOrdinaryMode: 'yes' })).toBe(false);
    expect(isPrivacyRecovery({ ...recovery, reason: 'x'.repeat(601) })).toBe(false);
    expect(isPrivacyRecovery({ ...recovery, control: { tag: 'BUTTON' } })).toBe(false);
    expect(isBranchPanelEvent({ kind: 'preparation' })).toBe(false);
    expect(isBranchPanelEvent({ kind: 'failed', reason: 'x', recovery: { step: 'ready' } })).toBe(false);
  });
});

describe('attempt ownership', () => {
  it('accepts an event from the attempt currently in flight', () => {
    expect(ownsAttempt({ ...current }, current)).toBe(true);
  });

  it('rejects an event from a superseded attempt on the same panel', () => {
    // The regression: a retry reuses the panel, so an orphaned native window from
    // the previous try would otherwise look like a legitimate reporter.
    expect(ownsAttempt({ ...current, attemptId: 'attempt-1' }, current)).toBe(false);
  });

  it('rejects an event for another panel or another provider', () => {
    expect(ownsAttempt({ ...current, panelId: 'panel-2' }, current)).toBe(false);
    expect(ownsAttempt({ ...current, providerId: 'claude' }, current)).toBe(false);
  });

  it('rejects everything when the panel has no attempt in flight', () => {
    // A panel sitting in draft or already finished must not be mutated by a
    // late event from a window that is still open.
    expect(ownsAttempt({ ...current }, null)).toBe(false);
    expect(ownsAttempt({ ...current }, undefined)).toBe(false);
  });

  it('cannot be satisfied by a message that nominates its own attempt', () => {
    // Ownership is decided against the panel's record, never against the message,
    // so a spoofed sender cannot promote itself to current.
    const spoofed = { providerId: 'chatgpt', panelId: 'panel-1', attemptId: 'whatever-i-say' };
    expect(ownsAttempt(spoofed, current)).toBe(false);
  });
});

describe('attempt ids', () => {
  it('are unguessable and unique per attempt', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createAttemptId()));
    expect(ids.size).toBe(500);
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f]{24}$/));
  });
});

describe('a run request is validated as data on arrival', () => {
  const valid = {
    type: 'RUN_BRANCH_PROMPT_IN_TAB',
    providerId: 'claude',
    panelId: 'panel-1',
    attemptId: 'a1b2c3',
    prompt: 'the branch prompt',
    launchUrl: 'https://claude.ai/new',
    branchKind: 'temporary'
  };

  it('accepts a well-formed request', () => {
    expect(isRunBranchPromptRequest(valid)).toBe(true);
  });

  it('rejects a request with no usable attempt identity', () => {
    // Without this, the branch is typed and sent while every event it emits is
    // rejected by ownsAttempt, so the panel just times out on the watchdog.
    expect(isRunBranchPromptRequest({ ...valid, attemptId: '' })).toBe(false);
    expect(isRunBranchPromptRequest({ ...valid, attemptId: undefined })).toBe(false);
    expect(isRunBranchPromptRequest({ ...valid, panelId: 42 })).toBe(false);
  });

  it('refuses to guess a branch kind', () => {
    // An unrecognised value used to mean "persistent", which is the wrong
    // direction to guess in: it would run a branch meant to be private without
    // the privacy sequence.
    expect(isRunBranchPromptRequest({ ...valid, branchKind: 'Temporary' })).toBe(false);
    expect(isRunBranchPromptRequest({ ...valid, branchKind: undefined })).toBe(false);
  });

  it('rejects an empty prompt and a non-object', () => {
    expect(isRunBranchPromptRequest({ ...valid, prompt: '' })).toBe(false);
    expect(isRunBranchPromptRequest(null)).toBe(false);
    expect(isRunBranchPromptRequest('RUN_BRANCH_PROMPT_IN_TAB')).toBe(false);
  });
});
