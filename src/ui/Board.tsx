import { useEffect, useRef } from "react";
import { render } from "../canvas/render";
import { imageFileToAsset } from "../core/persist";
import { makeImage } from "../core/ops";
import type { Editor, PointerInput } from "../interaction/editor";
import { useEditor } from "./useEditor";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function toInput(e: PointerEvent | React.PointerEvent, el: HTMLElement): PointerInput {
  const r = el.getBoundingClientRect();
  return {
    screen: { x: e.clientX - r.left, y: e.clientY - r.top },
    button: e.button,
    shift: e.shiftKey,
    alt: e.altKey,
    mod: isMac ? e.metaKey : e.ctrlKey,
  };
}

export function Board({ editor }: { editor: Editor }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEditor(editor);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      render(ctx, editor.doc, editor.camera, editor.viewW, editor.viewH, dpr, editor.overlay, () => editor.requestRender());
    };
    editor.onRender = draw;
    editor.capture = async (maxWidth, format = "png") => {
      draw();
      const k = Math.min(1, maxWidth / canvas.width);
      const out = document.createElement("canvas");
      out.width = Math.round(canvas.width * k);
      out.height = Math.round(canvas.height * k);
      const g = out.getContext("2d")!;
      if (format === "jpeg") {
        // JPEG has no alpha: paint the board background first.
        g.fillStyle = editor.doc.settings.background;
        g.fillRect(0, 0, out.width, out.height);
      }
      g.drawImage(canvas, 0, 0, out.width, out.height);
      return format === "jpeg" ? out.toDataURL("image/jpeg", 0.85) : out.toDataURL("image/png");
    };
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      editor.viewW = width;
      editor.viewH = height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Non-passive wheel so the browser doesn't zoom the page on pinch.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      editor.onWheel({ x: e.clientX - r.left, y: e.clientY - r.top }, e.deltaX * k, e.deltaY * k, e.ctrlKey || e.metaKey, e.shiftKey);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Safari pinch gestures.
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", prevent);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      document.removeEventListener("gesturestart", prevent);
      editor.onRender = null;
      editor.capture = null;
    };
  }, [editor]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    const r = canvasRef.current!.getBoundingClientRect();
    let at = editor.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    for (const f of files) {
      const asset = await imageFileToAsset(f);
      editor.store.transact((d) => d.addAsset(asset));
      const el = makeImage(asset, at);
      editor.insertElement(el);
      at = { x: at.x + 40 / editor.camera.zoom, y: at.y + 40 / editor.camera.zoom };
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="board"
      style={{ cursor: editor.cursor }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        // Blur any focused toolbar input so keyboard shortcuts reach the board.
        if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
        editor.pointerDown(toInput(e, e.currentTarget));
      }}
      // Without this, mousedown's default focus change steals focus from a text editor opened on pointerdown.
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={(e) => editor.pointerMove(toInput(e, e.currentTarget))}
      onPointerUp={(e) => editor.pointerUp(toInput(e, e.currentTarget))}
      onPointerCancel={() => editor.cancelGesture()}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    />
  );
}
