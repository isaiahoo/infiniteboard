import { boxOf, childrenOf, endPoint, elementBounds, frameFor } from "./elements";
import { boundsOfPoints, unionRects, type Rect, type Vec } from "./geom";
import {
  newId, type ArrowEl, type Asset, type BoardElement, type Doc, type FrameEl, type ImageEl, type ShapeEl, type ShapeKind,
  type StickyEl, type StrokeEl, type TextEl,
} from "./model";
import type { Draft } from "./store";
import { measureTextBlockHeight } from "./text";

// ---------- factories ----------

export const DEFAULTS = {
  sticky: { size: 180, fill: "#fff3a3", color: "#1e1e1e" },
  text: { fontSize: 20, color: "#1e1e1e" },
  shape: { fill: "#ffffff", fillOpacity: 1, stroke: "#1e1e1e", strokeWidth: 2, fontSize: 18 },
  arrow: { stroke: "#1e1e1e", strokeWidth: 2 },
  pen: { color: "#1e1e1e", width: 2 },
  marker: { color: "#ffd84d", width: 18, opacity: 0.45 },
};

export function makeShape(kind: ShapeKind, r: Rect, parentId: string | null = null): ShapeEl {
  const d = DEFAULTS.shape;
  return {
    id: newId(), type: "shape", kind, ...r, angle: 0, parentId,
    fill: d.fill, fillOpacity: d.fillOpacity, stroke: d.stroke, strokeWidth: d.strokeWidth,
    text: "", fontSize: d.fontSize, color: "#1e1e1e", align: "center",
  };
}

export function makeSticky(c: Vec, parentId: string | null = null, fill = DEFAULTS.sticky.fill): StickyEl {
  const s = DEFAULTS.sticky.size;
  return { id: newId(), type: "sticky", x: c.x - s / 2, y: c.y - s / 2, w: s, h: s, angle: 0, parentId, fill, text: "", color: DEFAULTS.sticky.color, align: "center" };
}

export function makeText(p: Vec, parentId: string | null = null, text = ""): TextEl {
  const { fontSize, color } = DEFAULTS.text;
  const w = fontSize * 12;
  return { id: newId(), type: "text", x: p.x, y: p.y - fontSize * 0.8, w, h: measureTextBlockHeight(text, fontSize, w), angle: 0, parentId, text, fontSize, color, align: "left" };
}

export function makeFrame(r: Rect, title: string): FrameEl {
  return { id: newId(), type: "frame", ...r, angle: 0, parentId: null, title, fill: "#ffffff" };
}

export function makeArrow(a: Vec, b: Vec, parentId: string | null = null): ArrowEl {
  const { stroke, strokeWidth } = DEFAULTS.arrow;
  return {
    id: newId(), type: "arrow", x: 0, y: 0, w: 0, h: 0, angle: 0, parentId,
    start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, route: "straight", startHead: "none", endHead: "filled",
    stroke, strokeWidth, dash: "solid", label: "", labelT: 0.5,
  };
}

/** Builds a stroke from world points; points are stored relative to their bounding box. */
export function makeStroke(world: Vec[], style: { color: string; width: number; opacity: number; highlighter: boolean }, parentId: string | null = null): StrokeEl {
  const b = boundsOfPoints(world);
  return {
    id: newId(), type: "stroke", x: b.x, y: b.y, w: b.w, h: b.h, baseW: b.w, baseH: b.h, angle: 0, parentId,
    points: world.map((p) => ({ x: Math.round((p.x - b.x) * 100) / 100, y: Math.round((p.y - b.y) * 100) / 100 })),
    ...style,
  };
}

export function makeImage(asset: Asset, c: Vec, maxSide = 480): ImageEl {
  const k = Math.min(1, maxSide / Math.max(asset.width, asset.height));
  const w = asset.width * k, h = asset.height * k;
  return { id: newId(), type: "image", x: c.x - w / 2, y: c.y - h / 2, w, h, angle: 0, parentId: null, assetId: asset.id };
}

// ---------- queries ----------

export function selectionBounds(doc: Doc, ids: Iterable<string>): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) {
    const el = doc.elements[id];
    if (el) rects.push(elementBounds(doc, el));
  }
  return unionRects(rects);
}

/** Selected ids plus the children of selected frames — everything that moves together. */
export function withFrameChildren(doc: Doc, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  for (const id of [...out]) {
    const el = doc.elements[id];
    if (el?.type === "frame") for (const c of childrenOf(doc, id)) out.add(c.id);
  }
  return out;
}

// ---------- mutations ----------

/** Positions `ids` at their location in `from` offset by (dx, dy). */
export function moveFrom(d: Draft, from: Doc, ids: Iterable<string>, dx: number, dy: number) {
  for (const id of ids) {
    const el = from.elements[id];
    if (!el) continue;
    if (el.type === "arrow") {
      const shift = (e: ArrowEl["start"]) => (e.bind ? e : { ...e, x: e.x + dx, y: e.y + dy });
      d.patch<ArrowEl>(id, { start: shift(el.start), end: shift(el.end) });
    } else {
      d.patch(id, { x: el.x + dx, y: el.y + dy });
    }
  }
}

/** Re-evaluates which frame each element belongs to (frames' own children stay with them). */
export function assignFrames(d: Draft, ids: Iterable<string>) {
  const doc = d.doc;
  for (const id of ids) {
    const el = doc.elements[id];
    if (!el || el.type === "frame") continue;
    const f = frameFor(doc, elementBounds(doc, el));
    const parentId = f ? f.id : null;
    if (el.parentId !== parentId) d.patch(id, { parentId });
  }
}

/** After a frame is created or resized, adopt/release elements based on overlap. */
export function recaptureFrame(d: Draft, frameId: string) {
  const doc = d.doc;
  const ids = doc.order.filter((id) => {
    const el = doc.elements[id];
    return el && el.type !== "frame" && (el.parentId === frameId || el.parentId === null);
  });
  assignFrames(d, ids);
}

export function deleteElements(d: Draft, ids: Iterable<string>) {
  const doc = d.doc;
  const gone = withFrameChildren(doc, ids);
  // Arrows that pointed at deleted elements keep their last position as a free end.
  for (const id of doc.order) {
    const el = doc.elements[id];
    if (!el || el.type !== "arrow" || gone.has(id)) continue;
    const unbind = (e: ArrowEl["start"]) => (e.bind && gone.has(e.bind.id) ? { ...endPoint(doc, e), bind: null } : e);
    const start = unbind(el.start), end = unbind(el.end);
    if (start !== el.start || end !== el.end) d.patch<ArrowEl>(id, { start, end });
  }
  for (const id of gone) d.remove(id);
}

/** Deep-copies elements with fresh ids, remapping frame parents and arrow bindings inside the set. */
export function cloneElements(els: BoardElement[], dx: number, dy: number): BoardElement[] {
  const map = new Map(els.map((e) => [e.id, newId()]));
  return els.map((e) => {
    const copy = structuredClone(e) as BoardElement;
    copy.id = map.get(e.id)!;
    // A copy is its own thing, not part of the original's diagram section.
    delete copy.section;
    copy.parentId = e.parentId && map.has(e.parentId) ? map.get(e.parentId)! : e.parentId;
    if (copy.type === "arrow") {
      for (const end of [copy.start, copy.end]) {
        if (end.bind) {
          if (map.has(end.bind.id)) end.bind = { ...end.bind, id: map.get(end.bind.id)! };
          else end.bind = null;
        }
        end.x += dx;
        end.y += dy;
      }
    } else {
      copy.x += dx;
      copy.y += dy;
    }
    return copy;
  });
}

/** Inserts clones of `ids` (plus frame children) and returns the new top-level ids. */
export function duplicate(d: Draft, ids: string[], dx: number, dy: number): string[] {
  const doc = d.doc;
  const all = withFrameChildren(doc, ids);
  const els = doc.order.filter((id) => all.has(id)).map((id) => doc.elements[id]);
  // Arrows inside the copy must know their bound end positions even when the target is not copied.
  const prepared = els.map((e) => (e.type === "arrow" ? { ...e, start: { ...e.start, ...endPoint(doc, e.start) }, end: { ...e.end, ...endPoint(doc, e.end) } } : e));
  const clones = cloneElements(prepared, dx, dy);
  for (const c of clones) d.set(c);
  const topIds = new Set(ids);
  return clones.filter((_, i) => topIds.has(els[i].id)).map((c) => c.id);
}

export function setText(d: Draft, id: string, text: string) {
  const el = d.get(id);
  if (!el) return;
  if (el.type === "text") d.patch<TextEl>(id, { text, h: measureTextBlockHeight(text, el.fontSize, el.w, el.bold, el.italic) });
  else if (el.type === "sticky" || el.type === "shape") d.patch(id, { text });
  else if (el.type === "frame") d.patch<FrameEl>(id, { title: text });
  else if (el.type === "arrow") d.patch<ArrowEl>(id, { label: text });
}

/** Patches style fields; text elements re-measure their height. */
export function patchStyle(d: Draft, ids: Iterable<string>, fields: Record<string, unknown>) {
  for (const id of ids) {
    const el = d.get(id);
    if (!el) continue;
    const applicable = Object.fromEntries(Object.entries(fields).filter(([k]) => k in el));
    if (Object.keys(applicable).length === 0) continue;
    d.patch(id, applicable);
    const next = d.get(id)!;
    if (next.type === "text") d.patch<TextEl>(id, { h: measureTextBlockHeight(next.text, next.fontSize, next.w, next.bold, next.italic) });
  }
}

export type ZMove = "front" | "back" | "forward" | "backward";

export function reorder(d: Draft, ids: Iterable<string>, move: ZMove) {
  const sel = new Set(ids);
  const order = d.doc.order.slice();
  const picked = order.filter((id) => sel.has(id));
  const rest = order.filter((id) => !sel.has(id));
  if (move === "front") return d.setOrder([...rest, ...picked]);
  if (move === "back") return d.setOrder([...picked, ...rest]);
  // Step one position past the nearest non-selected neighbour.
  if (move === "forward") {
    for (let i = order.length - 2; i >= 0; i--) {
      if (sel.has(order[i]) && !sel.has(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
  } else {
    for (let i = 1; i < order.length; i++) {
      if (sel.has(order[i]) && !sel.has(order[i - 1])) [order[i], order[i - 1]] = [order[i - 1], order[i]];
    }
  }
  d.setOrder(order);
}

export function nextFrameTitle(doc: Doc): string {
  const n = doc.order.filter((id) => doc.elements[id]?.type === "frame").length + 1;
  return `Frame ${n}`;
}

// ---------- clipboard ----------

export const CLIPBOARD_MIME = "application/x-whiteboard+json";

export interface ClipboardPayload {
  kind: "whiteboard/elements";
  version: 1;
  elements: BoardElement[];
  assets: Asset[];
}

export function serializeSelection(doc: Doc, ids: Iterable<string>): ClipboardPayload {
  const all = withFrameChildren(doc, ids);
  const elements = doc.order.filter((id) => all.has(id)).map((id) => {
    const e = doc.elements[id];
    if (e.type !== "arrow") return e;
    // Bake current endpoint positions so arrows survive without their targets.
    return { ...e, start: { ...e.start, ...endPoint(doc, e.start) }, end: { ...e.end, ...endPoint(doc, e.end) } };
  });
  const assetIds = new Set(elements.flatMap((e) => (e.type === "image" ? [e.assetId] : [])));
  return { kind: "whiteboard/elements", version: 1, elements, assets: [...assetIds].map((a) => doc.assets[a]).filter(Boolean) };
}

export function parseClipboard(text: string): ClipboardPayload | null {
  try {
    const data = JSON.parse(text);
    if (data?.kind === "whiteboard/elements" && Array.isArray(data.elements)) return data as ClipboardPayload;
  } catch {
    /* not ours */
  }
  return null;
}

/** Pastes a payload centred on `at`; returns ids of the pasted top-level elements. */
export function pastePayload(d: Draft, payload: ClipboardPayload, at: Vec): string[] {
  for (const a of payload.assets) d.addAsset(a);
  const bounds = unionRects(payload.elements.map((e) => (e.type === "arrow" ? boundsOfPoints([e.start, e.end]) : boxOf(e)))) ?? { x: 0, y: 0, w: 0, h: 0 };
  const dx = at.x - (bounds.x + bounds.w / 2);
  const dy = at.y - (bounds.y + bounds.h / 2);
  const ids = new Set(payload.elements.map((e) => e.id));
  const clones = cloneElements(payload.elements, dx, dy);
  for (const c of clones) {
    // Parents that were not part of the payload are dropped; frame membership is recomputed below.
    if (c.parentId && !clones.some((o) => o.id === c.parentId)) c.parentId = null;
    d.set(c);
  }
  const top = clones.filter((_, i) => {
    const p = payload.elements[i].parentId;
    return !p || !ids.has(p);
  });
  assignFrames(d, top.filter((c) => !c.parentId).map((c) => c.id));
  return top.map((c) => c.id);
}

/** Replaces the board's content with `doc`'s (restoring a version) as one undoable change. */
export function replaceContent(d: Draft, doc: Doc) {
  for (const id of [...d.doc.order]) if (!(id in doc.elements)) d.remove(id);
  for (const a of Object.values(doc.assets)) if (!d.doc.assets[a.id]) d.addAsset(a);
  for (const id of doc.order) if (doc.elements[id]) d.set(doc.elements[id]);
  d.setOrder(doc.order.filter((id) => doc.elements[id]));
  d.setTitle(doc.title);
}
