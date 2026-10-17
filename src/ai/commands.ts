// Board commands exposed to AI assistants (via the MCP bridge). Each call is one undo step.
import { boxOf, endPoint } from "../core/elements";
import { center, type Rect, type Vec } from "../core/geom";
import {
  STICKY_COLORS, type ArrowEl, type ArrowEnd, type BoardElement, type ShapeKind, type TextAlign,
} from "../core/model";
import {
  assignFrames, deleteElements, makeArrow, makeFrame, makeShape, makeSticky, makeStroke, makeText, patchStyle,
  recaptureFrame, selectionBounds, setText,
} from "../core/ops";
import { measureTextBlockHeight } from "../core/text";
import type { Editor } from "../interaction/editor";


const NAMED: Record<string, string> = {
  yellow: STICKY_COLORS[0], orange: STICKY_COLORS[1], pink: STICKY_COLORS[2], purple: STICKY_COLORS[3],
  blue: STICKY_COLORS[4], green: STICKY_COLORS[5], lime: STICKY_COLORS[6], gray: STICKY_COLORS[7], grey: STICKY_COLORS[7],
  white: "#ffffff", black: "#1e1e1e", red: "#e5484d", darkblue: "#3e63dd", darkgreen: "#30a46c",
};
const SHAPES: ShapeKind[] = ["rect", "roundrect", "ellipse", "diamond", "triangle"];

function color(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const c = NAMED[v.toLowerCase()] ?? v;
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) throw new Error(`Invalid colour "${v}". Use #rrggbb or one of: ${Object.keys(NAMED).join(", ")}`);
  return c;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const round = (n: number) => Math.round(n * 10) / 10;

export interface ElementSpec {
  type: "sticky" | "shape" | "text" | "frame" | "connector" | "stroke";
  /** Optional caller-chosen key so connectors in the same call can refer to this element. */
  ref?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  title?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  kind?: ShapeKind;
  fontSize?: number;
  align?: TextAlign;
  bold?: boolean;
  from?: string;
  to?: string;
  fromPoint?: [number, number];
  toPoint?: [number, number];
  route?: ArrowEl["route"];
  label?: string;
  endHead?: ArrowEl["endHead"];
  startHead?: ArrowEl["startHead"];
  dash?: ArrowEl["dash"];
  points?: [number, number][];
  width?: number;
  angle?: number;
}

/** Compact, model-friendly description of an element. */
export function describe(doc: Editor["doc"], el: BoardElement): Record<string, unknown> {
  const out: Record<string, unknown> = { id: el.id, type: el.type === "arrow" ? "connector" : el.type };
  if (el.type === "arrow") {
    const a = endPoint(doc, el.start), b = endPoint(doc, el.end);
    Object.assign(out, {
      from: el.start.bind?.id ?? null, to: el.end.bind?.id ?? null,
      fromPoint: [round(a.x), round(a.y)], toPoint: [round(b.x), round(b.y)], route: el.route,
    });
    if (el.label) out.label = el.label;
  } else {
    Object.assign(out, { x: round(el.x), y: round(el.y), w: round(el.w), h: round(el.h) });
    if (el.angle) out.angle = round((el.angle * 180) / Math.PI);
  }
  if (el.type === "shape") Object.assign(out, { kind: el.kind, fill: el.fillOpacity ? el.fill : "none", stroke: el.stroke });
  if (el.type === "sticky") out.color = el.fill;
  if (el.type === "frame") out.title = el.title;
  if ((el.type === "shape" || el.type === "sticky" || el.type === "text") && el.text) out.text = el.text;
  if (el.type === "text") out.fontSize = round(el.fontSize);
  if (el.parentId) out.frame = el.parentId;
  if (el.locked) out.locked = true;
  return out;
}

export function getBoard(editor: Editor, params: { type?: string; limit?: number } = {}) {
  const doc = editor.doc;
  const limit = Math.min(Math.max(1, num(params.limit) ?? 500), 5000);
  const typeFilter = params.type === "connector" ? "arrow" : params.type;
  const all = doc.order.map((id) => doc.elements[id]).filter((el) => el && (!typeFilter || el.type === typeFilter));
  const cam = editor.camera;
  return {
    title: doc.title,
    elementCount: doc.order.length,
    viewport: { x: round(-cam.x / cam.zoom), y: round(-cam.y / cam.zoom), w: round(editor.viewW / cam.zoom), h: round(editor.viewH / cam.zoom), zoom: round(cam.zoom * 100) / 100 },
    contentBounds: selectionBounds(doc, doc.order),
    selection: [...editor.selection],
    elements: all.slice(0, limit).map((el) => describe(doc, el)),
    truncated: all.length > limit,
    notes: "Coordinates are world units (1 unit = 1px at 100% zoom), y grows downward. Elements are listed bottom-to-top in paint order.",
  };
}

/** Free space to the right of existing content, laid out in rows of 5. */
function autoPlacer(editor: Editor) {
  const b = selectionBounds(editor.doc, editor.doc.order);
  const origin = b ? { x: b.x + b.w + 120, y: b.y } : editor.viewportCenter();
  let i = 0;
  return (w: number, h: number): Vec => {
    const col = i % 5, row = Math.floor(i / 5);
    i++;
    return { x: origin.x + col * 240 + (240 - w) / 2 - (b ? 0 : 600), y: origin.y + row * 240 + (240 - h) / 2 - (b ? 0 : 240) };
  };
}

/** Binds to the side midpoint of `el` that faces point `p`. */
function endToward(el: BoardElement, p: Vec): ArrowEnd {
  const c = center(boxOf(el));
  const dx = p.x - c.x, dy = p.y - c.y;
  const [u, v] = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? [1, 0.5] : [0, 0.5]) : dy >= 0 ? [0.5, 1] : [0.5, 0];
  return { x: c.x, y: c.y, bind: { id: el.id, u, v } };
}

/** Picks facing sides so a connector between two boxes leaves and enters cleanly. */
function facingEnds(a: BoardElement, b: BoardElement): [ArrowEnd, ArrowEnd] {
  return [endToward(a, center(boxOf(b))), endToward(b, center(boxOf(a)))];
}

export function createElements(editor: Editor, params: { elements?: ElementSpec[] }) {
  const specs = params.elements;
  if (!Array.isArray(specs) || specs.length === 0) throw new Error("`elements` must be a non-empty array");
  if (specs.length > 500) throw new Error("At most 500 elements per call");
  const place = autoPlacer(editor);
  const refs = new Map<string, string>();
  const created: { ref?: string; id: string; type: string }[] = [];

  editor.store.transact((d) => {
    const resolve = (key: string) => {
      const id = refs.get(key) ?? key;
      if (!d.get(id)) throw new Error(`Unknown element "${key}" (use an existing id or a ref defined earlier in this call)`);
      return d.get(id)!;
    };
    const frames: string[] = [];
    const rest: string[] = [];
    for (const s of specs) {
      const el = buildElement(s, place, resolve);
      if (el.type === "frame") {
        d.insert(el, 0);
        frames.push(el.id);
      } else {
        d.set(el);
        rest.push(el.id);
      }
      if (s.ref) refs.set(s.ref, el.id);
      created.push({ ref: s.ref, id: el.id, type: s.type });
    }
    for (const f of frames) recaptureFrame(d, f);
    assignFrames(d, rest);
  });
  editor.select(created.filter((c) => c.type !== "frame").map((c) => c.id));
  return { created };
}

function buildElement(s: ElementSpec, place: (w: number, h: number) => Vec, resolve: (k: string) => BoardElement): BoardElement {
  const at = (w: number, h: number): Rect => {
    const p = num(s.x) !== undefined && num(s.y) !== undefined ? { x: s.x!, y: s.y! } : place(w, h);
    return { x: p.x, y: p.y, w, h };
  };
  const angle = num(s.angle) ? (s.angle! * Math.PI) / 180 : 0;
  switch (s.type) {
    case "sticky": {
      const size = num(s.w) ?? 180;
      const r = at(size, num(s.h) ?? size);
      const el = makeSticky(center(r), null, color(s.color ?? s.fill) ?? STICKY_COLORS[0]);
      return { ...el, ...r, text: s.text ?? "", angle, align: s.align ?? el.align };
    }
    case "shape": {
      const kind = s.kind ?? "rect";
      if (!SHAPES.includes(kind)) throw new Error(`Unknown shape kind "${kind}". Use: ${SHAPES.join(", ")}`);
      const el = makeShape(kind, at(num(s.w) ?? 160, num(s.h) ?? 110));
      return {
        ...el, angle, text: s.text ?? "", fill: color(s.fill) ?? el.fill, stroke: color(s.stroke) ?? el.stroke,
        color: color(s.color) ?? el.color, fontSize: num(s.fontSize) ?? el.fontSize, bold: s.bold, align: s.align ?? el.align,
        fillOpacity: s.fill === "none" ? 0 : 1,
      };
    }
    case "text": {
      const fontSize = num(s.fontSize) ?? 20;
      const w = num(s.w) ?? Math.max(120, Math.min(600, (s.text ?? "").length * fontSize * 0.6 + 16));
      const r = at(w, fontSize * 2);
      const el = makeText({ x: r.x, y: r.y }, null, s.text ?? "");
      const h = measureTextBlockHeight(el.text, fontSize, w, s.bold);
      return { ...el, x: r.x, y: r.y, w, h, fontSize, angle, color: color(s.color) ?? el.color, bold: s.bold, align: s.align ?? el.align };
    }
    case "frame": {
      const r = at(num(s.w) ?? 800, num(s.h) ?? 500);
      const el = makeFrame(r, s.title ?? s.text ?? "Frame");
      return { ...el, fill: color(s.fill ?? s.color) ?? el.fill };
    }
    case "connector": {
      const el = makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 });
      const src = s.from ? resolve(s.from) : null;
      const dst = s.to ? resolve(s.to) : null;
      const pt = (p?: [number, number]) => (p ? { x: p[0], y: p[1] } : null);
      const fp = pt(s.fromPoint), tp = pt(s.toPoint);
      if (src && dst) [el.start, el.end] = facingEnds(src, dst);
      else if ((src || fp) && (dst || tp)) {
        el.start = src ? endToward(src, tp!) : { ...fp! };
        el.end = dst ? endToward(dst, fp!) : { ...tp! };
      } else throw new Error("A connector needs `from`/`to` (element ids or refs) or `fromPoint`/`toPoint` ([x, y])");
      return {
        ...el, route: s.route ?? "straight", label: s.label ?? "", endHead: s.endHead ?? "filled", startHead: s.startHead ?? "none",
        dash: s.dash ?? "solid", stroke: color(s.color ?? s.stroke) ?? el.stroke,
      };
    }
    case "stroke": {
      if (!Array.isArray(s.points) || s.points.length < 2) throw new Error("A stroke needs `points`: at least two [x, y] pairs");
      return makeStroke(s.points.map(([x, y]) => ({ x, y })), { color: color(s.color) ?? "#1e1e1e", width: num(s.width) ?? 2, opacity: 1, highlighter: false });
    }
    default:
      throw new Error(`Unknown element type "${(s as { type: string }).type}". Use: sticky, shape, text, frame, connector, stroke`);
  }
}

export interface ElementUpdate extends Partial<Omit<ElementSpec, "type">> {
  id: string;
  locked?: boolean;
}

export function updateElements(editor: Editor, params: { updates?: ElementUpdate[] }) {
  const updates = params.updates;
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("`updates` must be a non-empty array");
  const changed: string[] = [];
  editor.store.transact((d) => {
    for (const u of updates) {
      const el = d.get(u.id);
      if (!el) throw new Error(`Unknown element id "${u.id}"`);
      if (el.type === "arrow") {
        const patch: Partial<ArrowEl> = {};
        if (u.from || u.to) {
          const a = u.from ? d.get(u.from) : el.start.bind ? d.get(el.start.bind.id) : undefined;
          const b = u.to ? d.get(u.to) : el.end.bind ? d.get(el.end.bind.id) : undefined;
          if ((u.from && !a) || (u.to && !b)) throw new Error("Unknown `from`/`to` element");
          if (a && b) [patch.start, patch.end] = facingEnds(a, b);
        }
        if (u.fromPoint) patch.start = { x: u.fromPoint[0], y: u.fromPoint[1] };
        if (u.toPoint) patch.end = { x: u.toPoint[0], y: u.toPoint[1] };
        for (const k of ["route", "endHead", "startHead", "dash"] as const) if (u[k]) (patch as Record<string, unknown>)[k] = u[k];
        if (u.color ?? u.stroke) patch.stroke = color(u.color ?? u.stroke);
        d.patch<ArrowEl>(el.id, patch);
        if (u.label !== undefined) setText(d, el.id, u.label);
      } else {
        const geo: Record<string, number> = {};
        for (const k of ["x", "y", "w", "h"] as const) if (num(u[k]) !== undefined) geo[k] = u[k]!;
        if (num(u.angle) !== undefined && el.type !== "frame") geo.angle = (u.angle! * Math.PI) / 180;
        if (Object.keys(geo).length) d.patch(el.id, geo);
        const text = u.text ?? u.title;
        if (text !== undefined) setText(d, el.id, text);
        const style: Record<string, unknown> = {};
        if (u.kind) {
          if (!SHAPES.includes(u.kind)) throw new Error(`Unknown shape kind "${u.kind}"`);
          style.kind = u.kind;
        }
        if (u.fill !== undefined) {
          if (u.fill === "none") style.fillOpacity = 0;
          else Object.assign(style, { fill: color(u.fill), fillOpacity: 1 });
        }
        if (u.color !== undefined) {
          // For sticky notes and frames "color" means the background.
          if (el.type === "sticky" || el.type === "frame") style.fill = color(u.color);
          else style.color = color(u.color);
        }
        if (u.stroke !== undefined) style.stroke = color(u.stroke);
        if (num(u.fontSize) !== undefined) style.fontSize = u.fontSize;
        if (u.align) style.align = u.align;
        if (u.bold !== undefined) style.bold = u.bold;
        if (Object.keys(style).length) patchStyle(d, [el.id], style);
        if (el.type === "text" && geo.w !== undefined) {
          const t = d.get(el.id) as Extract<BoardElement, { type: "text" }>;
          d.patch(el.id, { h: measureTextBlockHeight(t.text, t.fontSize, t.w, t.bold, t.italic) });
        }
      }
      if (u.locked !== undefined) d.patch(el.id, { locked: u.locked });
      changed.push(el.id);
    }
    const frames = changed.filter((id) => d.get(id)?.type === "frame");
    for (const f of frames) recaptureFrame(d, f);
    assignFrames(d, changed.filter((id) => d.get(id)?.type !== "frame"));
  });
  return { updated: changed };
}

export function deleteElementsCmd(editor: Editor, params: { ids?: string[]; all?: boolean }) {
  const ids = params.all ? [...editor.doc.order] : params.ids;
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Pass `ids` (array) or `all: true`");
  const missing = ids.filter((id) => !editor.doc.elements[id]);
  if (missing.length) throw new Error(`Unknown element ids: ${missing.join(", ")}`);
  editor.store.transact((d) => deleteElements(d, ids));
  editor.select([]);
  return { deleted: ids.length };
}

export function focusView(editor: Editor, params: { ids?: string[]; zoom?: number; x?: number; y?: number }) {
  if (params.ids?.length) editor.zoomToFit(params.ids.filter((id) => editor.doc.elements[id]));
  else if (num(params.x) !== undefined && num(params.y) !== undefined) {
    const z = num(params.zoom) ?? editor.camera.zoom;
    editor.setCamera({ zoom: z, x: editor.viewW / 2 - params.x! * z, y: editor.viewH / 2 - params.y! * z });
  } else if (num(params.zoom) !== undefined) editor.zoomTo(params.zoom!);
  else editor.zoomToFit();
  return { viewport: getBoard(editor, { limit: 1 }).viewport };
}

export type CommandName = "get_board" | "create_elements" | "update_elements" | "delete_elements" | "focus_view" | "select" | "undo" | "redo" | "screenshot";

/** Dispatches one bridge request. Unknown methods are rejected. */
export async function runCommand(editor: Editor, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method as CommandName) {
    case "get_board":
      return getBoard(editor, params);
    case "create_elements":
      return createElements(editor, params as { elements?: ElementSpec[] });
    case "update_elements":
      return updateElements(editor, params as { updates?: ElementUpdate[] });
    case "delete_elements":
      return deleteElementsCmd(editor, params as { ids?: string[]; all?: boolean });
    case "focus_view":
      return focusView(editor, params);
    case "select": {
      const ids = (params.ids as string[] | undefined)?.filter((id) => editor.doc.elements[id]) ?? [];
      editor.select(ids);
      return { selection: ids };
    }
    case "undo":
      editor.store.undo();
      return { ok: true, canUndo: editor.store.canUndo };
    case "redo":
      editor.store.redo();
      return { ok: true, canRedo: editor.store.canRedo };
    case "screenshot": {
      if (!editor.capture) throw new Error("Screenshot is not available in this environment");
      return { image: await editor.capture(num(params.maxWidth) ?? 1280) };
    }
    default:
      throw new Error(`Unknown method "${method}"`);
  }
}
