import { useEffect, useRef } from "react";
import { visibleWorldRect } from "../core/camera";
import { arrowGeometry, elementBounds, paintOrder, strokeWorldPoints } from "../core/elements";
import { expandRect, unionRects, type Rect, type Vec } from "../core/geom";
import type { BoardElement } from "../core/model";
import type { Editor } from "../interaction/editor";
import { useEditor } from "./useEditor";

const W = 200;
const H = 130;

function tint(el: BoardElement): string {
  switch (el.type) {
    case "sticky":
      return el.fill;
    case "shape":
      return el.fillOpacity > 0 && el.fill.toLowerCase() !== "#ffffff" ? el.fill : el.stroke;
    case "frame":
      return "#ffffff";
    case "stroke":
      return el.color;
    case "arrow":
      return el.stroke;
    case "image":
      return "#9aa4b2";
    default:
      return "#6b6b6b";
  }
}

/** Overview of the whole board; click or drag to move the viewport. */
export function Minimap({ editor }: { editor: Editor }) {
  const version = useEditor(editor);
  const ref = useRef<HTMLCanvasElement>(null);
  const mapping = useRef<{ world: Rect; k: number; ox: number; oy: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const id = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const doc = editor.doc;
      const view = visibleWorldRect(editor.camera, editor.viewW, editor.viewH);
      const content = unionRects(doc.order.map((i) => doc.elements[i]).filter(Boolean).map((el) => elementBounds(doc, el)));
      if (!dragging.current || !mapping.current) {
        const world = expandRect(unionRects(content ? [content, view] : [view])!, 40 / editor.camera.zoom);
        const k = Math.min(W / world.w, H / world.h);
        mapping.current = { world, k, ox: (W - world.w * k) / 2 - world.x * k, oy: (H - world.h * k) / 2 - world.y * k };
      }
      const { k, ox, oy } = mapping.current;
      for (const el of paintOrder(doc)) {
        const r = elementBounds(doc, el);
        const x = r.x * k + ox, y = r.y * k + oy;
        const w = Math.max(1.5, r.w * k), h = Math.max(1.5, r.h * k);
        if (el.type === "arrow" || el.type === "stroke") {
          const pts = el.type === "arrow" ? arrowGeometry(doc, el).points : strokeWorldPoints(el);
          ctx.strokeStyle = tint(el);
          ctx.globalAlpha = el.type === "stroke" && el.highlighter ? 0.5 : 0.8;
          ctx.lineWidth = el.type === "stroke" ? Math.max(1, el.width * k) : 1;
          ctx.beginPath();
          // Every few points is plenty at minimap scale.
          const step = Math.max(1, Math.floor(pts.length / 24));
          for (let i = 0; i < pts.length; i += step) {
            const px = pts[i].x * k + ox, py = pts[i].y * k + oy;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          const last = pts[pts.length - 1];
          ctx.lineTo(last.x * k + ox, last.y * k + oy);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else if (el.type === "shape" && (el.fillOpacity === 0 || el.fill.toLowerCase() === "#ffffff")) {
          ctx.strokeStyle = el.stroke;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        } else if (el.type === "frame") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "rgba(0,0,0,0.25)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        } else {
          ctx.fillStyle = tint(el);
          ctx.fillRect(x, y, w, h);
        }
      }
      ctx.strokeStyle = "#3e63dd";
      ctx.lineWidth = 1.5;
      ctx.fillStyle = "rgba(62,99,221,0.08)";
      const vx = view.x * k + ox, vy = view.y * k + oy;
      ctx.fillRect(vx, vy, view.w * k, view.h * k);
      ctx.strokeRect(vx, vy, view.w * k, view.h * k);
    });
    return () => cancelAnimationFrame(id);
  }, [editor, version]);

  const centerOn = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const m = mapping.current;
    if (!m) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p: Vec = { x: (e.clientX - r.left - m.ox) / m.k, y: (e.clientY - r.top - m.oy) / m.k };
    const z = editor.camera.zoom;
    editor.setCamera({ zoom: z, x: editor.viewW / 2 - p.x * z, y: editor.viewH / 2 - p.y * z });
  };

  return (
    <div className="minimap" aria-label="Board overview">
      <canvas
        ref={ref}
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          // Freeze the mapping during a drag so the map doesn't rescale under the pointer.
          dragging.current = true;
          centerOn(e);
        }}
        onPointerMove={(e) => dragging.current && centerOn(e)}
        onPointerUp={() => {
          dragging.current = false;
          editor.changed();
        }}
      />
    </div>
  );
}
