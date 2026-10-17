import { useEffect, useRef, type CSSProperties } from "react";
import { stickyFontSize } from "../canvas/render";
import { arrowGeometry, boxOf, frameTitleRect, LABEL_FONT_SIZE, pointAlong } from "../core/elements";
import { center, rotate, type Rect } from "../core/geom";
import type { BoardElement } from "../core/model";
import { FONT_FAMILY, LINE_HEIGHT, STICKY_PADDING, TEXT_PADDING } from "../core/text";
import type { Editor } from "../interaction/editor";
import { useEditor } from "./useEditor";

function currentText(el: BoardElement): string {
  switch (el.type) {
    case "frame":
      return el.title;
    case "arrow":
      return el.label;
    case "shape":
    case "sticky":
    case "text":
      return el.text;
    default:
      return "";
  }
}

/** Places a contenteditable exactly over the element: world box → rotated, zoomed screen box. */
export function TextEditor({ editor }: { editor: Editor }) {
  useEditor(editor);
  const ref = useRef<HTMLDivElement>(null);
  const id = editor.editingId;
  const el = id ? editor.doc.elements[id] : null;

  useEffect(() => {
    const div = ref.current;
    if (!div || !id) return;
    const start = editor.doc.elements[id];
    if (!start) return;
    div.setAttribute("contenteditable", "plaintext-only");
    // Firefox before 136 lacks plaintext-only.
    if (div.contentEditable !== "plaintext-only") div.contentEditable = "true";
    div.innerText = currentText(start);
    div.focus();
    const range = document.createRange();
    range.selectNodeContents(div);
    if (!currentText(start)) range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Only on entering edit mode for this element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!el || !id) return null;
  const zoom = editor.camera.zoom;

  let box: Rect;
  let angle = 0;
  let style: CSSProperties = {};
  let singleLine = false;
  switch (el.type) {
    case "text":
      box = { x: el.x + TEXT_PADDING, y: el.y + TEXT_PADDING, w: el.w - TEXT_PADDING * 2, h: el.h - TEXT_PADDING * 2 };
      angle = el.angle;
      style = { fontSize: el.fontSize, color: el.color, textAlign: el.align, fontWeight: el.bold ? 700 : 400, fontStyle: el.italic ? "italic" : "normal", minHeight: el.fontSize * LINE_HEIGHT };
      break;
    case "sticky":
      box = { x: el.x + STICKY_PADDING, y: el.y + STICKY_PADDING, w: el.w - STICKY_PADDING * 2, h: el.h - STICKY_PADDING * 2 };
      angle = el.angle;
      style = { fontSize: stickyFontSize(el), color: el.color, textAlign: el.align, height: box.h, display: "flex", flexDirection: "column", justifyContent: "center" };
      break;
    case "shape": {
      const pad = Math.max(6, Math.min(el.w, el.h) * 0.1);
      box = { x: el.x + pad, y: el.y + pad, w: el.w - pad * 2, h: el.h - pad * 2 };
      angle = el.angle;
      style = { fontSize: el.fontSize, color: el.color, textAlign: el.align, height: box.h, display: "flex", flexDirection: "column", justifyContent: "center", fontWeight: el.bold ? 700 : 400 };
      break;
    }
    case "frame": {
      const r = frameTitleRect(el, zoom);
      box = { ...r, w: Math.max(r.w, 200 / zoom) };
      style = { fontSize: 13 / zoom, color: "#555", whiteSpace: "nowrap", lineHeight: `${r.h}px` };
      singleLine = true;
      break;
    }
    case "arrow": {
      const p = pointAlong(arrowGeometry(editor.doc, el).points, el.labelT);
      const w = 160;
      box = { x: p.x - w / 2, y: p.y - LABEL_FONT_SIZE * 0.8, w, h: LABEL_FONT_SIZE * 1.6 };
      style = { fontSize: LABEL_FONT_SIZE, color: el.stroke, textAlign: "center", background: editor.doc.settings.background };
      break;
    }
    default:
      return null;
  }

  // Rotate the box's top-left around the element centre, then map to screen.
  const pivot = el.type === "frame" || el.type === "arrow" ? center(box) : center(boxOf(el));
  const tl = editor.toScreen(rotate({ x: box.x, y: box.y }, angle, pivot));

  const finish = () => editor.stopEditing();

  return (
    <div
      ref={ref}
      key={id}
      className="text-editor"
      spellCheck={false}
      style={{
        ...style,
        fontFamily: FONT_FAMILY,
        lineHeight: style.lineHeight ?? LINE_HEIGHT,
        width: box.w,
        transform: `translate(${tl.x}px, ${tl.y}px) rotate(${angle}rad) scale(${zoom})`,
      }}
      onInput={(e) => editor.editText(e.currentTarget.innerText.replace(/\n$/, ""))}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter") || (singleLine && e.key === "Enter")) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
