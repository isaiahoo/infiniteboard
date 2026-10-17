import { useState } from "react";
import { elementBounds } from "../core/elements";
import { PALETTE, STICKY_COLORS, type ArrowHead, type ArrowRoute, type BoardElement, type Dash, type ShapeKind, type TextAlign } from "../core/model";
import { selectionBounds } from "../core/ops";
import type { Editor } from "../interaction/editor";
import { Icon, type IconName } from "./icons";
import { useEditor } from "./useEditor";

/** One swatch showing the current colour; clicking opens the palette. */
function ColorPicker({ id, label, colors, value, onPick, open, setOpen }: {
  id: string; label: string; colors: string[]; value?: string; onPick: (c: string) => void;
  open: string | null; setOpen: (id: string | null) => void;
}) {
  const isOpen = open === id;
  return (
    <span className="picker">
      <button title={label} aria-label={label} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
        <span className={`swatch small ${value ? "" : "mixed"}`} style={{ background: value ?? "transparent" }} />
      </button>
      {isOpen && (
        <span className="palette" role="listbox" aria-label={label}>
          {colors.map((c) => (
            <button key={c} role="option" aria-selected={value === c} className={`swatch small ${value === c ? "active" : ""}`} style={{ background: c }} title={c}
              onClick={() => { onPick(c); setOpen(null); }} />
          ))}
        </span>
      )}
    </span>
  );
}

function Choice<T extends string>({ options, value, onPick }: { options: { v: T; icon: IconName; label: string }[]; value?: T; onPick: (v: T) => void }) {
  return (
    <>
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? "active" : ""} title={o.label} aria-label={o.label} onClick={() => onPick(o.v)}>
          <Icon name={o.icon} size={18} />
        </button>
      ))}
    </>
  );
}

/** The value of `key` when every selected element that has it agrees. */
function common<K extends string>(els: BoardElement[], key: K): unknown {
  const vals = els.filter((e) => key in e).map((e) => (e as unknown as Record<string, unknown>)[key]);
  return vals.length && vals.every((v) => v === vals[0]) ? vals[0] : undefined;
}

export function PropertyBar({ editor }: { editor: Editor }) {
  useEditor(editor);
  const [open, setOpen] = useState<string | null>(null);
  const picker = (id: string, label: string, colors: string[], value: unknown, onPick: (c: string) => void) => (
    <ColorPicker key={id} id={id} label={label} colors={colors} value={value as string | undefined} onPick={onPick} open={open} setOpen={setOpen} />
  );
  const els = editor.selectedElements;
  if (!els.length || editor.editingId || editor.interacting) return null;
  const doc = editor.doc;
  const r = els.length === 1 ? elementBounds(doc, els[0]) : selectionBounds(doc, editor.selection);
  if (!r) return null;

  const types = new Set(els.map((e) => e.type));
  const has = (t: BoardElement["type"]) => types.has(t);
  const set = (fields: Record<string, unknown>) => editor.setStyle(fields);
  const locked = els.every((e) => e.locked);
  const groups: JSX.Element[] = [];

  if (has("sticky")) groups.push(picker("sticky", "Note colour", STICKY_COLORS, common(els, "fill"), (c) => set({ fill: c })));
  if (has("shape")) {
    groups.push(
      <Choice<ShapeKind> key="kind" value={common(els, "kind") as ShapeKind}
        options={(["rect", "roundrect", "ellipse", "diamond", "triangle"] as const).map((k) => ({ v: k, icon: k, label: k }))}
        onPick={(v) => set({ kind: v })} />,
      picker("fill", "Fill colour", PALETTE, common(els, "fill"), (c) => set({ fill: c, fillOpacity: 1 })),
      <button key="nofill" title="No fill" aria-label="No fill" onClick={() => set({ fillOpacity: 0 })}>∅</button>,
      picker("stroke", "Border colour", PALETTE, common(els, "stroke"), (c) => set({ stroke: c })),
    );
  }
  if (has("frame")) groups.push(picker("frame", "Frame colour", ["#ffffff", "#f3f3f3", "#fff7d6", "#e8f1ff", "#eafaf1", "#fdeef0"], common(els, "fill"), (c) => set({ fill: c })));
  if (has("text") || has("shape") || has("sticky")) {
    const size = common(els, "fontSize") as number | undefined;
    if (has("text") || has("shape")) {
      groups.push(
        <span key="fs" className="group">
          <button title="Smaller text" onClick={() => editor.setStyle({ fontSize: Math.max(6, Math.round((size ?? 18) / 1.2)) })}>A−</button>
          <span className="value">{size ? Math.round(size) : "–"}</span>
          <button title="Larger text" onClick={() => editor.setStyle({ fontSize: Math.round((size ?? 18) * 1.2) })}>A+</button>
        </span>,
        <button key="b" className={common(els, "bold") ? "active" : ""} title="Bold" onClick={() => set({ bold: !common(els, "bold") })}><Icon name="bold" size={18} /></button>,
        <button key="i" className={common(els, "italic") ? "active" : ""} title="Italic" onClick={() => set({ italic: !common(els, "italic") })}><Icon name="italic" size={18} /></button>,
      );
    }
    groups.push(
      <Choice<TextAlign> key="align" value={common(els, "align") as TextAlign}
        options={[{ v: "left", icon: "alignLeft", label: "Align left" }, { v: "center", icon: "alignCenter", label: "Align centre" }, { v: "right", icon: "alignRight", label: "Align right" }]}
        onPick={(v) => set({ align: v })} />,
      picker("text", "Text colour", ["#1e1e1e", "#6b6b6b", "#ffffff", "#e5484d", "#3e63dd", "#30a46c", "#f76b15", "#8e4ec6"], common(els, "color"), (c) => set({ color: c })),
    );
  }
  if (has("arrow")) {
    groups.push(
      <Choice<ArrowRoute> key="route" value={common(els, "route") as ArrowRoute}
        options={[{ v: "straight", icon: "straight", label: "Straight" }, { v: "elbow", icon: "elbow", label: "Elbow" }, { v: "curved", icon: "curved", label: "Curved" }]}
        onPick={(v) => set({ route: v })} />,
      <span key="h-l" className="label">End</span>,
      <Choice<ArrowHead> key="head" value={common(els, "endHead") as ArrowHead}
        options={[{ v: "none", icon: "headNone", label: "No head" }, { v: "open", icon: "headOpen", label: "Open head" }, { v: "filled", icon: "headFilled", label: "Filled head" }]}
        onPick={(v) => set({ endHead: v })} />,
      <span key="s-l" className="label">Start</span>,
      <Choice<ArrowHead> key="shead" value={common(els, "startHead") as ArrowHead}
        options={[{ v: "none", icon: "headNone", label: "No head" }, { v: "open", icon: "headOpen", label: "Open head" }, { v: "filled", icon: "headFilled", label: "Filled head" }]}
        onPick={(v) => set({ startHead: v })} />,
      <Choice<Dash> key="dash" value={common(els, "dash") as Dash}
        options={[{ v: "solid", icon: "dashSolid", label: "Solid" }, { v: "dashed", icon: "dashDashed", label: "Dashed" }, { v: "dotted", icon: "dashDotted", label: "Dotted" }]}
        onPick={(v) => set({ dash: v })} />,
    );
  }
  if (has("arrow") || has("stroke")) {
    groups.push(picker("ink", "Line colour", ["#1e1e1e", "#6b6b6b", "#e5484d", "#3e63dd", "#30a46c", "#f76b15", "#8e4ec6", "#ffd84d"],
      has("arrow") ? common(els, "stroke") : common(els, "color"), (c) => set({ stroke: c, color: c })));
  }

  // Place above the selection, flipping below when there's no room.
  const top = editor.toScreen({ x: r.x + r.w / 2, y: r.y });
  const bottom = editor.toScreen({ x: r.x + r.w / 2, y: r.y + r.h });
  const above = top.y > 110;
  // Clear of the rotate handle (26px above the box) and the bottom side handle.
  const y = above ? top.y - 90 : bottom.y + 24;
  const x = Math.min(Math.max(top.x, 16), editor.viewW - 16);

  return (
    <div className="propbar" style={{ left: x, top: Math.min(Math.max(y, 64), editor.viewH - 120) }} onPointerDown={(e) => e.stopPropagation()}>
      {!locked && groups.map((g, i) => [i > 0 ? <span key={`sep${i}`} className="sep" /> : null, g])}
      {!locked && groups.length > 0 && <span className="sep" />}
      {!locked && (
        <>
          <button title="Bring to front (Ctrl/Cmd+])" onClick={() => editor.reorderSelection("front")}><Icon name="front" size={18} /></button>
          <button title="Send to back (Ctrl/Cmd+[)" onClick={() => editor.reorderSelection("back")}><Icon name="back" size={18} /></button>
          <button title="Duplicate (Ctrl/Cmd+D)" onClick={() => editor.duplicateSelection()}><Icon name="copy" size={18} /></button>
        </>
      )}
      <button title={locked ? "Unlock" : "Lock"} onClick={() => editor.setLocked(!locked)}><Icon name={locked ? "unlock" : "lock"} size={18} /></button>
      {!locked && <button title="Delete (Del)" onClick={() => editor.deleteSelection()}><Icon name="trash" size={18} /></button>}
    </div>
  );
}
