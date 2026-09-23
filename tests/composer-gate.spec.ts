import { describe, expect, it } from 'vitest';

import { composerSizePenalty } from '../src/shared/send-controls';

/**
 * The regression: a live Claude branch spent twenty seconds failing to find a
 * composer that was on the page, because size was a hard veto rather than a
 * ranking signal. This repo had already recorded the same defect once and worked
 * around it in the fixture instead of the gate.
 */
describe('composer size gate', () => {
  it('does not make a zero-height composer unusable', () => {
    // An empty contenteditable has no intrinsic height. It is still the composer.
    const penalty = composerSizePenalty(600, 0);
    expect(Number.isFinite(penalty)).toBe(true);
    expect(penalty).toBeLessThan(0);
  });

  it('does not make a narrow composer unusable', () => {
    expect(Number.isFinite(composerSizePenalty(80, 40))).toBe(true);
  });

  it('prefers a full-sized composer over a degenerate one', () => {
    expect(composerSizePenalty(600, 56)).toBeGreaterThan(composerSizePenalty(600, 0));
    expect(composerSizePenalty(600, 56)).toBeGreaterThan(composerSizePenalty(80, 56));
  });

  it('costs nothing at a normal size', () => {
    expect(composerSizePenalty(600, 56)).toBe(0);
  });

  it('ranks a structurally-found candidate below an adapter match of the same size', () => {
    // The adapter's provider knowledge should win whenever it has any; structure
    // is the hedge for when its selectors have drifted.
    expect(composerSizePenalty(600, 56, true)).toBeLessThan(composerSizePenalty(600, 56, false));
  });

  it('still ranks a small adapter match above a small structural one', () => {
    expect(composerSizePenalty(80, 0, false)).toBeGreaterThan(composerSizePenalty(80, 0, true));
  });
});
