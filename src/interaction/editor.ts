import {
  clampZoom, fitRect, nextZoomStep, screenToWorld, visibleWorldRect, worldToScreen, zoomAt, type Camera,
} from "../core/camera";
import {
  arrowGeometry, arrowLabelRect, elementAt, elementBounds, endPoint, findBinding, frameFor, frameTitleRect, hitTest,
  nearestT, strokeWorldPoints,
} from "../core/elements";
import {
  dist, expandRect, pointInRect, rectContainsRect, rectFromPoints, rectsIntersect, rotate, segmentIntersectsRect, simplify,
  smoothStroke, sub, type Rect, type Vec,
} from "../core/geom";
import { isTextual, type ArrowEl, type ArrowEnd, type BoardElement, type Doc, type ShapeKind } from "../core/model";
import {
  assignFrames, DEFAULTS, deleteElements, duplicate, makeArrow, makeFrame, makeShape, makeSticky, makeStroke, makeText,
  moveFrom, nextFrameTitle, pastePayload, patchStyle, recaptureFrame, reorder, selectionBounds, serializeSelection,
  setText, withFrameChildren, type ClipboardPayload, type ZMove,
} from "../core/ops";
import { handleWorld, rotateHandleWorld, transformBox, type TransformBox } from "../core/selection";
import { snapRect, SNAP_SCREEN_PX } from "../core/snap";
import type { Store } from "../core/store";
import { handlesFor, resizeGroup, resizeSingle, rotateGroup, snapRotation, type Handle } from "../core/transform";
import { emptyOverlay, type Overlay } from "../canvas/render";

export type Tool = "select" | "hand" | "text" | "sticky" | "shape" | "frame" | "arrow" | "pen" | "marker" | "eraser";

export interface PointerInput {
  screen: Vec;
  button: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
}

export interface KeyInput {
  key: string;
  code: string;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  repeat: boolean;
}

type Gesture =
  | { kind: "pan"; start: Vec; cam: Camera }
  | { kind: "marquee"; start: Vec; base: Set<string> }
  | { kind: "move"; start: Vec; from: Doc; ids: Set<string>; top: string[]; bounds: Rect; candidates: Rect[]; moved: boolean; startScreen: Vec }
  | { kind: "resize"; from: Doc; tb: TransformBox; handle: Handle; ids: string[] }
  | { kind: "rotate"; from: Doc; pivot: Vec; startAngle: number; ids: string[]; single: BoardElement | null }
  | { kind: "create-box"; start: Vec; startScreen: Vec; id: string | null; what: "shape" | "frame" }
  | { kind: "create-arrow"; start: Vec; startScreen: Vec; startEnd: ArrowEnd; id: string | null }
  | { kind: "arrow-end"; id: string; which: "start" | "end" }
  | { kind: "label"; id: string }
  | { kind: "draw"; points: Vec[]; lastScreen: Vec; straight: boolean }
  | { kind: "erase"; last: Vec };

const DRAG_THRESHOLD = 3; // screen px
const DOUBLE_CLICK_MS = 350;
const HANDLE_HIT = 9; // screen px

export interface EditorPrefs {
  shapeKind: ShapeKind;
  stickyFill: string;
  penColor: string;
  penWidth: number;
  markerColor: string;
  markerWidth: number;
}

export class Editor {
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  tool: Tool = "select";
  selection = new Set<string>();
  editingId: string | null = null;
  overlay: Overlay = emptyOverlay();
  cursor = "default";
  viewW = 1;
  viewH = 1;
  prefs: EditorPrefs = {
    shapeKind: "rect", stickyFill: DEFAULTS.sticky.fill,
    penColor: DEFAULTS.pen.color, penWidth: DEFAULTS.pen.width,
    markerColor: DEFAULTS.marker.color, markerWidth: DEFAULTS.marker.width,
  };
  /** Increments whenever UI-relevant state changes. */
  version = 0;

  private gesture: Gesture | null = null;
  private spaceTool: Tool | null = null;
  private lastDown = { t: 0, p: { x: 0, y: 0 } };
  private lastPointer: Vec = { x: 0, y: 0 };
  private listeners = new Set<() => void>();
  private renderRequested = false;
  onRender: (() => void) | null = null;
  /** Set by the canvas host: renders the current view to a data URL (used by AI screenshots). */
  capture: ((maxWidth: number, format?: "png" | "jpeg", region?: Rect) => Promise<string>) | null = null;
  /** Id of the stored board this editor shows. */
  boardId = "default";
  /** Called (and awaited) before large deletions so a restore point exists. */
  beforeDestructive: ((reason: string) => Promise<void>) | null = null;

  constructor(readonly store: Store) {
    store.subscribe(() => {
      // Drop selection entries that no longer exist (e.g. after undo).
      for (const id of this.selection) if (!store.doc.elements[id]) this.selection.delete(id);
      if (this.editingId && !store.doc.elements[this.editingId]) this.editingId = null;
      this.changed();
    });
  }

  get doc() {
    return this.store.doc;
  }

  /** True while a pointer gesture (drag, resize, draw…) is in progress. */
  get interacting() {
    return this.gesture !== null && this.gesture.kind !== "marquee";
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notifies the UI and schedules a canvas repaint. */
  changed() {
    this.version++;
    for (const fn of this.listeners) fn();
    this.requestRender();
  }

  requestRender() {
    if (this.renderRequested) return;
    this.renderRequested = true;
    requestAnimationFrame(() => {
      this.renderRequested = false;
      this.overlay.selection = this.selection;
      this.overlay.editingId = this.editingId;
      this.onRender?.();
    });
  }

  toWorld = (p: Vec) => screenToWorld(this.camera, p);
  toScreen = (p: Vec) => worldToScreen(this.camera, p);

  // ---------- camera ----------

  setCamera(c: Camera) {
    this.camera = { ...c, zoom: clampZoom(c.zoom) };
    this.changed();
  }

  zoomStep(dir: 1 | -1, at: Vec = { x: this.viewW / 2, y: this.viewH / 2 }) {
    this.setCamera(zoomAt(this.camera, at, nextZoomStep(this.camera.zoom, dir)));
  }

  zoomTo(zoom: number) {
    this.setCamera(zoomAt(this.camera, { x: this.viewW / 2, y: this.viewH / 2 }, zoom));
  }

  zoomToFit(ids?: Iterable<string>) {
    const r = selectionBounds(this.doc, ids ?? this.doc.order);
    if (!r) return this.setCamera({ x: this.viewW / 2, y: this.viewH / 2, zoom: 1 });
    this.setCamera(fitRect(r, this.viewW, this.viewH));
  }

  onWheel(screen: Vec, dx: number, dy: number, ctrl: boolean, shift: boolean) {
    const zoomGesture = ctrl || this.doc.settings.wheel === "zoom";
    if (zoomGesture) {
      // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels send ~100 per notch.
      const d = Math.max(-50, Math.min(50, dy));
      this.setCamera(zoomAt(this.camera, screen, this.camera.zoom * Math.exp(-d * (ctrl ? 0.01 : 0.004))));
    } else {
      const [px, py] = shift && dx === 0 ? [dy, 0] : [dx, dy];
      this.setCamera({ ...this.camera, x: this.camera.x - px, y: this.camera.y - py });
    }
  }

  // ---------- tools & selection ----------

  setTool(tool: Tool) {
    if (this.editingId) this.stopEditing();
    this.tool = tool;
    if (tool !== "select" && tool !== "hand") this.selection = new Set();
    this.updateCursor();
    this.changed();
  }

  select(ids: Iterable<string>) {
    this.selection = new Set(ids);
    this.changed();
  }

  selectAll() {
    this.select(this.doc.order.filter((id) => !this.doc.elements[id]?.locked));
  }

  get selectedElements(): BoardElement[] {
    return [...this.selection].map((id) => this.doc.elements[id]).filter(Boolean) as BoardElement[];
  }

  // ---------- text editing ----------

  startEditing(id: string) {
    const el = this.doc.elements[id];
    if (!el || el.locked) return;
    if (!(isTextual(el) || el.type === "frame" || el.type === "arrow")) return;
    if (this.editingId) this.stopEditing();
    this.selection = new Set([id]);
    this.editingId = id;
    this.store.begin();
    this.changed();
  }

  /** Live update while typing; folded into the edit's single undo step. */
  editText(text: string) {
    if (!this.editingId) return;
    const id = this.editingId;
    this.store.update((d) => setText(d, id, text));
  }

  stopEditing() {
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;
    const el = this.doc.elements[id];
    // Empty free-text boxes disappear, like most whiteboards.
    if (el?.type === "text" && !el.text.trim()) {
      this.store.update((d) => d.remove(id));
      this.selection.delete(id);
    }
    this.store.commit();
    this.changed();
  }

  // ---------- pointer ----------

  pointerDown(e: PointerInput) {
    this.lastPointer = e.screen;
    const p = this.toWorld(e.screen);
    const now = performance.now();
    const isDouble = now - this.lastDown.t < DOUBLE_CLICK_MS && dist(e.screen, this.lastDown.p) < 6;
    this.lastDown = { t: isDouble ? 0 : now, p: e.screen };

    if (this.editingId) this.stopEditing();

    // Middle button, right button or the hand tool always pan.
    if (e.button === 1 || e.button === 2 || this.tool === "hand") {
      this.gesture = { kind: "pan", start: e.screen, cam: this.camera };
      this.cursor = "grabbing";
      return this.changed();
    }
    if (e.button !== 0) return;

    if (isDouble && this.tool === "select") return this.doubleClick(p);

    switch (this.tool) {
      case "select":
        return this.selectDown(e, p);
      case "text": {
        const parent = frameFor(this.doc, { x: p.x, y: p.y, w: 1, h: 1 });
        this.tool = "select";
        return this.createAndEdit(makeText(p, parent?.id ?? null));
      }
      case "sticky": {
        this.tool = "select";
        return this.createAndEdit(makeSticky(p, null, this.prefs.stickyFill));
      }
      case "shape":
      case "frame":
        this.gesture = { kind: "create-box", start: p, startScreen: e.screen, id: null, what: this.tool };
        return;
      case "arrow": {
        const b = findBinding(this.doc, p, this.camera.zoom);
        const startEnd: ArrowEnd = b ? { x: b.point.x, y: b.point.y, bind: { id: b.id, u: b.u, v: b.v } } : { x: p.x, y: p.y };
        this.gesture = { kind: "create-arrow", start: p, startScreen: e.screen, startEnd, id: null };
        return;
      }
      case "pen":
      case "marker":
        this.gesture = { kind: "draw", points: [p], lastScreen: e.screen, straight: e.shift };
        this.overlay.liveStroke = this.liveStyle([p]);
        return this.requestRender();
      case "eraser":
        this.gesture = { kind: "erase", last: p };
        this.eraseAlong(p, p);
        return;
    }
  }

  private liveStyle(points: Vec[]) {
    return this.tool === "marker"
      ? { points, color: this.prefs.markerColor, width: this.prefs.markerWidth, opacity: DEFAULTS.marker.opacity }
      : { points, color: this.prefs.penColor, width: this.prefs.penWidth, opacity: 1 };
  }

  /** Creation and the first edit form a single undo step, so an abandoned empty text leaves no trace. */
  private createAndEdit(el: BoardElement) {
    this.store.begin();
    this.store.update((d) => {
      d.set(el);
      assignFrames(d, [el.id]);
    });
    this.startEditing(el.id);
  }

  private doubleClick(p: Vec) {
    const z = this.camera.zoom;
    // Frame titles first: they sit outside the frame body.
    for (const id of [...this.doc.order].reverse()) {
      const el = this.doc.elements[id];
      if (el?.type === "frame" && pointInRect(p, frameTitleRect(el, z))) return this.startEditing(el.id);
    }
    const hit = elementAt(this.doc, p, z);
    if (hit && (isTextual(hit) || hit.type === "arrow")) {
      if (hit.type === "arrow" && !hit.label) {
        const t = nearestT(arrowGeometry(this.doc, hit).points, p);
        this.store.transact((d) => d.patch<ArrowEl>(hit.id, { labelT: t }));
      }
      return this.startEditing(hit.id);
    }
    if (!hit || hit.type === "frame") {
      // Double-click on empty canvas (or inside a frame) drops a text box.
      this.createAndEdit(makeText(p, hit?.type === "frame" ? hit.id : null));
    }
  }

  private selectDown(e: PointerInput, p: Vec) {
    const z = this.camera.zoom;
    const near = (w: Vec) => dist(this.toScreen(w), e.screen) <= HANDLE_HIT;

    // Arrow endpoint and label handles.
    if (this.selection.size === 1) {
      const el = this.doc.elements[[...this.selection][0]];
      if (el?.type === "arrow" && !el.locked) {
        for (const which of ["end", "start"] as const) {
          if (near(endPoint(this.doc, el[which]))) {
            this.store.begin();
            this.gesture = { kind: "arrow-end", id: el.id, which };
            return;
          }
        }
        const lr = arrowLabelRect(this.doc, el);
        if (lr && pointInRect(p, lr)) {
          this.store.begin();
          this.gesture = { kind: "label", id: el.id };
          return;
        }
      }
    }

    // Transformer handles.
    const tb = transformBox(this.doc, this.selection);
    if (tb && !e.shift) {
      if (tb.canRotate && near(rotateHandleWorld(tb, z))) {
        const pivot = { x: tb.rect.x + tb.rect.w / 2, y: tb.rect.y + tb.rect.h / 2 };
        this.store.begin();
        this.gesture = {
          kind: "rotate", from: this.doc, pivot, startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
          ids: [...withFrameChildren(this.doc, this.selection)], single: tb.single,
        };
        return;
      }
      if (tb.canResize) {
        for (const h of handlesFor(tb.single)) {
          if (near(handleWorld(tb, h))) {
            this.store.begin();
            this.gesture = { kind: "resize", from: this.doc, tb, handle: h, ids: [...this.selection] };
            return;
          }
        }
      }
    }

    // Clicking inside the current multi-selection's box drags the whole selection.
    let hit = elementAt(this.doc, p, z);
    if (tb && !tb.single && pointInRect(p, tb.rect) && !e.shift && (!hit || hit.type === "frame" || this.selection.has(hit.id))) {
      return this.beginMove(e, p);
    }

    if (hit && e.shift) {
      const next = new Set(this.selection);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.add(hit.id);
      return this.select(next);
    }
    if (hit) {
      if (!this.selection.has(hit.id)) this.selection = new Set([hit.id]);
      this.changed();
      if (hit.locked) return;
      return this.beginMove(e, p);
    }
    // Empty canvas: marquee (Shift keeps the existing selection).
    const base = e.shift ? new Set(this.selection) : new Set<string>();
    this.selection = new Set(base);
    this.gesture = { kind: "marquee", start: p, base };
    this.changed();
  }

  private beginMove(e: PointerInput, p: Vec) {
    const doc = this.doc;
    const top = [...this.selection].filter((id) => doc.elements[id] && !doc.elements[id].locked);
    const ids = withFrameChildren(doc, top);
    const bounds = selectionBounds(doc, top) ?? { x: p.x, y: p.y, w: 0, h: 0 };
    // Snap candidates: visible, non-moving, box-like elements.
    const view = expandRect(visibleWorldRect(this.camera, this.viewW, this.viewH), 200 / this.camera.zoom);
    const candidates: Rect[] = [];
    for (const id of doc.order) {
      const el = doc.elements[id];
      if (!el || ids.has(id) || el.type === "stroke" || el.type === "arrow") continue;
      const r = elementBounds(doc, el);
      if (rectsIntersect(r, view)) candidates.push(r);
    }
    this.gesture = { kind: "move", start: p, from: doc, ids, top, bounds, candidates, moved: false, startScreen: e.screen };
  }

  pointerMove(e: PointerInput) {
    this.lastPointer = e.screen;
    const p = this.toWorld(e.screen);
    const g = this.gesture;
    const z = this.camera.zoom;
    if (!g) return this.hover(e, p);

    switch (g.kind) {
      case "pan":
        this.camera = { ...g.cam, x: g.cam.x + e.screen.x - g.start.x, y: g.cam.y + e.screen.y - g.start.y };
        return this.changed();

      case "marquee": {
        const r = rectFromPoints(g.start, p);
        this.overlay.marquee = r;
        const picked = new Set(g.base);
        for (const id of this.doc.order) {
          const el = this.doc.elements[id];
          if (!el || el.locked) continue;
          if (marqueeHits(this.doc, el, r)) picked.add(id);
        }
        this.selection = picked;
        return this.changed();
      }

      case "move": {
        if (!g.moved) {
          if (dist(e.screen, g.startScreen) < DRAG_THRESHOLD) return;
          g.moved = true;
          this.store.begin();
          this.cursor = "move";
        }
        let dx = p.x - g.start.x, dy = p.y - g.start.y;
        this.overlay.guides = [];
        if (this.doc.settings.snapping && !e.alt) {
          const moved = { ...g.bounds, x: g.bounds.x + dx, y: g.bounds.y + dy };
          const s = snapRect(moved, g.candidates, SNAP_SCREEN_PX / z);
          dx += s.dx;
          dy += s.dy;
          this.overlay.guides = s.guides;
        }
        this.store.update((d) => moveFrom(d, g.from, g.ids, dx, dy));
        // Highlight the frame the dragged elements would land in.
        const nonFrames = g.top.filter((id) => g.from.elements[id]?.type !== "frame");
        const r = selectionBounds(this.doc, nonFrames);
        this.overlay.frameDropTarget = r ? frameFor(this.doc, r, new Set(g.top))?.id ?? null : null;
        return this.requestRender();
      }

      case "resize": {
        const { tb, handle } = g;
        if (tb.single) {
          const start = g.from.elements[tb.single.id];
          const patch = resizeSingle(start, handle, p, e.shift);
          this.store.update((d) => d.patch(start.id, patch));
        } else {
          this.store.update((d) => resizeGroup(d, g.from, withFrameChildren(g.from, g.ids), tb.rect, handle, p));
        }
        return;
      }

      case "rotate": {
        const a = Math.atan2(p.y - g.pivot.y, p.x - g.pivot.x);
        if (g.single) {
          const base = g.from.elements[g.single.id].angle;
          const angle = snapRotation(base + a - g.startAngle, e.shift);
          this.store.update((d) => rotateGroup(d, g.from, g.ids, g.pivot, angle - base));
        } else {
          this.store.update((d) => rotateGroup(d, g.from, g.ids, g.pivot, snapRotation(a - g.startAngle, e.shift)));
        }
        this.cursor = "grabbing";
        return this.changed();
      }

      case "create-box": {
        if (!g.id && dist(e.screen, g.startScreen) < DRAG_THRESHOLD) return;
        let end = p;
        if (e.shift) {
          const s = Math.max(Math.abs(p.x - g.start.x), Math.abs(p.y - g.start.y));
          end = { x: g.start.x + Math.sign(p.x - g.start.x || 1) * s, y: g.start.y + Math.sign(p.y - g.start.y || 1) * s };
        }
        const r = rectFromPoints(g.start, end);
        if (!g.id) {
          this.store.begin();
          const el = g.what === "frame" ? makeFrame(r, nextFrameTitle(this.doc)) : makeShape(this.prefs.shapeKind, r);
          g.id = el.id;
          this.store.update((d) => d.set(el));
          this.selection = new Set([el.id]);
        } else {
          const id = g.id;
          this.store.update((d) => d.patch(id, r));
        }
        return this.changed();
      }

      case "create-arrow": {
        if (!g.id && dist(e.screen, g.startScreen) < DRAG_THRESHOLD) return;
        if (!g.id) {
          this.store.begin();
          const el = makeArrow(g.start, p);
          el.start = g.startEnd;
          g.id = el.id;
          this.store.update((d) => d.set(el));
        }
        this.dragArrowEnd(g.id, "end", p, e.shift);
        return;
      }

      case "arrow-end":
        this.dragArrowEnd(g.id, g.which, p, e.shift);
        return;

      case "label": {
        const el = this.doc.elements[g.id];
        if (el?.type !== "arrow") return;
        const t = nearestT(arrowGeometry(this.doc, el).points, p);
        this.store.update((d) => d.patch<ArrowEl>(g.id, { labelT: t }));
        return;
      }

      case "draw": {
        if (dist(e.screen, g.lastScreen) < 2) return;
        g.lastScreen = e.screen;
        if (g.straight || e.shift) g.points = [g.points[0], p];
        else g.points.push(p);
        this.overlay.liveStroke = this.liveStyle(g.points);
        return this.requestRender();
      }

      case "erase":
        this.eraseAlong(g.last, p);
        g.last = p;
        return;
    }
  }

  private dragArrowEnd(id: string, which: "start" | "end", p: Vec, shift: boolean) {
    const el = this.doc.elements[id];
    if (el?.type !== "arrow") return;
    const other = which === "end" ? el.start : el.end;
    const exclude = new Set([id]);
    const b = findBinding(this.doc, p, this.camera.zoom, exclude);
    let end: ArrowEnd;
    if (b) {
      end = { x: b.point.x, y: b.point.y, bind: { id: b.id, u: b.u, v: b.v } };
      this.overlay.bindTarget = { id: b.id, point: b.point };
    } else {
      let q = p;
      if (shift) {
        // Constrain to 15° steps around the other endpoint.
        const o = endPoint(this.doc, other);
        const v = sub(p, o);
        const a = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 12)) * (Math.PI / 12);
        q = { x: o.x + Math.cos(a) * Math.hypot(v.x, v.y), y: o.y + Math.sin(a) * Math.hypot(v.x, v.y) };
      }
      end = { x: q.x, y: q.y, bind: null };
      this.overlay.bindTarget = null;
    }
    this.store.update((d) => d.patch<ArrowEl>(id, { [which]: end } as Partial<ArrowEl>));
  }

  private eraseAlong(a: Vec, b: Vec) {
    const z = this.camera.zoom;
    const steps = Math.max(1, Math.ceil((dist(a, b) * z) / 4));
    const r = 8 / z;
    const seg = expandRect(rectFromPoints(a, b), r);
    for (const id of this.doc.order) {
      const el = this.doc.elements[id];
      if (!el || el.type !== "stroke" || el.locked || this.overlay.erased.has(id)) continue;
      if (!rectsIntersect(elementBounds(this.doc, el), seg)) continue;
      const pts = strokeWorldPoints(el);
      for (let i = 0; i <= steps; i++) {
        const q = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
        if (hitTest(this.doc, el, q, z) || pts.some((pt) => dist(pt, q) < r)) {
          (this.overlay.erased as Set<string>).add(id);
          break;
        }
      }
    }
    this.overlay.eraserTrail = [...this.overlay.eraserTrail.slice(-24), b];
    this.requestRender();
  }

  pointerUp(e: PointerInput) {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const p = this.toWorld(e.screen);
    switch (g.kind) {
      case "pan":
        break;
      case "marquee":
        this.overlay.marquee = null;
        break;
      case "move":
        this.overlay.guides = [];
        this.overlay.frameDropTarget = null;
        if (g.moved) {
          const nonFrames = g.top.filter((id) => this.doc.elements[id]?.type !== "frame");
          this.store.update((d) => assignFrames(d, nonFrames));
          this.store.commit();
        }
        break;
      case "resize": {
        const ids = withFrameChildren(g.from, g.ids);
        this.store.update((d) => {
          for (const id of g.ids) if (d.get(id)?.type === "frame") recaptureFrame(d, id);
          assignFrames(d, [...ids].filter((id) => d.get(id)?.type !== "frame"));
        });
        this.store.commit();
        break;
      }
      case "rotate":
        this.store.commit();
        break;
      case "create-box": {
        let id = g.id;
        if (!id) {
          // A plain click places a default-sized object centred on the pointer.
          const size = g.what === "frame" ? { w: 800, h: 450 } : { w: 160, h: 110 };
          const r = { x: p.x - size.w / 2, y: p.y - size.h / 2, ...size };
          const el = g.what === "frame" ? makeFrame(r, nextFrameTitle(this.doc)) : makeShape(this.prefs.shapeKind, r);
          this.store.begin();
          this.store.update((d) => d.set(el));
          id = el.id;
        }
        const finalId = id;
        this.store.update((d) => {
          const el = d.get(finalId);
          if (!el) return;
          if (el.w < 2 || el.h < 2) d.patch(finalId, { w: Math.max(el.w, 20), h: Math.max(el.h, 20) });
          if (el.type === "frame") {
            // New frames go to the bottom so they never cover what they adopt.
            d.setOrder([finalId, ...d.doc.order.filter((x) => x !== finalId)]);
            recaptureFrame(d, finalId);
          } else assignFrames(d, [finalId]);
        });
        this.store.commit();
        this.selection = new Set([finalId]);
        this.tool = "select";
        break;
      }
      case "create-arrow":
        this.overlay.bindTarget = null;
        if (g.id) {
          const id = g.id;
          this.store.update((d) => assignFrames(d, [id]));
          this.store.commit();
          this.selection = new Set([id]);
          this.tool = "select";
        }
        break;
      case "arrow-end":
      case "label":
        this.overlay.bindTarget = null;
        this.store.commit();
        break;
      case "draw": {
        this.overlay.liveStroke = null;
        const z = this.camera.zoom;
        const raw = g.points.length === 1 ? [g.points[0], { x: g.points[0].x + 0.01, y: g.points[0].y }] : g.points;
        const pts = raw.length > 2 ? simplify(smoothStroke(raw), 0.5 / z) : raw;
        const style = this.liveStyle(pts);
        const el = makeStroke(pts, { color: style.color, width: style.width, opacity: style.opacity, highlighter: this.tool === "marker" });
        this.store.transact((d) => {
          d.set(el);
          assignFrames(d, [el.id]);
        });
        break;
      }
      case "erase": {
        const gone = [...this.overlay.erased];
        this.overlay.erased = new Set();
        this.overlay.eraserTrail = [];
        if (gone.length) this.store.transact((d) => deleteElements(d, gone));
        break;
      }
    }
    this.updateCursor();
    this.changed();
  }

  /** Abandons the current gesture (Esc or pointercancel). */
  cancelGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return false;
    if (this.store.inTransaction && !this.editingId) this.store.cancel();
    this.overlay = { ...emptyOverlay(), selection: this.selection };
    this.updateCursor();
    this.changed();
    return true;
  }

  private hover(e: PointerInput, p: Vec) {
    if (this.tool !== "select") {
      this.overlay.hoverId = null;
      if (this.tool === "arrow") {
        const b = findBinding(this.doc, p, this.camera.zoom);
        this.overlay.bindTarget = b ? { id: b.id, point: b.point } : null;
        this.requestRender();
      }
      return;
    }
    const z = this.camera.zoom;
    const near = (w: Vec) => dist(this.toScreen(w), e.screen) <= HANDLE_HIT;
    let cursor = "default";
    const tb = transformBox(this.doc, this.selection);
    if (tb) {
      if (tb.canRotate && near(rotateHandleWorld(tb, z))) cursor = "grab";
      else if (tb.canResize) {
        const h = handlesFor(tb.single).find((h) => near(handleWorld(tb, h)));
        if (h) cursor = resizeCursor(h, tb.angle);
      }
    }
    const hit = cursor === "default" ? elementAt(this.doc, p, z) : null;
    if (hit && !hit.locked) cursor = "move";
    if (hit?.id !== this.overlay.hoverId || cursor !== this.cursor) {
      this.overlay.hoverId = hit?.id ?? null;
      this.cursor = cursor;
      this.changed();
    }
  }

  private updateCursor() {
    this.cursor =
      this.tool === "hand" ? "grab"
      : this.tool === "select" ? "default"
      : this.tool === "eraser" ? "cell"
      : "crosshair";
  }

  // ---------- keyboard ----------

  /** Returns true when the key was handled (caller should preventDefault). */
  keyDown(k: KeyInput): boolean {
    const key = k.key.toLowerCase();
    if (k.mod) {
      if (key === "z") {
        if (k.shift) this.store.redo();
        else this.store.undo();
        return true;
      }
      if (key === "y") return this.store.redo(), true;
      if (key === "a") return this.selectAll(), true;
      if (key === "d") return this.duplicateSelection(), true;
      if (key === "0") return this.zoomTo(1), true;
      if (key === "=" || key === "+") return this.zoomStep(1), true;
      if (key === "-") return this.zoomStep(-1), true;
      if (key === "]") return this.reorderSelection("front"), true;
      if (key === "[") return this.reorderSelection("back"), true;
      return false;
    }
    if (k.code === "Space") {
      if (!k.repeat && this.tool !== "hand" && !this.gesture) {
        this.spaceTool = this.tool;
        this.tool = "hand";
        this.cursor = "grab";
        this.changed();
      }
      return true;
    }
    if (key === "escape") {
      if (this.cancelGesture()) return true;
      if (this.selection.size) this.select([]);
      else this.setTool("select");
      return true;
    }
    if (key === "delete" || key === "backspace") return this.deleteSelection(), true;
    if (key === "enter" && this.selection.size === 1) {
      this.startEditing([...this.selection][0]);
      return true;
    }
    if (k.shift && k.code === "Digit1") return this.zoomToFit(), true;
    if (k.shift && k.code === "Digit2") return this.zoomToFit(this.selection.size ? this.selection : undefined), true;
    if (key.startsWith("arrow") && this.selection.size) {
      const step = (k.shift ? 10 : 1) / this.camera.zoom;
      const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
      const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
      const ids = withFrameChildren(this.doc, [...this.selection].filter((id) => !this.doc.elements[id]?.locked));
      const from = this.doc;
      this.store.transact((d) => moveFrom(d, from, ids, dx, dy));
      return true;
    }
    if (key === "]") return this.reorderSelection("forward"), true;
    if (key === "[") return this.reorderSelection("backward"), true;
    const tools: Record<string, Tool> = {
      v: "select", h: "hand", t: "text", n: "sticky", s: "shape", r: "shape", f: "frame", a: "arrow", l: "arrow",
      p: "pen", m: "marker", e: "eraser",
    };
    // Physical key codes make shortcuts work on non-Latin layouts too.
    const byCode = /^Key([A-Z])$/.exec(k.code)?.[1].toLowerCase();
    const t = tools[byCode ?? key];
    if (t && !k.alt) {
      this.setTool(t);
      return true;
    }
    return false;
  }

  keyUp(k: KeyInput) {
    if (k.code === "Space" && this.spaceTool) {
      this.tool = this.spaceTool;
      this.spaceTool = null;
      if (this.gesture?.kind === "pan") this.cancelGesture();
      this.updateCursor();
      this.changed();
    }
  }

  // ---------- commands ----------

  deleteSelection() {
    const ids = [...this.selection].filter((id) => !this.doc.elements[id]?.locked);
    if (!ids.length) return;
    this.store.transact((d) => deleteElements(d, ids));
    this.select([]);
  }

  duplicateSelection() {
    const ids = [...this.selection];
    const r = selectionBounds(this.doc, ids);
    if (!r) return;
    let created: string[] = [];
    this.store.transact((d) => {
      created = duplicate(d, ids, r.w + 24 / this.camera.zoom, 0);
    });
    this.select(created);
  }

  reorderSelection(move: ZMove) {
    if (!this.selection.size) return;
    const ids = [...this.selection];
    this.store.transact((d) => reorder(d, ids, move));
  }

  setStyle(fields: Record<string, unknown>) {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.store.transact((d) => patchStyle(d, ids, fields));
  }

  setLocked(locked: boolean) {
    const ids = [...this.selection];
    this.store.transact((d) => ids.forEach((id) => d.patch(id, { locked })));
  }

  copy(): ClipboardPayload | null {
    if (!this.selection.size) return null;
    return serializeSelection(this.doc, this.selection);
  }

  cut(): ClipboardPayload | null {
    const payload = this.copy();
    if (payload) this.deleteSelection();
    return payload;
  }

  /** Paste location: the pointer if it is over the board, else the viewport centre. */
  pastePoint(): Vec {
    const s = this.lastPointer;
    const inside = s.x > 0 && s.y > 0 && s.x < this.viewW && s.y < this.viewH;
    return this.toWorld(inside ? s : { x: this.viewW / 2, y: this.viewH / 2 });
  }

  paste(payload: ClipboardPayload) {
    let ids: string[] = [];
    const at = this.pastePoint();
    this.store.transact((d) => {
      ids = pastePayload(d, payload, at);
    });
    this.tool = "select";
    this.select(ids);
  }

  pasteText(text: string) {
    const el = makeText(this.pastePoint(), null, text);
    this.store.transact((d) => {
      d.set(el);
      assignFrames(d, [el.id]);
    });
    this.select([el.id]);
  }

  insertElement(el: BoardElement) {
    this.store.transact((d) => {
      d.set(el);
      assignFrames(d, [el.id]);
    });
    this.tool = "select";
    this.select([el.id]);
  }

  viewportCenter(): Vec {
    return this.toWorld({ x: this.viewW / 2, y: this.viewH / 2 });
  }
}

/** Marquee rule: intersect for most elements, full containment for frames, true geometry for lines. */
export function marqueeHits(doc: Doc, el: BoardElement, r: Rect): boolean {
  if (el.type === "frame") return rectContainsRect(r, elementBounds(doc, el));
  if (el.type === "stroke") {
    const pts = strokeWorldPoints(el);
    return pts.some((p) => pointInRect(p, expandRect(r, el.width / 2))) || segmentsTouch(pts, r);
  }
  if (el.type === "arrow") return segmentsTouch(arrowGeometry(doc, el).points, r);
  return rectsIntersect(elementBounds(doc, el), r);
}

function segmentsTouch(pts: Vec[], r: Rect): boolean {
  for (let i = 1; i < pts.length; i++) if (segmentIntersectsRect(pts[i - 1], pts[i], r)) return true;
  return false;
}

const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];

function resizeCursor(h: Handle, angle: number): string {
  const v = rotate({ x: h.sx, y: h.sy }, angle);
  const a = ((Math.atan2(v.y, v.x) * 180) / Math.PI + 360) % 180;
  return CURSORS[Math.round(a / 45) % 4];
}
