import type { Rect } from "./geom";

export interface Guide {
  axis: "x" | "y";
  /** World coordinate of the guide line. */
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

export const SNAP_SCREEN_PX = 7;

const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];

/**
 * Finds the smallest correction aligning `moving` (edges or centre) to an edge or centre
 * of any candidate, per axis, within `threshold` world units.
 */
export function snapRect(moving: Rect, candidates: readonly Rect[], threshold: number): SnapResult {
  let bestX: { d: number; at: number; c: Rect } | null = null;
  let bestY: { d: number; at: number; c: Rect } | null = null;
  const mx = xs(moving), my = ys(moving);
  for (const c of candidates) {
    for (const v of xs(c)) for (const m of mx) {
      const d = v - m;
      if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: v, c };
    }
    for (const v of ys(c)) for (const m of my) {
      const d = v - m;
      if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: v, c };
    }
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const snapped = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: Guide[] = [];
  // Draw every candidate that lines up after snapping, not just the winner.
  if (bestX) {
    const at = bestX.at;
    const hits = candidates.filter((c) => xs(c).some((v) => Math.abs(v - at) < 0.01));
    const lo = Math.min(snapped.y, ...hits.map((c) => c.y));
    const hi = Math.max(snapped.y + snapped.h, ...hits.map((c) => c.y + c.h));
    guides.push({ axis: "x", at, from: lo, to: hi });
  }
  if (bestY) {
    const at = bestY.at;
    const hits = candidates.filter((c) => ys(c).some((v) => Math.abs(v - at) < 0.01));
    const lo = Math.min(snapped.x, ...hits.map((c) => c.x));
    const hi = Math.max(snapped.x + snapped.w, ...hits.map((c) => c.x + c.w));
    guides.push({ axis: "y", at, from: lo, to: hi });
  }
  return { dx, dy, guides };
}
