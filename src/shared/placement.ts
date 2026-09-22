/**
 * Geometry for placing Aside's own UI without covering the provider's.
 *
 * Pure functions over plain rectangles: no DOM access, so the collision rules can
 * be tested directly instead of inferred from screenshots. Nothing here mutates or
 * measures provider elements — callers pass in rectangles they measured read-only.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type PlacementSide = 'above' | 'below' | 'right' | 'left';

export interface Placement {
  top: number;
  left: number;
  side: PlacementSide;
}

export const DEFAULT_GAP = 8;
export const VIEWPORT_MARGIN = 12;

export function rectBottom(rect: Rect): number {
  return rect.top + rect.height;
}

export function rectRight(rect: Rect): number {
  return rect.left + rect.width;
}

export function rectsOverlap(a: Rect, b: Rect, tolerance = 0): boolean {
  return (
    a.left < rectRight(b) - tolerance &&
    rectRight(a) > b.left + tolerance &&
    a.top < rectBottom(b) - tolerance &&
    rectBottom(a) > b.top + tolerance
  );
}

export function isWithinViewport(rect: Rect, viewport: Viewport, margin = VIEWPORT_MARGIN): boolean {
  return (
    rect.left >= margin &&
    rect.top >= margin &&
    rectRight(rect) <= viewport.width - margin &&
    rectBottom(rect) <= viewport.height - margin
  );
}

function clampToViewport(rect: Rect, viewport: Viewport, margin = VIEWPORT_MARGIN): Rect {
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, viewport.width - rect.width - margin)
  );
  const top = Math.min(
    Math.max(margin, rect.top),
    Math.max(margin, viewport.height - rect.height - margin)
  );
  return { ...rect, left, top };
}

export interface PlacementRequest {
  /** The selection (or other anchor) the UI belongs to. */
  anchor: Rect;
  /** Measured size of the Aside element being placed. */
  size: { width: number; height: number };
  viewport: Viewport;
  /** Rectangles owned by the provider that must not be covered. */
  reserved: Rect[];
  gap?: number;
  /** Order of sides to try. Defaults to above, below, right, left. */
  order?: PlacementSide[];
}

function candidateFor(side: PlacementSide, request: PlacementRequest): Rect {
  const { anchor, size } = request;
  const gap = request.gap ?? DEFAULT_GAP;
  const centeredLeft = anchor.left + anchor.width / 2 - size.width / 2;
  const centeredTop = anchor.top + anchor.height / 2 - size.height / 2;

  switch (side) {
    case 'above':
      return { top: anchor.top - size.height - gap, left: centeredLeft, ...size };
    case 'below':
      return { top: rectBottom(anchor) + gap, left: centeredLeft, ...size };
    case 'right':
      return { top: centeredTop, left: rectRight(anchor) + gap, ...size };
    case 'left':
    default:
      return { top: centeredTop, left: anchor.left - size.width - gap, ...size };
  }
}

/**
 * Find a position around the anchor that fits in the viewport and touches none of
 * the reserved rectangles. Returns null when no side works, so the caller can fall
 * back to a compact entry rather than covering native UI.
 */
export function findSafePlacement(request: PlacementRequest): Placement | null {
  const order = request.order ?? ['above', 'below', 'right', 'left'];

  // First pass: a candidate that fits without needing to be nudged.
  for (const side of order) {
    const candidate = candidateFor(side, request);
    if (
      isWithinViewport(candidate, request.viewport) &&
      !request.reserved.some((reserved) => rectsOverlap(candidate, reserved))
    ) {
      return { top: candidate.top, left: candidate.left, side };
    }
  }

  // Second pass: allow horizontal/vertical clamping, still refusing overlap.
  for (const side of order) {
    const clamped = clampToViewport(candidateFor(side, request), request.viewport);
    if (
      isWithinViewport(clamped, request.viewport) &&
      !request.reserved.some((reserved) => rectsOverlap(clamped, reserved))
    ) {
      return { top: clamped.top, left: clamped.left, side };
    }
  }

  return null;
}

export interface GutterRequest {
  viewport: Viewport;
  /** Bounds of the conversation reading column. */
  readingColumn: Rect | null;
  /** Provider-owned rectangles (sidebar, composer, tool panes). */
  reserved: Rect[];
  /** Size the rail wants. Height may be reduced by the returned slot. */
  size: { width: number; height: number };
  /** Minimum usable width before the gutter is considered too tight. */
  minWidth?: number;
  margin?: number;
}

export interface GutterSlot {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Find free whitespace in the LEFT gutter — the space between provider chrome on
 * the left (its navigation) and the reading column — for the minimized rail.
 *
 * This is deliberately not "left: 12px": the provider's own left navigation is a
 * reserved rectangle, so the slot starts to the right of whatever chrome is there,
 * and is rejected outright when the remaining gutter is too narrow to be readable.
 */
export function findLeftGutterSlot(request: GutterRequest): GutterSlot | null {
  const margin = request.margin ?? VIEWPORT_MARGIN;
  const minWidth = request.minWidth ?? 72;

  // The gutter starts after any vertical chrome anchored to the left edge. A
  // full-width header also touches the left edge but is not a sidebar, so width is
  // what distinguishes them; horizontal bars are handled as vertical blockers below.
  const maxSidebarWidth = request.viewport.width * 0.4;
  const leftChrome = request.reserved.filter(
    (rect) =>
      rect.left <= margin && rect.width > 0 && rect.height > 0 && rect.width <= maxSidebarWidth
  );
  const gutterLeft = leftChrome.reduce((edge, rect) => Math.max(edge, rectRight(rect)), 0) + margin;

  // …and ends where the reading column begins, or at the viewport centre when the
  // column cannot be measured.
  const gutterRight = request.readingColumn
    ? request.readingColumn.left - margin
    : Math.floor(request.viewport.width / 2);

  const available = gutterRight - gutterLeft;
  if (available < minWidth) {
    return null;
  }

  const width = Math.min(request.size.width, available);

  // Vertically, avoid anything reserved that overlaps the gutter column.
  const blockers = request.reserved
    .filter((rect) =>
      rectsOverlap({ top: 0, left: gutterLeft, width, height: request.viewport.height }, rect)
    )
    .sort((a, b) => a.top - b.top);

  let top = margin;
  let bottom = request.viewport.height - margin;
  for (const blocker of blockers) {
    // Only trim from the ends; a blocker in the middle of an otherwise free gutter
    // is handled by shortening the rail rather than splitting it.
    if (blocker.top <= top) {
      top = Math.max(top, rectBottom(blocker) + margin);
    } else if (rectBottom(blocker) >= bottom) {
      bottom = Math.min(bottom, blocker.top - margin);
    }
  }

  const height = Math.min(request.size.height, bottom - top);
  if (height < 48) {
    return null;
  }

  return { top, left: gutterLeft, width, height };
}

export type Corner = 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right';

export interface CornerRequest {
  viewport: Viewport;
  size: { width: number; height: number };
  reserved: Rect[];
  /** Order to try. Defaults to bottom-left first, which is closest to the rail. */
  order?: Corner[];
  margin?: number;
}

/**
 * Last-resort placement for the compact launcher: a corner that overlaps nothing
 * the provider owns.
 *
 * Returns null when no corner is free, so the caller hides the on-page entry
 * rather than dropping it on top of native chrome. The extension action remains
 * the guaranteed way in.
 */
export function findFreeCorner(request: CornerRequest): Rect | null {
  const margin = request.margin ?? VIEWPORT_MARGIN;
  const order = request.order ?? ['bottom-left', 'top-left', 'bottom-right', 'top-right'];
  const { width, height } = request.size;

  const positions: Record<Corner, Rect> = {
    'bottom-left': { left: margin, top: request.viewport.height - height - margin, width, height },
    'top-left': { left: margin, top: margin, width, height },
    'bottom-right': {
      left: request.viewport.width - width - margin,
      top: request.viewport.height - height - margin,
      width,
      height
    },
    'top-right': { left: request.viewport.width - width - margin, top: margin, width, height }
  };

  for (const corner of order) {
    const candidate = positions[corner];
    if (
      isWithinViewport(candidate, request.viewport, margin) &&
      !request.reserved.some((reserved) => rectsOverlap(candidate, reserved))
    ) {
      return candidate;
    }
  }

  return null;
}
