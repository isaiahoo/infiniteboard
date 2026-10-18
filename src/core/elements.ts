import {
  add, boundsOfPoints, center, dist, distToPolyline, expandRect, mul, overlapRatio, pointInRect, rotate, rotatedBounds,
  sub, toLocal, type Rect, type Vec,
} from "./geom";
import type { ArrowEl, ArrowEnd, BoardElement, Doc, FrameEl, ShapeEl, StrokeEl } from "./model";

export const boxOf = (el: BoardElement): Rect => ({ x: el.x, y: el.y, w: el.w, h: el.h });

/** Height of a cylinder's elliptical cap (the top ellipse is twice this tall). */
export const cylinderCap = (w: number, h: number) => Math.min(h * 0.12, w * 0.15);

/** Where a shape's text goes: the largest comfortable box inside its outline (un-rotated). */
export function shapeTextBox(el: ShapeEl): Rect {
  const { x, y, w, h } = el;
  const pad = Math.max(6, Math.min(w, h) * 0.1);
  const inset = (l: number, t: number, r = l, b = t): Rect => ({ x: x + l, y: y + t, w: Math.max(1, w - l - r), h: Math.max(1, h - t - b) });
  switch (el.kind) {
    case "ellipse":
      return inset(w * 0.15 + 4, h * 0.15 + 4);
    case "diamond":
      return inset(w * 0.25, h * 0.25);
    case "triangle":
      return inset(w * 0.25, h * 0.45, w * 0.25, pad);
    case "hexagon":
      return inset(w * 0.2, pad);
    case "parallelogram":
      return inset(Math.min(w * 0.2, h * 0.5) + pad, pad);
    case "cylinder": {
      const c = cylinderCap(w, h);
      return inset(pad, c * 2 + pad / 2, pad, c + pad / 2);
    }
    default:
      return inset(pad, pad);
  }
}

/** Paint order: frames first (in their relative order), then everything else. */
export function paintOrder(doc: Doc): BoardElement[] {
  const frames: BoardElement[] = [];
  const rest: BoardElement[] = [];
  for (const id of doc.order) {
    const el = doc.elements[id];
    if (!el) continue;
    (el.type === "frame" ? frames : rest).push(el);
  }
  return frames.concat(rest);
}

// ---------- strokes ----------

export function strokeWorldPoints(el: StrokeEl): Vec[] {
  const sx = el.baseW > 0 ? el.w / el.baseW : 1;
  const sy = el.baseH > 0 ? el.h / el.baseH : 1;
  const c = center(boxOf(el));
  return el.points.map((p) => rotate({ x: el.x + p.x * sx, y: el.y + p.y * sy }, el.angle, c));
}

// ---------- arrows ----------

export type Side = "top" | "right" | "bottom" | "left";

const SIDE_DIR: Record<Side, Vec> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** World position of an endpoint, following its bound element if it still exists. */
export function endPoint(doc: Doc, end: ArrowEnd): Vec {
  const target = end.bind ? doc.elements[end.bind.id] : undefined;
  if (!target || !end.bind) return { x: end.x, y: end.y };
  const local = { x: target.x + end.bind.u * target.w, y: target.y + end.bind.v * target.h };
  return rotate(local, target.angle, center(boxOf(target)));
}

/** Outward direction of a bound endpoint (nearest side of the target), or null when free. */
function endDirection(doc: Doc, end: ArrowEnd): Vec | null {
  const target = end.bind ? doc.elements[end.bind.id] : undefined;
  if (!target || !end.bind) return null;
  const { u, v } = end.bind;
  const d = { top: v, bottom: 1 - v, left: u, right: 1 - u };
  const side = (Object.keys(d) as Side[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
  return rotate(SIDE_DIR[side], target.angle);
}

const axisOf = (v: Vec): Vec => (Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 });

export interface ArrowGeometry {
  a: Vec;
  b: Vec;
  /** Polyline approximating the path (used for hit tests, bounds and label placement). */
  points: Vec[];
  /** Cubic control points when route is curved. */
  bezier?: [Vec, Vec, Vec, Vec];
  /** Directions the heads point to (unit vectors). */
  startDir: Vec;
  endDir: Vec;
}

export function arrowGeometry(doc: Doc, el: ArrowEl): ArrowGeometry {
  const a = endPoint(doc, el.start);
  const b = endPoint(doc, el.end);
  const da = endDirection(doc, el.start);
  const db = endDirection(doc, el.end);
  const unit = (v: Vec) => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };

  if (el.route === "straight") {
    const dir = unit(sub(b, a));
    return { a, b, points: [a, b], startDir: mul(dir, -1), endDir: dir };
  }

  if (el.route === "curved") {
    const span = Math.max(30, dist(a, b) / 2.5);
    const sa = da ?? axisOf(sub(b, a));
    const sb = db ?? axisOf(sub(a, b));
    const c1 = add(a, mul(sa, span));
    const c2 = add(b, mul(sb, span));
    const pts: Vec[] = [];
    for (let i = 0; i <= 32; i++) pts.push(cubic(a, c1, c2, b, i / 32));
    return { a, b, points: pts, bezier: [a, c1, c2, b], startDir: unit(sub(a, c1)), endDir: unit(sub(b, c2)) };
  }

  if (el.route === "elbow" && el.via && Math.abs(b.x - a.x - el.via.span.x) < 0.5 && Math.abs(b.y - a.y - el.via.span.y) < 0.5) {
    const clean = dedupe(orthogonal([a, ...el.via.points.map((p) => add(a, p)), b], da, db));
    const n = clean.length;
    return { a, b, points: clean, startDir: unit(sub(clean[0], clean[1])), endDir: unit(sub(clean[n - 1], clean[n - 2])) };
  }

  // Elbow: orthogonal route leaving each bound end perpendicular to its side.
  const pad = 24;
  const sa = da ? axisOf(da) : axisOf(sub(b, a));
  const sb = db ? axisOf(db) : null;
  const a1 = da ? add(a, mul(sa, pad)) : a;
  const b1 = sb ? add(b, mul(sb, pad)) : b;
  const pts: Vec[] = [a, a1];
  const aH = sa.x !== 0;
  const bH = sb ? sb.x !== 0 : aH;
  if (aH && bH) {
    // Both ends facing the same way (e.g. two right sides): go around, not between them.
    const mx = sb && sa.x === sb.x ? (sa.x > 0 ? Math.max(a1.x, b1.x) : Math.min(a1.x, b1.x)) : (a1.x + b1.x) / 2;
    pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y });
  } else if (!aH && !bH) {
    const my = sb && sa.y === sb.y ? (sa.y > 0 ? Math.max(a1.y, b1.y) : Math.min(a1.y, b1.y)) : (a1.y + b1.y) / 2;
    pts.push({ x: a1.x, y: my }, { x: b1.x, y: my });
  } else if (aH) {
    pts.push({ x: b1.x, y: a1.y });
  } else {
    pts.push({ x: a1.x, y: b1.y });
  }
  pts.push(b1, b);
  const clean = dedupe(pts);
  const n = clean.length;
  const endDir = n >= 2 ? unit(sub(clean[n - 1], clean[n - 2])) : { x: 1, y: 0 };
  const startDir = n >= 2 ? unit(sub(clean[0], clean[1])) : { x: -1, y: 0 };
  return { a, b, points: clean, startDir, endDir };
}

/** Turns a polyline into horizontal/vertical segments, leaving and entering along the given side directions. */
function orthogonal(pts: Vec[], da: Vec | null, db: Vec | null): Vec[] {
  const out: Vec[] = [pts[0]];
  let horiz = da ? Math.abs(da.x) > Math.abs(da.y) : Math.abs(pts[1].x - pts[0].x) > Math.abs(pts[1].y - pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1], q = pts[i];
    if (Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5) {
      out.push(q);
      horiz = Math.abs(p.y - q.y) < 0.5;
      continue;
    }
    // The last bend is chosen so the line arrives perpendicular to the target's side.
    if (i === pts.length - 1 && db) horiz = Math.abs(db.x) <= Math.abs(db.y);
    out.push(horiz ? { x: q.x, y: p.y } : { x: p.x, y: q.y }, q);
    horiz = !horiz;
  }
  return out;
}

function dedupe(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    // Drop the middle of three collinear points.
    if (out.length >= 2) {
      const q = out[out.length - 2];
      if ((Math.abs(q.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) || (Math.abs(q.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01)) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

export function cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Point at fraction t (by length) along a polyline. */
export function pointAlong(pts: readonly Vec[], t: number): Vec {
  if (pts.length === 1) return pts[0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let target = total * Math.min(1, Math.max(0, t));
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (target <= seg && seg > 0) {
      const k = target / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
    }
    target -= seg;
  }
  return pts[pts.length - 1];
}

/** Closest fraction t (by length) along a polyline to point p. */
export function nearestT(pts: readonly Vec[], p: Vec): number {
  let total = 0;
  const lens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    lens.push(l);
    total += l;
  }
  if (total === 0) return 0.5;
  let best = Infinity, bestT = 0.5, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = lens[i - 1];
    const k = l === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l)));
    const q = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    const d = dist(p, q);
    if (d < best) {
      best = d;
      bestT = (acc + k * l) / total;
    }
    acc += l;
  }
  return bestT;
}

export const LABEL_FONT_SIZE = 14;

export function arrowLabelRect(doc: Doc, el: ArrowEl, geo = arrowGeometry(doc, el)): Rect | null {
  if (!el.label) return null;
  const p = pointAlong(geo.points, el.labelT);
  const w = Math.max(24, el.label.length * LABEL_FONT_SIZE * 0.6 + 12);
  const h = LABEL_FONT_SIZE * 1.6;
  return { x: p.x - w / 2, y: p.y - h / 2, w, h };
}

// ---------- binding ----------

export function canBind(el: BoardElement): boolean {
  return el.type !== "arrow" && el.type !== "stroke" && el.type !== "frame";
}

export interface BindCandidate {
  id: string;
  u: number;
  v: number;
  point: Vec;
}

/**
 * Finds the element an arrow endpoint at `p` should attach to.
 * Inside an element: snaps to the nearest side midpoint. Near the outline: slides along it.
 */
export function findBinding(doc: Doc, p: Vec, zoom: number, exclude: ReadonlySet<string> = new Set()): BindCandidate | null {
  const band = 16 / zoom;
  const midSnap = 14 / zoom;
  const els = paintOrder(doc);
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (!canBind(el) || exclude.has(el.id)) continue;
    const box = boxOf(el);
    const lp = toLocal(p, box, el.angle);
    if (!pointInRect(lp, expandRect(box, band))) continue;
    const mids: [number, number][] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    const nearMid = mids
      .map(([u, v]) => ({ u, v, d: dist(lp, { x: box.x + u * box.w, y: box.y + v * box.h }) }))
      .sort((a, b) => a.d - b.d)[0];
    const inside = pointInRect(lp, expandRect(box, -band));
    let u: number, v: number;
    if (inside || nearMid.d <= midSnap) {
      ({ u, v } = nearMid);
    } else if (el.type === "shape" && el.kind === "ellipse") {
      const th = Math.atan2((lp.y - (box.y + box.h / 2)) / (box.h || 1), (lp.x - (box.x + box.w / 2)) / (box.w || 1));
      u = 0.5 + 0.5 * Math.cos(th);
      v = 0.5 + 0.5 * Math.sin(th);
    } else {
      const cu = box.w ? (lp.x - box.x) / box.w : 0.5;
      const cv = box.h ? (lp.y - box.y) / box.h : 0.5;
      const dl = Math.abs(lp.x - box.x), dr = Math.abs(box.x + box.w - lp.x);
      const dt = Math.abs(lp.y - box.y), db = Math.abs(box.y + box.h - lp.y);
      const m = Math.min(dl, dr, dt, db);
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      if (m === dl) [u, v] = [0, clamp(cv)];
      else if (m === dr) [u, v] = [1, clamp(cv)];
      else if (m === dt) [u, v] = [clamp(cu), 0];
      else [u, v] = [clamp(cu), 1];
    }
    const point = rotate({ x: box.x + u * box.w, y: box.y + v * box.h }, el.angle, center(box));
    return { id: el.id, u, v, point };
  }
  return null;
}

// ---------- bounds & hit testing ----------

export function elementBounds(doc: Doc, el: BoardElement): Rect {
  if (el.type === "arrow") {
    const geo = arrowGeometry(doc, el);
    const r = boundsOfPoints(geo.points);
    const lr = arrowLabelRect(doc, el, geo);
    return lr ? boundsOfPoints([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: lr.x, y: lr.y }, { x: lr.x + lr.w, y: lr.y + lr.h }]) : r;
  }
  if (el.type === "stroke") return expandRect(boundsOfPoints(strokeWorldPoints(el)), el.width / 2);
  return rotatedBounds(boxOf(el), el.angle);
}

export const FRAME_TITLE_H = 22; // screen px

export function frameTitleRect(el: FrameEl, zoom: number): Rect {
  const h = FRAME_TITLE_H / zoom;
  return { x: el.x, y: el.y - h - 4 / zoom, w: Math.min(el.w, Math.max(80, el.title.length * 9) / zoom), h };
}

export function hitTest(doc: Doc, el: BoardElement, p: Vec, zoom: number): boolean {
  const tol = 6 / zoom;
  switch (el.type) {
    case "stroke":
      return distToPolyline(p, strokeWorldPoints(el)) <= el.width / 2 + tol;
    case "arrow": {
      const geo = arrowGeometry(doc, el);
      if (distToPolyline(p, geo.points) <= el.strokeWidth / 2 + tol) return true;
      const lr = arrowLabelRect(doc, el, geo);
      return !!lr && pointInRect(p, lr);
    }
    case "frame":
      return pointInRect(p, boxOf(el)) || pointInRect(p, frameTitleRect(el, zoom));
    case "shape": {
      const box = boxOf(el);
      const lp = toLocal(p, box, el.angle);
      if (el.kind === "ellipse") {
        const rx = el.w / 2 + tol, ry = el.h / 2 + tol;
        const c = center(box);
        return ((lp.x - c.x) / rx) ** 2 + ((lp.y - c.y) / ry) ** 2 <= 1;
      }
      return pointInRect(lp, expandRect(box, tol));
    }
    default:
      return pointInRect(toLocal(p, boxOf(el), el.angle), boxOf(el));
  }
}

/** Topmost element under p, or null. Elements inside frames win over the frame itself. */
export function elementAt(doc: Doc, p: Vec, zoom: number, skip?: (el: BoardElement) => boolean): BoardElement | null {
  const els = paintOrder(doc);
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (skip?.(el)) continue;
    if (hitTest(doc, el, p, zoom)) return el;
  }
  return null;
}

// ---------- frames ----------

/** Topmost frame containing at least half of `r`. */
export function frameFor(doc: Doc, r: Rect, exclude: ReadonlySet<string> = new Set()): FrameEl | null {
  let found: FrameEl | null = null;
  for (const id of doc.order) {
    const f = doc.elements[id];
    if (!f || f.type !== "frame" || exclude.has(f.id)) continue;
    if (overlapRatio(r, boxOf(f)) >= 0.5) found = f;
  }
  return found;
}

export function childrenOf(doc: Doc, frameId: string): BoardElement[] {
  const out: BoardElement[] = [];
  for (const id of doc.order) {
    const el = doc.elements[id];
    if (el && el.parentId === frameId) out.push(el);
  }
  return out;
}
