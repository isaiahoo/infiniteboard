import { boxOf, elementBounds } from "./elements";
import { add, center, rotate, unionRects, type Rect, type Vec } from "./geom";
import { canRotate, type BoardElement, type Doc } from "./model";
import type { Handle } from "./transform";

/** The box the transformer draws around the current selection. */
export interface TransformBox {
  rect: Rect;
  angle: number;
  /** Set when exactly one element is selected. */
  single: BoardElement | null;
  canRotate: boolean;
  canResize: boolean;
}

export function transformBox(doc: Doc, ids: ReadonlySet<string>): TransformBox | null {
  const els = [...ids].map((id) => doc.elements[id]).filter(Boolean) as BoardElement[];
  if (els.length === 0) return null;
  if (els.length === 1) {
    const el = els[0];
    if (el.type === "arrow") return null;
    return { rect: boxOf(el), angle: el.angle, single: el, canRotate: canRotate(el) && !el.locked, canResize: !el.locked };
  }
  const rect = unionRects(els.map((e) => elementBounds(doc, e)))!;
  const locked = els.some((e) => e.locked);
  return { rect, angle: 0, single: null, canRotate: !locked && els.every((e) => e.type !== "frame"), canResize: !locked };
}

export function handleWorld(tb: TransformBox, h: Handle): Vec {
  const c = center(tb.rect);
  return add(c, rotate({ x: (h.sx * tb.rect.w) / 2, y: (h.sy * tb.rect.h) / 2 }, tb.angle));
}

export const ROTATE_HANDLE_OFFSET = 26; // screen px above the top edge

export function rotateHandleWorld(tb: TransformBox, zoom: number): Vec {
  const c = center(tb.rect);
  return add(c, rotate({ x: 0, y: -tb.rect.h / 2 - ROTATE_HANDLE_OFFSET / zoom }, tb.angle));
}
