// Structured diagrams for AI assistants: the assistant describes nodes, edges and groups, and
// this module sizes, lays out and builds them as ordinary board elements in one undo step.
import dagre from "@dagrejs/dagre";
import { boxOf, elementBounds, frameTitleRect, shapeTextBox } from "../core/elements";
import { center, rectsIntersect, type Rect, type Vec } from "../core/geom";
import {
  STICKY_COLORS, type ArrowEl, type ArrowEnd, type BoardElement, type Dash, type FrameEl, type ShapeEl, type ShapeKind,
} from "../core/model";
import { assignFrames, deleteElements, makeArrow, makeFrame, makeShape, makeSticky, makeText, recaptureFrame, selectionBounds } from "../core/ops";
import type { Draft } from "../core/store";
import { fontString, measureText, measureTextBlockHeight, textHeight, wrapText } from "../core/text";
import type { Editor } from "../interaction/editor";

export type Layout = "flow" | "tree" | "mindmap" | "columns" | "grid" | "timeline";
export type Direction = "down" | "right";
export type NodeKind =
  | "process" | "decision" | "terminal" | "io" | "database" | "service" | "user" | "external" | "queue"
  | "card" | "note" | "topic" | "text";

export interface DiagramNode {
  id: string;
  text: string;
  detail?: string;
  kind?: NodeKind;
  color?: string;
  group?: string;
  parent?: string;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: Dash;
  route?: ArrowEl["route"];
  bidirectional?: boolean;
}
export interface DiagramGroup {
  id: string;
  title?: string;
  color?: string;
}
export type Placement = { x: number; y: number } | { near: string; side?: "right" | "below" | "left" | "above"; gap?: number };
export interface DiagramSpec {
  layout?: Layout;
  title?: string;
  direction?: Direction;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  groups?: DiagramGroup[];
  place?: Placement;
  spacing?: "compact" | "normal" | "roomy";
  focus?: boolean;
  /** Id of an existing section (or any element in it) to swap out for this diagram, in place. */
  replace?: string;
}

// ---------- appearance ----------

/** Pastel fill + matching outline for each colour name. */
const TONES: Record<string, [string, string]> = {
  white: ["#ffffff", "#1e1e1e"], gray: ["#f1f1ef", "#8a8a8a"], yellow: ["#fff3c4", "#b08800"], orange: ["#ffe8d6", "#d9822b"],
  red: ["#ffe0e0", "#d64545"], pink: ["#ffe0ea", "#d6457a"], purple: ["#ece4ff", "#7a5af5"], blue: ["#e3edff", "#3e63dd"],
  teal: ["#d8f3f0", "#1f9d8f"], green: ["#dcf5e6", "#2f9e6b"], lime: ["#ecf8d4", "#6b9e1f"],
};
TONES.grey = TONES.gray;
const BRANCH_TONES = ["blue", "green", "orange", "purple", "pink", "teal", "yellow", "red"];
const GROUP_FILLS = ["#f5f7ff", "#f2fbf6", "#fff8f0", "#faf5ff", "#fff5f8", "#f0fbfa", "#fffbea", "#f6f6f4"];
const STICKY_BY_NAME: Record<string, string> = {
  yellow: STICKY_COLORS[0], orange: STICKY_COLORS[1], pink: STICKY_COLORS[2], red: STICKY_COLORS[2], purple: STICKY_COLORS[3],
  blue: STICKY_COLORS[4], teal: STICKY_COLORS[5], green: STICKY_COLORS[5], lime: STICKY_COLORS[6], gray: STICKY_COLORS[7], grey: STICKY_COLORS[7], white: "#ffffff",
};

const KIND_STYLE: Record<Exclude<NodeKind, "note" | "text">, { shape: ShapeKind; tone: string }> = {
  process: { shape: "roundrect", tone: "white" },
  decision: { shape: "diamond", tone: "yellow" },
  terminal: { shape: "ellipse", tone: "green" },
  io: { shape: "parallelogram", tone: "blue" },
  database: { shape: "cylinder", tone: "purple" },
  service: { shape: "rect", tone: "blue" },
  user: { shape: "ellipse", tone: "orange" },
  external: { shape: "rect", tone: "gray" },
  queue: { shape: "hexagon", tone: "pink" },
  card: { shape: "roundrect", tone: "white" },
  topic: { shape: "roundrect", tone: "blue" },
};

const DEFAULT_KIND: Record<Layout, NodeKind> = {
  flow: "process", tree: "process", mindmap: "topic", columns: "card", grid: "note", timeline: "card",
};

function toneOf(name: string | undefined): [string, string] | null {
  if (!name) return null;
  const t = TONES[name.toLowerCase()];
  if (t) return t;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name)) return [name, "#1e1e1e"];
  throw new Error(`Invalid colour "${name}". Use #rrggbb or one of: ${Object.keys(TONES).join(", ")}`);
}

interface Box {
  id: string;
  w: number;
  h: number;
  /** Centre, in diagram-local coordinates, once laid out. */
  x: number;
  y: number;
  build: (r: Rect) => BoardElement;
}

/** Inner text box for `text`: grows wider before it grows taller, up to `maxW`. */
function textBlock(text: string, fontSize: number, bold: boolean, minW: number, maxW: number, maxLines = 3) {
  const font = fontString(fontSize, bold);
  let lines = wrapText(text, font, minW);
  let w = minW;
  while (lines.length > maxLines && w < maxW) {
    w = Math.min(maxW, w + 20);
    lines = wrapText(text, font, w);
  }
  const widest = Math.max(...lines.map((l) => measureText(l, font)));
  return { w: Math.ceil(Math.max(widest, 40)) + 4, h: textHeight(lines.length, fontSize) };
}

/** Smallest shape of `kind` whose text box holds `inner`. */
function shapeFor(kind: ShapeKind, inner: { w: number; h: number }, min: { w: number; h: number }) {
  let w = Math.max(min.w, inner.w + 28), h = Math.max(min.h, inner.h + 24);
  for (let i = 0; i < 16; i++) {
    const tb = shapeTextBox({ kind, x: 0, y: 0, w, h } as ShapeEl);
    if (tb.w >= inner.w && tb.h >= inner.h) break;
    if (tb.w < inner.w) w *= Math.min(1.5, inner.w / tb.w + 0.02);
    if (tb.h < inner.h) h *= Math.min(1.5, inner.h / tb.h + 0.02);
  }
  return { w: Math.ceil(w), h: Math.ceil(h) };
}

interface NodeLook {
  kind: NodeKind;
  tone?: string;
  emphasis?: boolean;
}

function nodeBox(n: DiagramNode, look: NodeLook, withDetail = true): Box {
  const text = n.detail && withDetail ? `${n.text}\n${n.detail}` : n.text;
  if (look.kind === "note") {
    const size = text.length > 70 ? 220 : 180;
    const fill = n.color ? STICKY_BY_NAME[n.color.toLowerCase()] ?? toneOf(n.color)![0] : STICKY_COLORS[0];
    return {
      id: n.id, w: size, h: size, x: 0, y: 0,
      build: (r) => ({ ...makeSticky(center(r), null, fill), ...r, text }),
    };
  }
  if (look.kind === "text") {
    const block = textBlock(text, 18, false, 120, 320, 4);
    const w = block.w + 8;
    return {
      id: n.id, w, h: measureTextBlockHeight(text, 18, w), x: 0, y: 0,
      build: (r) => ({ ...makeText({ x: r.x, y: r.y }, null, text), ...r, fontSize: 18, align: "center" }),
    };
  }
  const style = KIND_STYLE[look.kind];
  const fontSize = look.emphasis ? 22 : 16;
  const bold = !!look.emphasis || look.kind === "topic" || look.kind === "terminal";
  const block = textBlock(text, fontSize, bold, look.kind === "decision" ? 90 : 120, look.kind === "decision" ? 160 : 220);
  const min = look.kind === "decision" ? { w: 150, h: 100 } : look.kind === "database" ? { w: 130, h: 96 } : { w: 140, h: 60 };
  const size = shapeFor(style.shape, block, min);
  const [fill, stroke] = look.emphasis ? ["#3e63dd", "#3e63dd"] : toneOf(n.color ?? look.tone ?? style.tone)!;
  return {
    id: n.id, ...size, x: 0, y: 0,
    build: (r) => ({
      ...makeShape(style.shape, r), text, fill, stroke, fontSize, bold, strokeWidth: look.emphasis ? 0 : 2,
      color: look.emphasis ? "#ffffff" : "#1e1e1e",
    }),
  };
}

// ---------- layouts ----------

interface LaidOut {
  boxes: Box[];
  /** Group frames in local coordinates. */
  frames: { id: string; title: string; rect: Rect; fill: string }[];
  /** Extra decoration (timeline axis, dots, dates). */
  extras: ((d: Draft, at: (p: Vec) => Vec) => void)[];
  /** Which side of each box edges should prefer: by layout direction. */
  axis: "v" | "h" | "auto";
  /** Bend points (local coordinates) for edges that skip ranks, by edge index, so they go around nodes. */
  routes?: Map<number, Vec[]>;
  route: ArrowEl["route"];
}

function groupOrder(spec: DiagramSpec, nodes: DiagramNode[]): string[] {
  const ids = (spec.groups ?? []).map((g) => g.id);
  for (const n of nodes) if (n.group && !ids.includes(n.group)) ids.push(n.group);
  return ids;
}
const groupTitle = (spec: DiagramSpec, id: string) => spec.groups?.find((g) => g.id === id)?.title ?? id;
function groupFill(spec: DiagramSpec, id: string, i: number) {
  const c = spec.groups?.find((g) => g.id === id)?.color;
  return c ? (toneOf(c)![0] === "#ffffff" ? "#ffffff" : tint(toneOf(c)![0])) : GROUP_FILLS[i % GROUP_FILLS.length];
}
/** Lighter version of a pastel, for large group backgrounds. */
function tint(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.55);
  return `#${[mix(n >> 16), mix((n >> 8) & 255), mix(n & 255)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const FRAME_PAD = 32;
/** Section headings: clearly larger than frame titles at any zoom. */
const HEADING_SIZE = 40;

function framesAround(spec: DiagramSpec, boxes: Box[], nodes: DiagramNode[], pad = FRAME_PAD) {
  return groupOrder(spec, nodes).flatMap((g, i) => {
    const members = boxes.filter((b) => nodes.find((n) => n.id === b.id)?.group === g);
    if (!members.length) return [];
    const x0 = Math.min(...members.map((b) => b.x - b.w / 2)) - pad;
    const y0 = Math.min(...members.map((b) => b.y - b.h / 2)) - pad;
    const x1 = Math.max(...members.map((b) => b.x + b.w / 2)) + pad;
    const y1 = Math.max(...members.map((b) => b.y + b.h / 2)) + pad;
    return [{ id: g, title: groupTitle(spec, g), rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, fill: groupFill(spec, g, i) }];
  });
}

function layered(spec: DiagramSpec, nodes: DiagramNode[], edges: DiagramEdge[], boxes: Box[], scale: number, tree: boolean): LaidOut {
  const dir = spec.direction ?? "down";
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  const labelled = edges.some((e) => e.label);
  g.setGraph({
    rankdir: dir === "right" ? "LR" : "TB",
    nodesep: (tree ? 40 : 60) * scale,
    ranksep: (labelled ? 90 : tree ? 60 : 70) * scale,
    edgesep: 20 * scale,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of boxes) g.setNode(b.id, { width: b.w, height: b.h });
  const groups = groupOrder(spec, nodes);
  for (const gid of groups) g.setNode(`group:${gid}`, {});
  for (const n of nodes) if (n.group) g.setParent(n.id, `group:${n.group}`);
  edges.forEach((e, i) => {
    const w = e.label ? Math.min(180, measureText(e.label, fontString(13)) + 12) : 0;
    g.setEdge(e.from, e.to, { width: w, height: e.label ? 22 : 0, labelpos: "c" }, `e${i}`);
  });
  dagre.layout(g);
  for (const b of boxes) {
    const p = g.node(b.id);
    b.x = p.x;
    b.y = p.y;
  }
  const routes = new Map<number, Vec[]>();
  edges.forEach((e, i) => {
    const pts = (g.edge({ v: e.from, w: e.to, name: `e${i}` })?.points ?? []) as Vec[];
    // Only edges that pass other ranks need help; neighbours connect fine with a plain elbow.
    const inner = pts.slice(1, -1);
    if (inner.length >= 2) routes.set(i, inner.map((p) => ({ x: p.x, y: p.y })));
  });
  // Frames come from the members (plus room for the title bar dagre doesn't know about).
  const frames = framesAround(spec, boxes, nodes);
  return { boxes, frames, extras: [], axis: dir === "right" ? "h" : "v", route: "elbow", routes };
}

function mindmap(nodes: DiagramNode[], boxes: Box[], scale: number): LaidOut {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const kids = new Map<string, string[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
  const root = nodes.find((n) => !n.parent)!;
  const vgap = 22 * scale, hgap = 70 * scale;
  const span = new Map<string, number>();
  const measure = (id: string): number => {
    const c = kids.get(id) ?? [];
    const s = Math.max(byId.get(id)!.h, c.reduce((t, k) => t + measure(k), 0) + vgap * Math.max(0, c.length - 1));
    span.set(id, s);
    return s;
  };
  const place = (id: string, side: 1 | -1) => {
    const b = byId.get(id)!;
    const c = kids.get(id) ?? [];
    let y = b.y - (c.reduce((t, k) => t + span.get(k)!, 0) + vgap * Math.max(0, c.length - 1)) / 2;
    for (const k of c) {
      const kb = byId.get(k)!;
      kb.x = b.x + side * (b.w / 2 + hgap + kb.w / 2);
      kb.y = y + span.get(k)! / 2;
      y += span.get(k)! + vgap;
      place(k, side);
    }
  };
  const top = kids.get(root.id) ?? [];
  top.forEach(measure);
  // Balance the two sides by total height, keeping the given order clockwise from the top right.
  const total = top.reduce((t, k) => t + span.get(k)!, 0);
  const right: string[] = [], left: string[] = [];
  let acc = 0;
  for (const k of top) {
    (acc < total / 2 ? right : left).push(k);
    acc += span.get(k)!;
  }
  left.reverse();
  const rb = byId.get(root.id)!;
  rb.x = 0;
  rb.y = 0;
  for (const [list, side] of [[right, 1], [left, -1]] as const) {
    kids.set(root.id, list);
    place(root.id, side);
  }
  kids.set(root.id, top);
  return { boxes, frames: [], extras: [], axis: "h", route: "curved" };
}

function stackColumns(spec: DiagramSpec, nodes: DiagramNode[], boxes: Box[], scale: number): LaidOut {
  const cols = groupOrder(spec, nodes);
  const loose = nodes.filter((n) => !n.group);
  if (loose.length) cols.push("");
  const gap = 20 * scale, colGap = 60 * scale;
  let x = 0;
  const frames: LaidOut["frames"] = [];
  cols.forEach((gid, i) => {
    const members = boxes.filter((b) => (nodes.find((n) => n.id === b.id)?.group ?? "") === gid);
    const w = Math.max(220, ...members.map((b) => b.w));
    let y = FRAME_PAD;
    for (const b of members) {
      b.x = x + FRAME_PAD + w / 2;
      b.y = y + b.h / 2;
      y += b.h + gap;
    }
    const h = Math.max(160, y - gap + FRAME_PAD);
    frames.push({ id: gid || "other", title: gid ? groupTitle(spec, gid) : "Other", rect: { x, y: 0, w: w + FRAME_PAD * 2, h }, fill: groupFill(spec, gid, i) });
    x += w + FRAME_PAD * 2 + colGap;
  });
  // Equal column heights read as one board.
  const maxH = Math.max(...frames.map((f) => f.rect.h));
  for (const f of frames) f.rect.h = maxH;
  return { boxes, frames, extras: [], axis: "auto", route: "curved" };
}

function gridOf(boxes: Box[], cols: number, gap: number, ox: number, oy: number) {
  const cw = Math.max(...boxes.map((b) => b.w)), ch = Math.max(...boxes.map((b) => b.h));
  boxes.forEach((b, i) => {
    b.x = ox + (i % cols) * (cw + gap) + cw / 2;
    b.y = oy + Math.floor(i / cols) * (ch + gap) + ch / 2;
  });
  const rows = Math.ceil(boxes.length / cols);
  return { w: Math.min(cols, boxes.length) * (cw + gap) - gap, h: rows * (ch + gap) - gap };
}

function grid(spec: DiagramSpec, nodes: DiagramNode[], boxes: Box[], scale: number): LaidOut {
  const gap = 30 * scale;
  const groups = groupOrder(spec, nodes);
  if (!groups.length) {
    gridOf(boxes, Math.ceil(Math.sqrt(boxes.length * 1.6)), gap, 0, 0);
    return { boxes, frames: [], extras: [], axis: "auto", route: "curved" };
  }
  const clusters = [...groups, ...(nodes.some((n) => !n.group) ? [""] : [])];
  const frames: LaidOut["frames"] = [];
  let x = 0, y = 0, rowH = 0;
  const maxRow = 2600 * scale;
  clusters.forEach((gid, i) => {
    const members = boxes.filter((b) => (nodes.find((n) => n.id === b.id)?.group ?? "") === gid);
    const cols = Math.min(3, Math.ceil(Math.sqrt(members.length)));
    const probe = gridOf(members, cols, gap, 0, 0);
    const w = probe.w + FRAME_PAD * 2, h = probe.h + FRAME_PAD * 2;
    if (x > 0 && x + w > maxRow) {
      x = 0;
      y += rowH + 80 * scale;
      rowH = 0;
    }
    gridOf(members, cols, gap, x + FRAME_PAD, y + FRAME_PAD);
    frames.push({ id: gid || "other", title: gid ? groupTitle(spec, gid) : "Other", rect: { x, y, w, h }, fill: groupFill(spec, gid, i) });
    x += w + 60 * scale;
    rowH = Math.max(rowH, h);
  });
  return { boxes, frames, extras: [], axis: "auto", route: "curved" };
}

function timeline(spec: DiagramSpec, nodes: DiagramNode[], boxes: Box[], scale: number): LaidOut {
  // Dates (detail) go on the axis, not inside the cards.
  const maxW = Math.max(...boxes.map((b) => b.w));
  const step = Math.max(150, maxW * 0.55 + 36) * scale;
  const lift = 70 * scale;
  boxes.forEach((b, i) => {
    b.x = i * step;
    b.y = (i % 2 === 0 ? -1 : 1) * (lift + b.h / 2);
  });
  const extras: LaidOut["extras"] = [];
  const x0 = -maxW / 2 - 40, x1 = (boxes.length - 1) * step + maxW / 2 + 60;
  extras.push((d, at) => {
    const a = makeArrow(at({ x: x0, y: 0 }), at({ x: x1, y: 0 }));
    d.set({ ...a, strokeWidth: 3, stroke: "#1e1e1e" });
  });
  nodes.forEach((n, i) => {
    const b = boxes[i];
    const side = i % 2 === 0 ? -1 : 1;
    extras.push((d, at) => {
      const dotR = 9;
      const c = at({ x: b.x, y: 0 });
      const dot = makeShape("ellipse", { x: c.x - dotR, y: c.y - dotR, w: dotR * 2, h: dotR * 2 });
      d.set({ ...dot, fill: "#3e63dd", stroke: "#ffffff", strokeWidth: 3 });
      const stem = makeArrow(at({ x: b.x, y: side * dotR }), at({ x: b.x, y: side * lift }));
      d.set({ ...stem, endHead: "none", stroke: "#9a9a9a", dash: "dashed" });
      if (n.detail) {
        const t = makeText({ x: 0, y: 0 }, null, n.detail);
        const w = Math.max(80, measureText(n.detail, fontString(15, true)) + 16);
        const h = measureTextBlockHeight(n.detail, 15, w, true);
        const p = at({ x: b.x - w / 2, y: side === -1 ? 18 : -18 - h });
        d.set({ ...t, x: p.x, y: p.y, w, h, fontSize: 15, bold: true, align: "center", color: "#3e63dd" });
      }
    });
  });
  // Phases: frames around consecutive nodes of the same group.
  const frames = framesAround(spec, boxes, nodes, 24).map((f) => {
    const top = Math.min(f.rect.y, -lift - 40), bottom = Math.max(f.rect.y + f.rect.h, lift + 40);
    return { ...f, rect: { x: f.rect.x, y: top, w: f.rect.w, h: bottom - top } };
  });
  return { boxes, frames, extras, axis: "v", route: "straight" };
}

// ---------- connectors ----------

/** Bind point on `r` facing `o`, preferring the layout's main axis; back edges loop around the side. */
function endsFor(a: Rect, b: Rect, axis: LaidOut["axis"], branch = false): [[number, number], [number, number]] {
  const ca = center(a), cb = center(b);
  if (axis === "v") {
    // Decisions branch out of their left/right corners, like a classic flowchart.
    if (branch && b.y >= a.y + a.h - 1 && Math.abs(cb.x - ca.x) > a.w / 2) return [[cb.x > ca.x ? 1 : 0, 0.5], [0.5, 0]];
    if (b.y >= a.y + a.h - 1) return [[0.5, 1], [0.5, 0]];
    if (b.y + b.h <= a.y + 1) return ca.x === cb.x || Math.abs(ca.x - cb.x) < (a.w + b.w) / 2 ? [[1, 0.5], [1, 0.5]] : [[0.5, 0], [0.5, 1]];
  } else if (axis === "h") {
    if (branch && b.x >= a.x + a.w - 1 && Math.abs(cb.y - ca.y) > a.h / 2) return [[0.5, cb.y > ca.y ? 1 : 0], [0, 0.5]];
    if (b.x >= a.x + a.w - 1) return [[1, 0.5], [0, 0.5]];
    if (b.x + b.w <= a.x + 1) return [[0, 0.5], [1, 0.5]];
  }
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? [[1, 0.5], [0, 0.5]] : [[0, 0.5], [1, 0.5]];
  return dy >= 0 ? [[0.5, 1], [0.5, 0]] : [[0.5, 0], [0.5, 1]];
}

/** Side of `r` that faces point `p`, preferring the layout axis (or the cross axis, for loops going back). */
function sideToward(r: Rect, p: Vec, axis: LaidOut["axis"], back = false): [number, number] {
  const c = center(r);
  if (back && axis === "v") {
    if (p.x < r.x) return [0, 0.5];
    if (p.x > r.x + r.w) return [1, 0.5];
  } else if (back && axis === "h") {
    if (p.y < r.y) return [0.5, 0];
    if (p.y > r.y + r.h) return [0.5, 1];
  }
  if (axis !== "h") {
    if (p.y > r.y + r.h) return [0.5, 1];
    if (p.y < r.y) return [0.5, 0];
  } else {
    if (p.x > r.x + r.w) return [1, 0.5];
    if (p.x < r.x) return [0, 0.5];
  }
  const dx = p.x - c.x, dy = p.y - c.y;
  if (Math.abs(dx) * r.h >= Math.abs(dy) * r.w) return dx >= 0 ? [1, 0.5] : [0, 0.5];
  return dy >= 0 ? [0.5, 1] : [0.5, 0];
}

const bindAt = (el: BoardElement, [u, v]: [number, number]): ArrowEnd => ({ x: el.x + u * el.w, y: el.y + v * el.h, bind: { id: el.id, u, v } });

/** Ends plus, when given bend points, a stored elbow route through them. */
function routed(a: BoardElement, b: BoardElement, axis: LaidOut["axis"], bends?: Vec[]): Pick<ArrowEl, "start" | "end" | "via"> {
  if (!bends?.length) {
    const [start, end] = connect(a, b, axis);
    return { start, end, via: null };
  }
  // A loop back against the flow direction leaves and enters from the side, clear of the main line.
  const back = axis === "v" ? b.y + b.h <= a.y : axis === "h" ? b.x + b.w <= a.x : false;
  const start = bindAt(a, sideToward(boxOf(a), bends[0], axis, back));
  const end = bindAt(b, sideToward(boxOf(b), bends[bends.length - 1], axis, back));
  return {
    start, end,
    via: { points: bends.map((p) => ({ x: p.x - start.x, y: p.y - start.y })), span: { x: end.x - start.x, y: end.y - start.y } },
  };
}

function connect(a: BoardElement, b: BoardElement, axis: LaidOut["axis"]): [ArrowEnd, ArrowEnd] {
  const branch = a.type === "shape" && a.kind === "diamond";
  const [[u1, v1], [u2, v2]] = endsFor(boxOf(a), boxOf(b), axis, branch);
  return [
    { x: a.x + u1 * a.w, y: a.y + v1 * a.h, bind: { id: a.id, u: u1, v: v1 } },
    { x: b.x + u2 * b.w, y: b.y + v2 * b.h, bind: { id: b.id, u: u2, v: v2 } },
  ];
}

// ---------- create_diagram ----------

const LAYOUTS: Layout[] = ["flow", "tree", "mindmap", "columns", "grid", "timeline"];
const KINDS: NodeKind[] = ["process", "decision", "terminal", "io", "database", "service", "user", "external", "queue", "card", "note", "topic", "text"];

function validate(spec: DiagramSpec): { layout: Layout; nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const layout = spec.layout ?? "flow";
  if (!LAYOUTS.includes(layout)) throw new Error(`Unknown layout "${layout}". Use: ${LAYOUTS.join(", ")}`);
  const nodes = spec.nodes;
  if (!Array.isArray(nodes) || !nodes.length) throw new Error("`nodes` must be a non-empty array");
  if (nodes.length > 400) throw new Error("At most 400 nodes per diagram; split it into several diagrams");
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || !n.id) throw new Error("Every node needs a string `id`");
    if (ids.has(n.id)) throw new Error(`Duplicate node id "${n.id}"`);
    if (typeof n.text !== "string") throw new Error(`Node "${n.id}" needs \`text\``);
    if (n.kind && !KINDS.includes(n.kind)) throw new Error(`Unknown node kind "${n.kind}". Use: ${KINDS.join(", ")}`);
    ids.add(n.id);
  }
  for (const n of nodes) if (n.parent && !ids.has(n.parent)) throw new Error(`Node "${n.id}" has unknown parent "${n.parent}"`);
  const edges = [...(spec.edges ?? [])];
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`Edge ${e.from} → ${e.to} refers to an unknown node id`);
  }
  if (layout === "tree" || layout === "mindmap") {
    const roots = nodes.filter((n) => !n.parent);
    if (layout === "mindmap" && roots.length !== 1) throw new Error(`A mindmap needs exactly one root (a node without \`parent\`); found ${roots.length}`);
    for (const n of nodes) {
      if (n.parent) edges.unshift({ from: n.parent, to: n.id });
      // Walk up to catch cycles, which would never finish laying out.
      const seen = new Set<string>();
      for (let p: DiagramNode | undefined = n; p?.parent; p = nodes.find((m) => m.id === p!.parent)) {
        if (seen.has(p.id)) throw new Error(`Parent links form a cycle at "${p.id}"`);
        seen.add(p.id);
      }
    }
  }
  return { layout, nodes, edges };
}

function looks(layout: Layout, nodes: DiagramNode[]): Map<string, NodeLook> {
  const out = new Map<string, NodeLook>();
  if (layout === "mindmap") {
    const root = nodes.find((n) => !n.parent)!;
    const branchOf = (n: DiagramNode): string => {
      let p = n;
      while (p.parent && p.parent !== root.id) p = nodes.find((m) => m.id === p.parent)!;
      return p.id;
    };
    const branches = nodes.filter((n) => n.parent === root.id).map((n) => n.id);
    for (const n of nodes) {
      if (n === root) out.set(n.id, { kind: n.kind ?? "topic", emphasis: !n.kind && !n.color });
      else out.set(n.id, { kind: n.kind ?? "topic", tone: BRANCH_TONES[branches.indexOf(branchOf(n)) % BRANCH_TONES.length] });
    }
    return out;
  }
  for (const n of nodes) out.set(n.id, { kind: n.kind ?? DEFAULT_KIND[layout] });
  return out;
}

/** Where the diagram's top-left goes: explicit point, beside an element, right of the board, or the view centre. */
function origin(editor: Editor, spec: DiagramSpec, size: { w: number; h: number }): Vec {
  const doc = editor.doc;
  const p = spec.place;
  if (p && "x" in p) {
    if (typeof p.x !== "number" || typeof p.y !== "number") throw new Error("`place` needs numeric x and y");
    return { x: p.x, y: p.y };
  }
  if (p && "near" in p) {
    const el = doc.elements[p.near];
    if (!el) throw new Error(`\`place.near\`: unknown element id "${p.near}"`);
    const b = sectionBounds(doc, el);
    const gap = p.gap ?? 160;
    switch (p.side ?? "right") {
      case "right": return { x: b.x + b.w + gap, y: b.y };
      case "left": return { x: b.x - gap - size.w, y: b.y };
      case "below": return { x: b.x, y: b.y + b.h + gap };
      case "above": return { x: b.x, y: b.y - gap - size.h };
    }
  }
  const all = selectionBounds(doc, doc.order);
  if (all) return { x: all.x + all.w + 200, y: all.y };
  const c = editor.viewportCenter();
  return { x: c.x - size.w / 2, y: c.y - size.h / 2 };
}

/** Elements built as one section: tagged with the section's id (its frame, heading or first node). */
export function sectionMembers(doc: Editor["doc"], id: string): BoardElement[] {
  const el = doc.elements[id];
  const tag = el?.section ?? id;
  return doc.order.map((i) => doc.elements[i]).filter((e) => e && e.section === tag);
}

const boundsOf = (doc: Editor["doc"], el: BoardElement) => (el.type === "frame" ? withTitle(el, boxOf(el)) : elementBounds(doc, el));

/**
 * The section an element belongs to: everything within reach of it (a heading and the group frames
 * under it, a frame and its contents). Sections are placed well apart, so the cluster stops at the gap.
 */
function sectionBounds(doc: Editor["doc"], el: BoardElement): Rect {
  const members = sectionMembers(doc, el.id);
  if (members.length) {
    const rs = members.map((m) => boundsOf(doc, m));
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  }
  // Not built by create_diagram: the cluster of things around it.
  const reach = 70;
  let r = boundsOf(doc, el);
  const others = doc.order.map((id) => doc.elements[id]).filter((o) => o && o.id !== el.id && o.type !== "arrow").map((o) => boundsOf(doc, o));
  for (let grew = true; grew; ) {
    grew = false;
    const zone = { x: r.x - reach, y: r.y - reach, w: r.w + reach * 2, h: r.h + reach * 2 };
    for (const o of others) {
      if (!rectsIntersect(zone, o)) continue;
      const x = Math.min(r.x, o.x), y = Math.min(r.y, o.y);
      const n = { x, y, w: Math.max(r.x + r.w, o.x + o.w) - x, h: Math.max(r.y + r.h, o.y + o.h) - y };
      if (n.w > r.w + 0.5 || n.h > r.h + 0.5) {
        r = n;
        grew = true;
      }
    }
  }
  return r;
}

/** Frame titles are drawn above the frame; count that space when placing things. */
function withTitle(f: FrameEl | { title: string; rect: Rect }, r: Rect): Rect {
  if (!f.title) return r;
  const t = frameTitleRect({ ...(f as FrameEl), ...r }, 0.01);
  return { x: r.x, y: t.y, w: r.w, h: r.y + r.h - t.y };
}

export function createDiagram(editor: Editor, spec: DiagramSpec) {
  const { layout, nodes, edges } = validate(spec);
  const scale = spec.spacing === "compact" ? 0.75 : spec.spacing === "roomy" ? 1.4 : 1;
  const look = looks(layout, nodes);
  const boxes = nodes.map((n) => nodeBox(n, look.get(n.id)!, layout !== "timeline"));

  let laid: LaidOut;
  let note: string | undefined;
  if (layout === "flow" && edges.length === 0) {
    laid = grid(spec, nodes, boxes, scale);
    note = "No edges were given, so the nodes were laid out as a grid.";
  } else if (layout === "flow" || layout === "tree") laid = layered(spec, nodes, edges, boxes, scale, layout === "tree");
  else if (layout === "mindmap") laid = mindmap(nodes, boxes, scale);
  else if (layout === "columns") laid = stackColumns(spec, nodes, boxes, scale);
  else if (layout === "grid") laid = grid(spec, nodes, boxes, scale);
  else laid = timeline(spec, nodes, boxes, scale);

  // Local bounds of everything, including frame title bars.
  const rects: Rect[] = [
    ...laid.boxes.map((b) => ({ x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h })),
    ...laid.frames.map((f) => withTitle(f, f.rect)),
  ];
  let minX = Math.min(...rects.map((r) => r.x)), minY = Math.min(...rects.map((r) => r.y));
  let maxX = Math.max(...rects.map((r) => r.x + r.w)), maxY = Math.max(...rects.map((r) => r.y + r.h));
  if (layout === "timeline") {
    minX -= 60;
    maxX += 60;
  }

  // A titled diagram gets a heading. Without group frames it also gets a section frame holding the
  // heading and the diagram, so the section moves as one; with group frames (frames don't nest) the
  // heading sits above them.
  const pad = 48;
  const outer = !!spec.title && !laid.frames.length;
  const headingH = spec.title ? HEADING_SIZE * 1.3 + 24 : 0;
  const headingAt = { x: minX, y: minY - headingH };
  minY -= headingH;
  if (outer) {
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
  }
  const size = { w: maxX - minX, h: maxY - minY };
  // Replacing a section: everything in it goes, and the new diagram takes its top-left corner.
  let victims: string[] = [];
  let o: Vec;
  if (spec.replace) {
    const old = editor.doc.elements[spec.replace];
    if (!old) throw new Error(`\`replace\`: unknown element id "${spec.replace}"`);
    const r = sectionBounds(editor.doc, old);
    const inside = { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 };
    const members = sectionMembers(editor.doc, old.id);
    victims = members.length ? members.map((m) => m.id) : editor.doc.order.filter((id) => {
      const el = editor.doc.elements[id];
      const b = boundsOf(editor.doc, el);
      return b.x >= inside.x && b.y >= inside.y && b.x + b.w <= inside.x + inside.w && b.y + b.h <= inside.y + inside.h;
    });
    o = spec.place ? origin(editor, spec, size) : { x: r.x, y: r.y };
  } else o = origin(editor, spec, size);
  const dx = o.x - minX, dy = o.y - minY;
  const at = (p: Vec): Vec => ({ x: p.x + dx, y: p.y + dy });

  const created = new Map<string, string>();
  const frameIds: Record<string, string> = {};
  let outerId: string | undefined, headingId: string | undefined, sectionId = "";
  const all: string[] = [];

  editor.store.transact((d) => {
    if (victims.length) {
      // Things the user put inside the old section's frames stay on the board.
      const gone = new Set(victims);
      for (const id of d.doc.order) {
        const el = d.get(id)!;
        if (!gone.has(id) && el.parentId && gone.has(el.parentId)) d.patch(id, { parentId: null });
      }
      deleteElements(d, victims);
    }
    if (outer) {
      const p = at({ x: minX, y: minY });
      // Untitled: the heading inside names the section.
      const f = makeFrame({ x: p.x, y: p.y, w: maxX - minX, h: maxY - minY }, "");
      d.insert(f, 0);
      outerId = f.id;
      all.push(f.id);
    }
    for (const fr of laid.frames) {
      const p = at(fr.rect);
      const f = makeFrame({ x: p.x, y: p.y, w: fr.rect.w, h: fr.rect.h }, fr.title);
      d.insert({ ...f, fill: fr.fill }, 0);
      frameIds[fr.id] = f.id;
      all.push(f.id);
    }
    if (headingH) {
      const p = at(headingAt);
      const t = makeText(p, null, spec.title!);
      const w = Math.max(200, measureText(spec.title!, fontString(HEADING_SIZE, true)) + 24);
      d.set({ ...t, x: p.x, y: p.y, w, h: measureTextBlockHeight(spec.title!, HEADING_SIZE, w, true), fontSize: HEADING_SIZE, bold: true });
      headingId = t.id;
      all.push(t.id);
    }
    for (const b of laid.boxes) {
      const p = at({ x: b.x - b.w / 2, y: b.y - b.h / 2 });
      const el = b.build({ x: p.x, y: p.y, w: b.w, h: b.h });
      d.set(el);
      created.set(b.id, el.id);
      all.push(el.id);
    }
    for (const x of laid.extras) x(d, at);
    edges.forEach((e, i) => {
      const a = d.get(created.get(e.from)!)!, b = d.get(created.get(e.to)!)!;
      const arrow = makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 });
      const bends = !e.route || e.route === "elbow" ? laid.routes?.get(i)?.map(at) : undefined;
      const ends = a === b
        ? { start: bindAt(a, [1, 0.5]), end: bindAt(a, [0.5, 0]), via: null }
        : routed(a, b, laid.axis, bends);
      const el: ArrowEl = {
        ...arrow, ...ends, route: bends ? "elbow" : e.route ?? laid.route, label: e.label ?? "", dash: e.style ?? "solid",
        startHead: e.bidirectional ? "filled" : "none", stroke: layout === "mindmap" ? "#9a9a9a" : arrow.stroke,
        endHead: layout === "mindmap" ? "none" : "filled",
      };
      d.set(el);
      all.push(el.id);
    });
    const fresh = d.doc.order.filter((id) => all.includes(id) || !(id in editor.doc.elements));
    sectionId = outerId ?? headingId ?? created.values().next().value!;
    for (const id of fresh) d.patch(id, { section: sectionId });
    for (const f of [outerId, ...Object.values(frameIds)]) if (f) recaptureFrame(d, f);
    assignFrames(d, fresh.filter((id) => d.get(id)?.type !== "frame"));
  });

  const doc = editor.doc;
  const fresh = doc.order.filter((id) => doc.elements[id] && all.includes(id));
  const bounds = selectionBounds(doc, fresh)!;
  const overlaps = doc.order.filter((id) => {
    const el = doc.elements[id];
    return el && !all.includes(id) && el.type !== "arrow" && !isAncestorFrameOf(el, fresh, doc) && rectsIntersect(elementBounds(doc, el), bounds);
  }).length;
  if (spec.focus !== false) editor.zoomToFit(fresh);

  const round = (n: number) => Math.round(n);
  return {
    layout,
    // The handle for this section: its frame, or its heading when the groups are the frames.
    section: sectionId,
    nodes: Object.fromEntries(created),
    ...(Object.keys(frameIds).length ? { groups: frameIds } : {}),
    bounds: { x: round(bounds.x), y: round(bounds.y), w: round(bounds.w), h: round(bounds.h) },
    ...(overlaps ? { warning: `Overlaps ${overlaps} existing element(s). Move it with update_elements or place the next diagram with place.near.` } : {}),
    ...(victims.length ? { replaced: victims.length } : {}),
    ...(note ? { note } : {}),
  };
}

function isAncestorFrameOf(el: BoardElement, ids: string[], doc: Editor["doc"]) {
  return el.type === "frame" && ids.some((id) => doc.elements[id]?.parentId === el.id);
}

// ---------- arrange_elements ----------

export interface ArrangeSpec {
  ids?: string[];
  frame?: string;
  layout?: "flow" | "tree" | "grid" | "row" | "column";
  direction?: Direction;
  spacing?: DiagramSpec["spacing"];
  columns?: number;
}

/** Re-lays out existing elements, using the connectors between them as edges. Connectors re-attach. */
export function arrangeElements(editor: Editor, spec: ArrangeSpec) {
  const doc = editor.doc;
  const layout = spec.layout ?? "flow";
  let frame: FrameEl | undefined;
  if (spec.frame) {
    const f = doc.elements[spec.frame];
    if (!f || f.type !== "frame") throw new Error(`\`frame\`: "${spec.frame}" is not a frame`);
    frame = f;
  }
  const ids = spec.ids ?? (frame ? doc.order.filter((id) => doc.elements[id]?.parentId === frame!.id) : []);
  if (!ids.length) throw new Error("Pass `ids` (elements to arrange) or `frame`");
  const missing = ids.filter((id) => !doc.elements[id]);
  if (missing.length) throw new Error(`Unknown element ids: ${missing.join(", ")}`);
  const items = ids.map((id) => doc.elements[id]).filter((el) => el.type !== "arrow" && el.type !== "frame");
  if (!items.length) throw new Error("Nothing to arrange: connectors and frames move with the elements they belong to");
  const set = new Set(items.map((e) => e.id));
  const arrows = doc.order.map((id) => doc.elements[id]).filter((el): el is ArrowEl =>
    el?.type === "arrow" && !!el.start.bind && !!el.end.bind && set.has(el.start.bind.id) && set.has(el.end.bind.id));

  const scale = spec.spacing === "compact" ? 0.75 : spec.spacing === "roomy" ? 1.4 : 1;
  const boxes: Box[] = items.map((el) => ({ id: el.id, w: el.w, h: el.h, x: 0, y: 0, build: () => el }));
  let axis: LaidOut["axis"] = "auto";
  let routes: Map<number, Vec[]> | undefined;
  if ((layout === "flow" || layout === "tree") && arrows.length) {
    const nodes = items.map((el) => ({ id: el.id, text: "" }));
    const edges = arrows.map((a) => ({ from: a.start.bind!.id, to: a.end.bind!.id, label: a.label }));
    ({ axis, routes } = layered({ direction: spec.direction }, nodes, edges, boxes, scale, layout === "tree"));
  } else {
    const gap = 40 * scale;
    const cols = layout === "row" ? items.length : layout === "column" ? 1 : spec.columns ?? Math.ceil(Math.sqrt(items.length * 1.6));
    if (layout === "row" || layout === "column") {
      let pos = 0;
      for (const b of boxes) {
        if (layout === "row") [b.x, b.y] = [pos + b.w / 2, 0];
        else [b.x, b.y] = [0, pos + b.h / 2];
        pos += (layout === "row" ? b.w : b.h) + gap;
      }
    } else gridOf(boxes, cols, gap, 0, 0);
  }

  const before = selectionBounds(doc, items.map((e) => e.id))!;
  const anchor = frame ? { x: frame.x + FRAME_PAD, y: frame.y + FRAME_PAD } : { x: before.x, y: before.y };
  const minX = Math.min(...boxes.map((b) => b.x - b.w / 2)), minY = Math.min(...boxes.map((b) => b.y - b.h / 2));

  editor.store.transact((d) => {
    for (const b of boxes) d.patch(b.id, { x: anchor.x + b.x - b.w / 2 - minX, y: anchor.y + b.y - b.h / 2 - minY });
    const shift = (p: Vec) => ({ x: anchor.x + p.x - minX, y: anchor.y + p.y - minY });
    arrows.forEach((a, i) => {
      const bends = routes?.get(i)?.map(shift);
      d.patch<ArrowEl>(a.id, { ...routed(d.get(a.start.bind!.id)!, d.get(a.end.bind!.id)!, axis, bends), ...(bends ? { route: "elbow" } : {}) });
    });
    if (frame) {
      const r = selectionBounds(d.doc, [...set])!;
      d.patch(frame.id, { w: Math.max(frame.w, r.x + r.w + FRAME_PAD - frame.x), h: Math.max(160, r.y + r.h + FRAME_PAD - frame.y) });
      recaptureFrame(d, frame.id);
    }
    assignFrames(d, [...set]);
  });
  const after = selectionBounds(editor.doc, [...set])!;
  return { arranged: items.length, connectorsRerouted: arrows.length, bounds: { x: Math.round(after.x), y: Math.round(after.y), w: Math.round(after.w), h: Math.round(after.h) } };
}
