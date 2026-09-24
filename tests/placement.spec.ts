import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GAP,
  VIEWPORT_MARGIN,
  findFreeCorner,
  findLeftGutterSlot,
  findSafePlacement,
  isWithinViewport,
  rectsOverlap
} from '../src/shared/placement';
import type { Rect } from '../src/shared/placement';

const DESKTOP = { width: 1440, height: 900 };
const LAPTOP = { width: 1024, height: 768 };
const NARROW = { width: 768, height: 800 };

const TOOLBAR = { width: 236, height: 40 };

function box(top: number, left: number, width: number, height: number): Rect {
  return { top, left, width, height };
}

describe('rect helpers', () => {
  it('detects overlap and separation', () => {
    expect(rectsOverlap(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(true);
    expect(rectsOverlap(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(false);
    // Touching edges are not an overlap.
    expect(rectsOverlap(box(0, 0, 10, 10), box(0, 10, 10, 10))).toBe(false);
  });

  it('keeps a margin from the viewport edge', () => {
    expect(isWithinViewport(box(0, 0, 100, 40), DESKTOP)).toBe(false);
    expect(isWithinViewport(box(VIEWPORT_MARGIN, VIEWPORT_MARGIN, 100, 40), DESKTOP)).toBe(true);
  });
});

describe('selection toolbar placement', () => {
  it('prefers above the selection when there is room', () => {
    const placement = findSafePlacement({
      anchor: box(400, 500, 200, 24),
      size: TOOLBAR,
      viewport: DESKTOP,
      reserved: []
    });

    expect(placement?.side).toBe('above');
    expect(placement!.top).toBe(400 - TOOLBAR.height - DEFAULT_GAP);
  });

  it('moves below when the provider toolbar already occupies the space above', () => {
    // This is the collision the old fixed "selection.top - 56" offset walked into.
    const nativeToolbar = box(350, 480, 220, 44);

    const placement = findSafePlacement({
      anchor: box(400, 500, 200, 24),
      size: TOOLBAR,
      viewport: DESKTOP,
      reserved: [nativeToolbar]
    });

    expect(placement).not.toBeNull();
    expect(placement!.side).not.toBe('above');

    const placed = { ...TOOLBAR, top: placement!.top, left: placement!.left };
    expect(rectsOverlap(placed, nativeToolbar)).toBe(false);
  });

  it('never overlaps the composer, sidebar or a tool pane', () => {
    const sidebar = box(0, 0, 260, 900);
    const composer = box(780, 300, 700, 120);
    const artifactPane = box(0, 900, 540, 900);

    const placement = findSafePlacement({
      anchor: box(760, 400, 260, 20),
      size: TOOLBAR,
      viewport: DESKTOP,
      reserved: [sidebar, composer, artifactPane]
    });

    expect(placement).not.toBeNull();
    const placed = { ...TOOLBAR, top: placement!.top, left: placement!.left };
    [sidebar, composer, artifactPane].forEach((reserved) => {
      expect(rectsOverlap(placed, reserved)).toBe(false);
    });
    expect(isWithinViewport(placed, DESKTOP)).toBe(true);
  });

  it('returns null instead of covering native UI when nothing fits', () => {
    // Every side blocked: the caller must fall back to the compact launcher rather
    // than winning with z-index.
    const wall = box(0, 0, DESKTOP.width, DESKTOP.height);

    const placement = findSafePlacement({
      anchor: box(400, 500, 200, 24),
      size: TOOLBAR,
      viewport: DESKTOP,
      reserved: [wall]
    });

    expect(placement).toBeNull();
  });

  it('clamps a selection near the viewport edge instead of overflowing', () => {
    const placement = findSafePlacement({
      anchor: box(300, DESKTOP.width - 40, 30, 20),
      size: TOOLBAR,
      viewport: DESKTOP,
      reserved: []
    });

    expect(placement).not.toBeNull();
    const placed = { ...TOOLBAR, top: placement!.top, left: placement!.left };
    expect(isWithinViewport(placed, DESKTOP)).toBe(true);
  });
});

describe('left gutter rail placement', () => {
  const railSize = { width: 96, height: 800 };

  it('starts to the right of the provider sidebar, not at left: 12px', () => {
    const sidebar = box(0, 0, 260, 900);
    const readingColumn = box(80, 420, 700, 700);

    const slot = findLeftGutterSlot({
      viewport: DESKTOP,
      readingColumn,
      reserved: [sidebar],
      size: railSize
    });

    expect(slot).not.toBeNull();
    // The whole point: the rail lives in the gutter between the sidebar and the
    // reading column, so it must clear the sidebar's right edge.
    expect(slot!.left).toBeGreaterThanOrEqual(260);
    expect(slot!.left + slot!.width).toBeLessThanOrEqual(readingColumn.left);
  });

  it('uses the freed space when the sidebar is collapsed', () => {
    const collapsed = box(0, 0, 56, 900);
    const readingColumn = box(80, 420, 700, 700);

    const slot = findLeftGutterSlot({
      viewport: DESKTOP,
      readingColumn,
      reserved: [collapsed],
      size: railSize
    });

    expect(slot!.left).toBeGreaterThanOrEqual(56);
    expect(slot!.left).toBeLessThan(260);
  });

  it('never overlaps the reading column or any reserved region', () => {
    const sidebar = box(0, 0, 260, 900);
    const composer = box(780, 300, 700, 120);
    const readingColumn = box(80, 420, 700, 640);

    const slot = findLeftGutterSlot({
      viewport: DESKTOP,
      readingColumn,
      reserved: [sidebar, composer],
      size: railSize
    })!;

    const placed = { top: slot.top, left: slot.left, width: slot.width, height: slot.height };
    expect(rectsOverlap(placed, readingColumn)).toBe(false);
    expect(rectsOverlap(placed, sidebar)).toBe(false);
  });

  it('refuses a gutter too narrow to be readable rather than squeezing in', () => {
    // 1024px with an open sidebar and a wide reading column leaves no usable gutter.
    const sidebar = box(0, 0, 300, 768);
    const readingColumn = box(80, 330, 640, 600);

    const slot = findLeftGutterSlot({
      viewport: LAPTOP,
      readingColumn,
      reserved: [sidebar],
      size: railSize
    });

    expect(slot).toBeNull();
  });

  it('refuses rather than colliding at narrow widths', () => {
    const sidebar = box(0, 0, 240, 800);
    const readingColumn = box(80, 260, 480, 600);

    const slot = findLeftGutterSlot({
      viewport: NARROW,
      readingColumn,
      reserved: [sidebar],
      size: railSize
    });

    expect(slot).toBeNull();
  });

  it('shortens the rail around chrome pinned to the top of the gutter', () => {
    const sidebar = box(0, 0, 200, 900);
    const header = box(0, 0, DESKTOP.width, 90);
    const readingColumn = box(120, 420, 700, 700);

    const slot = findLeftGutterSlot({
      viewport: DESKTOP,
      readingColumn,
      reserved: [sidebar, header],
      size: railSize
    })!;

    expect(slot.top).toBeGreaterThanOrEqual(90);
    expect(rectsOverlap({ ...slot }, header)).toBe(false);
  });

  it('falls back to the viewport midpoint when the reading column cannot be measured', () => {
    const slot = findLeftGutterSlot({
      viewport: DESKTOP,
      readingColumn: null,
      reserved: [],
      size: railSize
    });

    expect(slot).not.toBeNull();
    expect(slot!.left + slot!.width).toBeLessThanOrEqual(DESKTOP.width / 2);
  });
});

describe('compact launcher fallback', () => {
  const size = { width: 84, height: 28 };

  it('picks a corner that overlaps nothing the provider owns', () => {
    const sidebar = box(0, 0, 300, 768);
    const composer = box(660, 320, 380, 90);

    const corner = findFreeCorner({ viewport: LAPTOP, size, reserved: [sidebar, composer] })!;

    expect(corner).not.toBeNull();
    [sidebar, composer].forEach((reserved) => {
      expect(rectsOverlap(corner, reserved)).toBe(false);
    });
    expect(isWithinViewport(corner, LAPTOP)).toBe(true);
  });

  it('avoids the sidebar at narrow widths instead of sitting on it', () => {
    // The regression: the last-resort position was a hard-coded left: 12px, which
    // at 768px with the sidebar open lands directly on the provider's navigation.
    const sidebar = box(0, 0, 260, 800);

    const corner = findFreeCorner({ viewport: NARROW, size, reserved: [sidebar] })!;
    expect(rectsOverlap(corner, sidebar)).toBe(false);
  });

  it('returns null when no corner is free, so the caller can hide it', () => {
    const wall = box(0, 0, NARROW.width, NARROW.height);
    expect(findFreeCorner({ viewport: NARROW, size, reserved: [wall] })).toBeNull();
  });
});
