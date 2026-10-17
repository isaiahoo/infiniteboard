import { useRef } from "react";
import { STICKY_COLORS, STROKE_WIDTHS, type ShapeKind } from "../core/model";
import { makeImage } from "../core/ops";
import { imageFileToAsset } from "../core/persist";
import type { Editor, Tool } from "../interaction/editor";
import { Icon, type IconName } from "./icons";
import { useEditor } from "./useEditor";

const TOOLS: { tool: Tool; icon: IconName; label: string; key: string }[] = [
  { tool: "select", icon: "select", label: "Select", key: "V" },
  { tool: "hand", icon: "hand", label: "Hand", key: "H / Space" },
  { tool: "text", icon: "text", label: "Text", key: "T" },
  { tool: "sticky", icon: "sticky", label: "Sticky note", key: "N" },
  { tool: "shape", icon: "rect", label: "Shape", key: "S" },
  { tool: "frame", icon: "frame", label: "Frame", key: "F" },
  { tool: "arrow", icon: "arrow", label: "Connector", key: "A" },
  { tool: "pen", icon: "pen", label: "Pen", key: "P" },
  { tool: "marker", icon: "marker", label: "Marker", key: "M" },
  { tool: "eraser", icon: "eraser", label: "Eraser", key: "E" },
];

const SHAPES: ShapeKind[] = ["rect", "roundrect", "ellipse", "diamond", "triangle"];
const INKS = ["#1e1e1e", "#e5484d", "#3e63dd", "#30a46c", "#f76b15", "#8e4ec6"];
const MARKERS = ["#ffd84d", "#7fe0c3", "#ff8fa3", "#8ec5ff"];

export function Toolbar({ editor }: { editor: Editor }) {
  useEditor(editor);
  const file = useRef<HTMLInputElement>(null);
  const { tool, prefs } = editor;

  const addImages = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      if (!f.type.startsWith("image/")) continue;
      const asset = await imageFileToAsset(f);
      editor.store.transact((d) => d.addAsset(asset));
      editor.insertElement(makeImage(asset, editor.viewportCenter()));
    }
  };

  let sub: JSX.Element | null = null;
  if (tool === "shape") {
    sub = (
      <div className="subbar">
        {SHAPES.map((k) => (
          <button key={k} className={prefs.shapeKind === k ? "active" : ""} title={k} onClick={() => { prefs.shapeKind = k; editor.changed(); }}>
            <Icon name={k} />
          </button>
        ))}
      </div>
    );
  } else if (tool === "sticky") {
    sub = (
      <div className="subbar">
        {STICKY_COLORS.map((c) => (
          <button key={c} className={`swatch ${prefs.stickyFill === c ? "active" : ""}`} style={{ background: c }} title={c} onClick={() => { prefs.stickyFill = c; editor.changed(); }} />
        ))}
      </div>
    );
  } else if (tool === "pen" || tool === "marker") {
    const isPen = tool === "pen";
    const colors = isPen ? INKS : MARKERS;
    const widths = isPen ? STROKE_WIDTHS.slice(0, 5) : [8, 14, 18, 28];
    sub = (
      <div className="subbar">
        {colors.map((c) => (
          <button key={c} className={`swatch ${(isPen ? prefs.penColor : prefs.markerColor) === c ? "active" : ""}`} style={{ background: c }} title={c}
            onClick={() => { if (isPen) prefs.penColor = c; else prefs.markerColor = c; editor.changed(); }} />
        ))}
        <span className="sep" />
        {widths.map((w) => (
          <button key={w} className={(isPen ? prefs.penWidth : prefs.markerWidth) === w ? "active" : ""} title={`${w}px`}
            onClick={() => { if (isPen) prefs.penWidth = w; else prefs.markerWidth = w; editor.changed(); }}>
            <span className="dot" style={{ width: Math.min(18, w + 2), height: Math.min(18, w + 2) }} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="toolbar-wrap">
      {sub}
      <div className="toolbar" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            className={tool === t.tool ? "active" : ""}
            title={`${t.label} (${t.key})`}
            aria-label={t.label}
            aria-pressed={tool === t.tool}
            onClick={() => editor.setTool(t.tool)}
          >
            <Icon name={t.tool === "shape" ? prefs.shapeKind : t.icon} />
          </button>
        ))}
        <span className="sep" />
        <button title="Image" aria-label="Insert image" onClick={() => file.current?.click()}>
          <Icon name="image" />
        </button>
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { void addImages(e.target.files); e.target.value = ""; }} />
      </div>
    </div>
  );
}
