import type { Vec } from "./geom";

export type ElementType = "shape" | "sticky" | "text" | "frame" | "image" | "stroke" | "arrow";
export type ShapeKind = "rect" | "roundrect" | "ellipse" | "diamond" | "triangle" | "hexagon" | "parallelogram" | "cylinder";
export const SHAPE_KINDS: readonly ShapeKind[] = ["rect", "roundrect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "cylinder"];
export type TextAlign = "left" | "center" | "right";
export type ArrowRoute = "straight" | "elbow" | "curved";
export type ArrowHead = "none" | "open" | "filled";
export type Dash = "solid" | "dashed" | "dotted";

interface Base {
  id: string;
  /** Top-left of the un-rotated box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, clockwise, around the box centre. */
  angle: number;
  /** Frame this element belongs to (frames themselves never have a parent). */
  parentId: string | null;
  locked?: boolean;
  /** Diagram section this element was built in (by an assistant), so the section can be found and replaced whole. */
  section?: string;
}

export interface TextStyle {
  fontSize: number;
  color: string;
  align: TextAlign;
  bold?: boolean;
  italic?: boolean;
}

export interface ShapeEl extends Base, TextStyle {
  type: "shape";
  kind: ShapeKind;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  text: string;
}

export interface StickyEl extends Base {
  type: "sticky";
  fill: string;
  text: string;
  color: string;
  align: TextAlign;
}

export interface TextEl extends Base, TextStyle {
  type: "text";
  text: string;
}

export interface FrameEl extends Base {
  type: "frame";
  title: string;
  fill: string;
}

export interface ImageEl extends Base {
  type: "image";
  /** Key into the asset table. */
  assetId: string;
}

export interface StrokeEl extends Base {
  type: "stroke";
  /** Points relative to (x, y), in the element's original size (scaled by w/baseW, h/baseH). */
  points: Vec[];
  baseW: number;
  baseH: number;
  color: string;
  width: number;
  opacity: number;
  highlighter: boolean;
}

/** An endpoint either floats at a world position or is bound to an element at normalised local coords. */
export interface ArrowEnd {
  x: number;
  y: number;
  bind?: { id: string; u: number; v: number } | null;
}

export interface ArrowEl extends Base {
  type: "arrow";
  start: ArrowEnd;
  end: ArrowEnd;
  route: ArrowRoute;
  startHead: ArrowHead;
  endHead: ArrowHead;
  stroke: string;
  strokeWidth: number;
  dash: Dash;
  label: string;
  /** Position of the label along the path, 0..1. */
  labelT: number;
  /**
   * Elbow route from auto-layout: bend points relative to the start, valid while the end stays at
   * `span` from the start (moving the whole diagram keeps it; moving one end falls back to auto routing).
   */
  via?: { points: Vec[]; span: Vec } | null;
}

export type BoardElement = ShapeEl | StickyEl | TextEl | FrameEl | ImageEl | StrokeEl | ArrowEl;

export interface Asset {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface BoardSettings {
  background: string;
  grid: "lines" | "dots" | "none";
  wheel: "pan" | "zoom";
  snapping: boolean;
}

export interface Doc {
  title: string;
  elements: Readonly<Record<string, BoardElement>>;
  /** Paint order, bottom first. Frames are painted before everything else regardless of position. */
  order: readonly string[];
  assets: Readonly<Record<string, Asset>>;
  settings: BoardSettings;
}

export const DEFAULT_SETTINGS: BoardSettings = { background: "#f7f7f5", grid: "lines", wheel: "pan", snapping: true };

export function emptyDoc(): Doc {
  return { title: "Untitled board", elements: {}, order: [], assets: {}, settings: { ...DEFAULT_SETTINGS } };
}

export const PALETTE = [
  "#1e1e1e", "#ffffff", "#ffd966", "#ffb38a", "#ff8fa3", "#c9a7ff",
  "#8ec5ff", "#7fe0c3", "#b5e48c", "#e0e0e0", "#e5484d", "#3e63dd",
];

export const STICKY_COLORS = ["#fff3a3", "#ffd1a8", "#ffc4d0", "#e2cfff", "#c7e3ff", "#c4f0dd", "#dff5bf", "#ececec"];

export const STROKE_WIDTHS = [1, 2, 4, 8, 16, 32];

export function isTextual(el: BoardElement): el is ShapeEl | StickyEl | TextEl {
  return el.type === "shape" || el.type === "sticky" || el.type === "text";
}

export function canRotate(el: BoardElement): boolean {
  return el.type !== "frame" && el.type !== "arrow";
}

let counter = 0;
export function newId(): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
  return rnd;
}
