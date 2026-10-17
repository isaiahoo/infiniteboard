// Pure 2D geometry helpers. World units everywhere unless a name says "screen".

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function rotate(p: Vec, angle: number, origin: Vec = { x: 0, y: 0 }): Vec {
  if (angle === 0) return p;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
}

export const center = (r: Rect): Vec => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function rectFromPoints(a: Vec, b: Vec): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function boundsOfPoints(points: readonly Vec[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const pts: Vec[] = [];
  for (const r of rects) pts.push({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h });
  return boundsOfPoints(pts);
}

export const expandRect = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function pointInRect(p: Vec, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Fraction (0..1) of `inner`'s area that lies inside `outer`. */
export function overlapRatio(inner: Rect, outer: Rect): number {
  const ix = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const iy = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  const area = inner.w * inner.h;
  return area > 0 ? (ix * iy) / area : pointInRect(center(inner), outer) ? 1 : 0;
}

/** Corners of a rect rotated by `angle` around its centre, clockwise from top-left. */
export function rotatedCorners(r: Rect, angle: number): Vec[] {
  const c = center(r);
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => rotate(p, angle, c));
}

export function rotatedBounds(r: Rect, angle: number): Rect {
  return angle === 0 ? r : boundsOfPoints(rotatedCorners(r, angle));
}

/** Converts a world point into the un-rotated frame of a rect rotated about its centre. */
export function toLocal(p: Vec, r: Rect, angle: number): Vec {
  return rotate(p, -angle, center(r));
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Vec, pts: readonly Vec[]): number {
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentIntersectsRect(a: Vec, b: Vec, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const c = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) if (segmentsIntersect(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

/** True when any part of the polyline comes within `pad` of the rect. */
export function polylineTouchesRect(pts: readonly Vec[], r: Rect, pad = 0): boolean {
  const er = expandRect(r, pad);
  if (pts.length === 1) return pointInRect(pts[0], er);
  for (let i = 1; i < pts.length; i++) if (segmentIntersectsRect(pts[i - 1], pts[i], er)) return true;
  return false;
}

/** Ramer–Douglas–Peucker simplification (iterative, keeps endpoints). */
export function simplify(pts: readonly Vec[], epsilon: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Light exponential smoothing whose strength drops as the pen moves faster,
 * so slow wobbles are damped while quick strokes keep their shape.
 */
export function smoothStroke(pts: readonly Vec[], strength = 0.5): Vec[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec[] = [pts[0]];
  let prev = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const step = dist(pts[i], pts[i - 1]);
    const alpha = Math.min(1, (1 - strength) + step / 40);
    prev = lerp(prev, pts[i], alpha);
    out.push(prev);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Snaps an angle (radians) to a multiple of `step` when within `tolerance`. */
export function snapAngle(angle: number, step: number, tolerance: number): number {
  const nearest = Math.round(angle / step) * step;
  return Math.abs(angle - nearest) <= tolerance ? nearest : angle;
}

export function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  a %= t;
  if (a > Math.PI) a -= t;
  if (a <= -Math.PI) a += t;
  return a;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
