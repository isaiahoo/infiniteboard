import { boxOf } from "./elements";
import { add, center, rotate, snapAngle, sub, type Rect, type Vec } from "./geom";
import type { ArrowEl, BoardElement, Doc } from "./model";
import type { Draft } from "./store";
import { measureTextBlockHeight } from "./text";

/** Handle position: -1 = left/top edge, 1 = right/bottom edge, 0 = middle. */
export interface Handle {
  sx: -1 | 0 | 1;
  sy: -1 | 0 | 1;
}

export const HANDLES: Handle[] = [
  { sx: -1, sy: -1 }, { sx: 0, sy: -1 }, { sx: 1, sy: -1 }, { sx: 1, sy: 0 },
  { sx: 1, sy: 1 }, { sx: 0, sy: 1 }, { sx: -1, sy: 1 }, { sx: -1, sy: 0 },
];

export const isCorner = (h: Handle) => h.sx !== 0 && h.sy !== 0;

const MIN_SIZE = 4;

/** Which handles an element offers. Text only resizes horizontally on sides. */
export function handlesFor(el: BoardElement | null): Handle[] {
  if (!el) return HANDLES;
  if (el.type === "text") return HANDLES.filter((h) => h.sy === 0 || h.sx !== 0);
  if (el.type === "stroke") return HANDLES.filter(isCorner);
  if (el.type === "arrow") return [];
  return HANDLES;
}

function keepsRatioByDefault(el: BoardElement): boolean {
  return el.type === "image" || el.type === "stroke" || el.type === "sticky";
}

/**
 * Resizes one (possibly rotated) element by dragging `handle` to world point `p`.
 * The opposite edge/corner stays fixed in world space. `shift` toggles aspect-ratio locking.
 */
export function resizeSingle(start: BoardElement, handle: Handle, p: Vec, shift: boolean): Partial<BoardElement> {
  const box = boxOf(start);
  const c0 = center(box);
  const a = start.angle;
  // Anchor = the point opposite the handle, relative to the centre in local space.
  const anchorLocal = { x: (-handle.sx * box.w) / 2, y: (-handle.sy * box.h) / 2 };
  const anchor = add(c0, rotate(anchorLocal, a));
  const local = rotate(sub(p, anchor), -a);

  let w = handle.sx !== 0 ? Math.max(MIN_SIZE, local.x * handle.sx) : box.w;
  let h = handle.sy !== 0 ? Math.max(MIN_SIZE, local.y * handle.sy) : box.h;

  const corner = isCorner(handle);
  const lock = (start.type === "text" && corner) || (keepsRatioByDefault(start) ? !shift || start.type === "stroke" : shift);
  if (lock) {
    let k: number;
    if (corner) k = Math.max(w / box.w, h / box.h);
    else k = handle.sx !== 0 ? w / box.w : h / box.h;
    k = Math.max(k, MIN_SIZE / Math.min(box.w, box.h));
    w = box.w * k;
    h = box.h * k;
  }

  if (start.type === "text") {
    if (corner) {
      const k = w / box.w;
      const fontSize = Math.max(4, start.fontSize * k);
      h = measureTextBlockHeight(start.text, fontSize, w, start.bold, start.italic);
      return placeAt(anchor, handle, a, w, h, { fontSize });
    }
    h = measureTextBlockHeight(start.text, start.fontSize, w, start.bold, start.italic);
    // Side handle on text: keep the top edge fixed even though height changes.
    const anchorTop = add(c0, rotate({ x: anchorLocal.x, y: -box.h / 2 }, a));
    return placeAt(anchorTop, { sx: handle.sx, sy: 1 }, a, w, h, {});
  }
  return placeAt(anchor, handle, a, w, h, {});
}

/** Places a w×h box so the point opposite `handle` sits at `anchor`. */
function placeAt(anchor: Vec, handle: Handle, angle: number, w: number, h: number, extra: Partial<BoardElement>): Partial<BoardElement> {
  const c = add(anchor, rotate({ x: (handle.sx * w) / 2, y: (handle.sy * h) / 2 }, angle));
  return { x: c.x - w / 2, y: c.y - h / 2, w, h, ...extra } as Partial<BoardElement>;
}

/** Uniformly scales a multi-selection around the edge/corner opposite the handle. */
export function resizeGroup(d: Draft, from: Doc, ids: Iterable<string>, bounds: Rect, handle: Handle, p: Vec) {
  const ax = handle.sx === 0 ? bounds.x + bounds.w / 2 : handle.sx > 0 ? bounds.x : bounds.x + bounds.w;
  const ay = handle.sy === 0 ? bounds.y + bounds.h / 2 : handle.sy > 0 ? bounds.y : bounds.y + bounds.h;
  const kx = handle.sx !== 0 ? ((p.x - ax) * handle.sx) / bounds.w : 0;
  const ky = handle.sy !== 0 ? ((p.y - ay) * handle.sy) / bounds.h : 0;
  const k = Math.max(0.02, isCorner(handle) ? Math.max(kx, ky) : handle.sx !== 0 ? kx : ky);
  const map = (v: Vec) => ({ x: ax + (v.x - ax) * k, y: ay + (v.y - ay) * k });
  for (const id of ids) {
    const el = from.elements[id];
    if (!el) continue;
    if (el.type === "arrow") {
      const scaleEnd = (e: ArrowEl["start"]) => (e.bind ? e : { ...e, ...map(e) });
      d.patch<ArrowEl>(id, { start: scaleEnd(el.start), end: scaleEnd(el.end) });
      continue;
    }
    // Scale around the anchor using the centre so rotated elements stay consistent.
    const c = map(center(boxOf(el)));
    const w = el.w * k, h = el.h * k;
    const patch: Record<string, number> = { x: c.x - w / 2, y: c.y - h / 2, w, h };
    if (el.type === "text" || el.type === "shape") patch.fontSize = el.fontSize * k;
    d.patch(id, patch as Partial<BoardElement>);
  }
}

export const ROTATE_SNAP = Math.PI / 4;
export const ROTATE_SNAP_TOLERANCE = (4 * Math.PI) / 180;
export const ROTATE_STEP_SHIFT = Math.PI / 12;

export function snapRotation(angle: number, shift: boolean): number {
  if (shift) return Math.round(angle / ROTATE_STEP_SHIFT) * ROTATE_STEP_SHIFT;
  return snapAngle(angle, ROTATE_SNAP, ROTATE_SNAP_TOLERANCE);
}

/** Rotates elements by `delta` around `pivot` (their own angles change by the same amount). */
export function rotateGroup(d: Draft, from: Doc, ids: Iterable<string>, pivot: Vec, delta: number) {
  for (const id of ids) {
    const el = from.elements[id];
    if (!el) continue;
    if (el.type === "arrow") {
      const rot = (e: ArrowEl["start"]) => (e.bind ? e : { ...e, ...rotate(e, delta, pivot) });
      d.patch<ArrowEl>(id, { start: rot(el.start), end: rot(el.end) });
      continue;
    }
    if (el.type === "frame") continue;
    const c = rotate(center(boxOf(el)), delta, pivot);
    d.patch(id, { x: c.x - el.w / 2, y: c.y - el.h / 2, angle: el.angle + delta });
  }
}
