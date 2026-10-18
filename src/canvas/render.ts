import { visibleWorldRect, worldToScreen, type Camera } from "../core/camera";
import { cylinderCap, shapeTextBox,
  arrowGeometry, arrowLabelRect, boxOf, elementBounds, endPoint, frameTitleRect, LABEL_FONT_SIZE, paintOrder,
  strokeWorldPoints,
} from "../core/elements";
import { center, expandRect, rectsIntersect, rotatedCorners, type Rect, type Vec } from "../core/geom";
import type { ArrowEl, ArrowHead, BoardElement, Doc, ShapeEl, StickyEl, StrokeEl, TextAlign, TextEl } from "../core/model";
import { handleWorld, rotateHandleWorld, transformBox } from "../core/selection";
import type { Guide } from "../core/snap";
import {
  fitFontSize, fontString, LINE_HEIGHT, STICKY_PADDING, TEXT_PADDING, wrapText,
} from "../core/text";
import { handlesFor } from "../core/transform";

export const ACCENT = "#3e63dd";

export interface Overlay {
  selection: ReadonlySet<string>;
  editingId: string | null;
  hoverId: string | null;
  marquee: Rect | null;
  guides: Guide[];
  /** Elements hidden while an eraser gesture is in progress. */
  erased: ReadonlySet<string>;
  eraserTrail: Vec[];
  /** Element highlighted as an arrow-binding target, plus the snapped point. */
  bindTarget: { id: string; point: Vec } | null;
  frameDropTarget: string | null;
  /** In-progress stroke (world points) drawn before it becomes an element. */
  liveStroke: { points: Vec[]; color: string; width: number; opacity: number } | null;
}

export const emptyOverlay = (): Overlay => ({
  selection: new Set(), editingId: null, hoverId: null, marquee: null, guides: [], erased: new Set(), eraserTrail: [],
  bindTarget: null, frameDropTarget: null, liveStroke: null,
});

const imageCache = new Map<string, HTMLImageElement>();

function imageFor(doc: Doc, assetId: string, onLoad: () => void): HTMLImageElement | null {
  const asset = doc.assets[assetId];
  if (!asset) return null;
  let img = imageCache.get(assetId);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = asset.dataUrl;
    imageCache.set(assetId, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function isDark(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export function render(
  ctx: CanvasRenderingContext2D, doc: Doc, cam: Camera, viewW: number, viewH: number, dpr: number, ov: Overlay,
  requestRedraw: () => void,
) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = doc.settings.background;
  ctx.fillRect(0, 0, viewW, viewH);
  drawGrid(ctx, doc, cam, viewW, viewH);

  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
  const view = expandRect(visibleWorldRect(cam, viewW, viewH), 40 / cam.zoom);
  for (const el of paintOrder(doc)) {
    if (ov.erased.has(el.id)) continue;
    if (!rectsIntersect(elementBounds(doc, el), view)) continue;
    drawElement(ctx, doc, el, cam.zoom, ov, requestRedraw);
  }
  if (ov.liveStroke) {
    const s = ov.liveStroke;
    ctx.globalAlpha = s.opacity;
    strokePath(ctx, s.points, s.color, s.width);
    ctx.globalAlpha = 1;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay(ctx, doc, cam, ov);
}

// ---------- grid ----------

function drawGrid(ctx: CanvasRenderingContext2D, doc: Doc, cam: Camera, viewW: number, viewH: number) {
  if (doc.settings.grid === "none") return;
  const dark = isDark(doc.settings.background);
  const ink = dark ? "255,255,255" : "0,0,0";
  // Pick a world step so minor cells are at least 8px on screen; steps grow by ×5.
  let step = 16;
  while (step * cam.zoom < 8) step *= 5;
  while (step * cam.zoom > 40) step /= 5;
  const minorPx = step * cam.zoom;
  const minorAlpha = Math.min(1, (minorPx - 8) / 24);
  const layers: [number, number][] = [
    [step, 0.05 * minorAlpha],
    [step * 5, 0.09],
  ];
  for (const [s, alpha] of layers) {
    if (alpha <= 0.002) continue;
    const px = s * cam.zoom;
    const ox = ((cam.x % px) + px) % px;
    const oy = ((cam.y % px) + px) % px;
    if (doc.settings.grid === "lines") {
      ctx.strokeStyle = `rgba(${ink},${dark ? alpha * 2.2 : alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = ox; x < viewW; x += px) {
        const sx = Math.round(x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, viewH);
      }
      for (let y = oy; y < viewH; y += px) {
        const sy = Math.round(y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(viewW, sy);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(${ink},${(dark ? alpha * 2.2 : alpha) * 3})`;
      const r = s === step ? 1 : 1.5;
      for (let x = ox; x < viewW; x += px) for (let y = oy; y < viewH; y += px) ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }
}

// ---------- elements ----------

function withRotation(ctx: CanvasRenderingContext2D, el: BoardElement, fn: () => void) {
  if (!el.angle) return fn();
  const c = center(boxOf(el));
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(el.angle);
  ctx.translate(-c.x, -c.y);
  fn();
  ctx.restore();
}

function drawElement(ctx: CanvasRenderingContext2D, doc: Doc, el: BoardElement, zoom: number, ov: Overlay, redraw: () => void) {
  const editing = ov.editingId === el.id;
  switch (el.type) {
    case "frame": {
      ctx.fillStyle = el.fill;
      ctx.fillRect(el.x, el.y, el.w, el.h);
      ctx.lineWidth = (ov.frameDropTarget === el.id ? 2 : 1) / zoom;
      ctx.strokeStyle = ov.frameDropTarget === el.id ? ACCENT : "rgba(0,0,0,0.12)";
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      if (!editing) {
        const tr = frameTitleRect(el, zoom);
        ctx.font = fontString(13 / zoom);
        ctx.fillStyle = isDark(doc.settings.background) ? "rgba(255,255,255,0.8)" : "#555";
        ctx.textBaseline = "middle";
        ctx.fillText(el.title || "Frame", tr.x, tr.y + tr.h / 2, el.w);
      }
      return;
    }
    case "shape":
      return withRotation(ctx, el, () => drawShape(ctx, el, editing, zoom));
    case "sticky":
      return withRotation(ctx, el, () => drawSticky(ctx, el, editing, zoom));
    case "text":
      if (editing) return;
      return withRotation(ctx, el, () => drawTextEl(ctx, el));
    case "image": {
      const img = imageFor(doc, el.assetId, redraw);
      return withRotation(ctx, el, () => {
        if (img) ctx.drawImage(img, el.x, el.y, el.w, el.h);
        else {
          ctx.fillStyle = "#e6e6e6";
          ctx.fillRect(el.x, el.y, el.w, el.h);
        }
      });
    }
    case "stroke":
      return drawStroke(ctx, el);
    case "arrow":
      return drawArrow(ctx, doc, el, zoom, editing);
  }
}

function shapePath(ctx: CanvasRenderingContext2D, el: ShapeEl) {
  const { x, y, w, h } = el;
  ctx.beginPath();
  switch (el.kind) {
    case "rect":
      ctx.rect(x, y, w, h);
      break;
    case "roundrect":
      ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.15);
      break;
    case "ellipse":
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "diamond":
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      break;
    case "hexagon": {
      const k = Math.min(w * 0.2, h * 0.5);
      ctx.moveTo(x + k, y);
      ctx.lineTo(x + w - k, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w - k, y + h);
      ctx.lineTo(x + k, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      break;
    }
    case "parallelogram": {
      const k = Math.min(w * 0.2, h * 0.5);
      ctx.moveTo(x + k, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w - k, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      break;
    }
    case "cylinder": {
      const c = cylinderCap(w, h);
      ctx.moveTo(x, y + c);
      ctx.ellipse(x + w / 2, y + c, w / 2, c, 0, Math.PI, 0);
      ctx.lineTo(x + w, y + h - c);
      ctx.ellipse(x + w / 2, y + h - c, w / 2, c, 0, 0, Math.PI);
      ctx.closePath();
      break;
    }
  }
}

function drawShape(ctx: CanvasRenderingContext2D, el: ShapeEl, editing: boolean, zoom: number) {
  shapePath(ctx, el);
  if (el.fillOpacity > 0) {
    ctx.globalAlpha = el.fillOpacity;
    ctx.fillStyle = el.fill;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (el.strokeWidth > 0) {
    ctx.lineWidth = el.strokeWidth;
    ctx.strokeStyle = el.stroke;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  if (el.kind === "cylinder" && el.strokeWidth > 0) {
    // The front rim of the top cap.
    const c = cylinderCap(el.w, el.h);
    ctx.beginPath();
    ctx.ellipse(el.x + el.w / 2, el.y + c, el.w / 2, c, 0, 0, Math.PI);
    ctx.stroke();
  }
  if (!editing && el.text) {
    drawTextBox(ctx, el.text, shapeTextBox(el), el.fontSize, el.color, el.align, "middle", zoom, el.bold, el.italic);
  }
}

function drawSticky(ctx: CanvasRenderingContext2D, el: StickyEl, editing: boolean, zoom: number) {
  if (zoom > 0.25) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 10 * zoom;
    ctx.shadowOffsetY = 3 * zoom;
    ctx.fillStyle = el.fill;
    ctx.fillRect(el.x, el.y, el.w, el.h);
    ctx.restore();
  } else {
    ctx.fillStyle = el.fill;
    ctx.fillRect(el.x, el.y, el.w, el.h);
  }
  if (editing || !el.text) return;
  const inner = { x: el.x + STICKY_PADDING, y: el.y + STICKY_PADDING, w: el.w - STICKY_PADDING * 2, h: el.h - STICKY_PADDING * 2 };
  const size = stickyFontSize(el);
  drawTextBox(ctx, el.text, inner, size, el.color, el.align, "middle", zoom);
}

const fitCache = new Map<string, number>();

export function stickyFontSize(el: StickyEl): number {
  const key = `${el.w.toFixed(1)}|${el.h.toFixed(1)}|${el.text}`;
  let size = fitCache.get(key);
  if (size === undefined) {
    size = fitFontSize(el.text, el.w - STICKY_PADDING * 2, el.h - STICKY_PADDING * 2, Math.max(12, el.h / 4));
    if (fitCache.size > 5000) fitCache.clear();
    fitCache.set(key, size);
  }
  return size;
}

function drawTextEl(ctx: CanvasRenderingContext2D, el: TextEl) {
  const inner = { x: el.x + TEXT_PADDING, y: el.y + TEXT_PADDING, w: el.w - TEXT_PADDING * 2, h: el.h - TEXT_PADDING * 2 };
  drawTextBox(ctx, el.text, inner, el.fontSize, el.color, el.align, "top", 1, el.bold, el.italic);
}

function drawTextBox(
  ctx: CanvasRenderingContext2D, text: string, box: Rect, size: number, color: string, align: TextAlign,
  valign: "top" | "middle", zoom: number, bold?: boolean, italic?: boolean,
) {
  // Far zoomed out, text is unreadable anyway: draw grey bars instead (much cheaper).
  const font = fontString(size, bold, italic);
  const lines = wrapText(text, font, Math.max(1, box.w));
  const lh = size * LINE_HEIGHT;
  const total = lines.length * lh;
  let y = valign === "middle" ? box.y + (box.h - total) / 2 : box.y;
  if (size * zoom < 3) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillRect(box.x, y + lh * 0.3, box.w * 0.8, lh * 0.4);
      y += lh;
    }
    ctx.globalAlpha = 1;
    return;
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  const x = align === "left" ? box.x : align === "center" ? box.x + box.w / 2 : box.x + box.w;
  for (const line of lines) {
    ctx.fillText(line, x, y + lh / 2);
    y += lh;
  }
  ctx.textAlign = "left";
}

function strokePath(ctx: CanvasRenderingContext2D, pts: Vec[], color: string, width: number) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1 || (pts.length === 2 && pts[0].x === pts[1].x && pts[0].y === pts[1].y)) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  // Quadratic curves through midpoints give a smooth line without overshoot.
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawStroke(ctx: CanvasRenderingContext2D, el: StrokeEl) {
  ctx.globalAlpha = el.opacity;
  if (el.highlighter) ctx.globalCompositeOperation = "multiply";
  strokePath(ctx, strokeWorldPoints(el), el.color, el.width);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function drawHead(ctx: CanvasRenderingContext2D, tip: Vec, dir: Vec, kind: ArrowHead, width: number) {
  if (kind === "none") return;
  const size = 8 + width * 2.5;
  const back = { x: tip.x - dir.x * size, y: tip.y - dir.y * size };
  const nx = -dir.y * size * 0.5, ny = dir.x * size * 0.5;
  ctx.beginPath();
  ctx.moveTo(back.x + nx, back.y + ny);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(back.x - nx, back.y - ny);
  if (kind === "filled") {
    ctx.closePath();
    ctx.fill();
  } else ctx.stroke();
}

function drawArrow(ctx: CanvasRenderingContext2D, doc: Doc, el: ArrowEl, zoom: number, editing: boolean) {
  const geo = arrowGeometry(doc, el);
  ctx.strokeStyle = el.stroke;
  ctx.fillStyle = el.stroke;
  ctx.lineWidth = el.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(el.dash === "dashed" ? [el.strokeWidth * 4, el.strokeWidth * 3] : el.dash === "dotted" ? [0.1, el.strokeWidth * 2.5] : []);
  ctx.beginPath();
  if (geo.bezier) {
    const [a, c1, c2, b] = geo.bezier;
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
  } else {
    ctx.moveTo(geo.points[0].x, geo.points[0].y);
    for (const p of geo.points.slice(1)) ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  drawHead(ctx, geo.b, geo.endDir, el.endHead, el.strokeWidth);
  drawHead(ctx, geo.a, geo.startDir, el.startHead, el.strokeWidth);
  const lr = arrowLabelRect(doc, el, geo);
  if (lr && !editing) {
    ctx.fillStyle = doc.settings.background;
    ctx.fillRect(lr.x, lr.y, lr.w, lr.h);
    drawTextBox(ctx, el.label, lr, LABEL_FONT_SIZE, el.stroke, "center", "middle", zoom);
  }
}

// ---------- overlay (screen space) ----------

function drawOverlay(ctx: CanvasRenderingContext2D, doc: Doc, cam: Camera, ov: Overlay) {
  const S = (p: Vec) => worldToScreen(cam, p);
  ctx.lineWidth = 1;

  if (ov.hoverId && !ov.selection.has(ov.hoverId)) {
    const el = doc.elements[ov.hoverId];
    if (el) outlineElement(ctx, doc, el, cam, "rgba(62,99,221,0.55)");
  }

  if (ov.selection.size > 1) for (const id of ov.selection) {
    const el = doc.elements[id];
    if (el) outlineElement(ctx, doc, el, cam, "rgba(62,99,221,0.6)");
  }

  const tb = transformBox(doc, ov.selection);
  if (tb && !ov.editingId) {
    const corners = rotatedCorners(tb.rect, tb.angle).map(S);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    if (tb.canResize) {
      for (const h of handlesFor(tb.single)) {
        const p = S(handleWorld(tb, h));
        const corner = h.sx !== 0 && h.sy !== 0;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (corner) ctx.roundRect(p.x - 5, p.y - 5, 10, 10, 2);
        else if (h.sx !== 0) ctx.roundRect(p.x - 3, p.y - 8, 6, 16, 3);
        else ctx.roundRect(p.x - 8, p.y - 3, 16, 6, 3);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (tb.canRotate) {
      const top = S(handleWorld(tb, { sx: 0, sy: -1 }));
      const r = S(rotateHandleWorld(tb, cam.zoom));
      ctx.strokeStyle = ACCENT;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(r.x, r.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Endpoint handles for a single selected arrow.
  if (ov.selection.size === 1 && !ov.editingId) {
    const el = doc.elements[[...ov.selection][0]];
    if (el?.type === "arrow") {
      for (const end of [el.start, el.end]) {
        const p = S(endPoint(doc, end));
        ctx.fillStyle = end.bind ? ACCENT : "#fff";
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      const geo = arrowGeometry(doc, el);
      const lr = arrowLabelRect(doc, el, geo);
      if (lr) {
        const a = S({ x: lr.x, y: lr.y });
        ctx.strokeStyle = "rgba(62,99,221,0.6)";
        ctx.strokeRect(a.x, a.y, lr.w * cam.zoom, lr.h * cam.zoom);
      }
    }
  }

  if (ov.bindTarget) {
    const el = doc.elements[ov.bindTarget.id];
    if (el) {
      outlineElement(ctx, doc, el, cam, ACCENT);
      const box = boxOf(el);
      for (const [u, v] of [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]) {
        const p = S(rotatePoint({ x: box.x + u * box.w, y: box.y + v * box.h }, el.angle, center(box)));
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = ACCENT;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      const p = S(ov.bindTarget.point);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (ov.marquee) {
    const a = S({ x: ov.marquee.x, y: ov.marquee.y });
    const w = ov.marquee.w * cam.zoom, h = ov.marquee.h * cam.zoom;
    ctx.fillStyle = "rgba(62,99,221,0.08)";
    ctx.fillRect(a.x, a.y, w, h);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
  }

  if (ov.guides.length) {
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const g of ov.guides) {
      const p1 = S(g.axis === "x" ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
      const p2 = S(g.axis === "x" ? { x: g.at, y: g.to } : { x: g.to, y: g.at });
      ctx.moveTo(Math.round(p1.x) + 0.5, Math.round(p1.y) + 0.5);
      ctx.lineTo(Math.round(p2.x) + 0.5, Math.round(p2.y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (ov.eraserTrail.length > 1) {
    ctx.strokeStyle = "rgba(120,120,120,0.35)";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ov.eraserTrail.map(S).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
}

function rotatePoint(p: Vec, angle: number, c: Vec): Vec {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos };
}

function outlineElement(ctx: CanvasRenderingContext2D, doc: Doc, el: BoardElement, cam: Camera, color: string) {
  const S = (p: Vec) => worldToScreen(cam, p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (el.type === "arrow") {
    arrowGeometry(doc, el).points.map(S).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  } else if (el.type === "stroke") {
    const r = elementBounds(doc, el);
    const a = S({ x: r.x, y: r.y });
    ctx.rect(a.x, a.y, r.w * cam.zoom, r.h * cam.zoom);
  } else {
    rotatedCorners(boxOf(el), el.angle).map(S).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  }
  ctx.stroke();
}
