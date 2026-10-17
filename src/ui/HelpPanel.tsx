const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const SECTIONS: [string, [string, string][]][] = [
  ["Tools", [
    ["Select", "V"], ["Hand", "H"], ["Text", "T"], ["Sticky note", "N"], ["Shape", "S"], ["Frame", "F"],
    ["Connector", "A"], ["Pen", "P"], ["Marker", "M"], ["Eraser", "E"],
  ]],
  ["View", [
    ["Pan", "Space + drag · scroll"], ["Zoom", `${MOD} + scroll · pinch`], ["Zoom in / out", `${MOD} + / −`],
    ["Zoom to 100%", `${MOD} 0`], ["Fit everything", "Shift 1"], ["Fit selection", "Shift 2"],
  ]],
  ["Edit", [
    ["Edit text", "Double-click · Enter"], ["Finish editing", `Esc · ${MOD} Enter`], ["Select all", `${MOD} A`],
    ["Duplicate", `${MOD} D`], ["Copy / paste", `${MOD} C / V`], ["Delete", "Delete"], ["Undo / redo", `${MOD} Z / ${MOD} Shift Z`],
    ["Nudge", "Arrows (Shift = 10px)"], ["Forward / backward", "] / ["], ["Front / back", `${MOD} ] / ${MOD} [`],
    ["Lock aspect / 15° steps", "Shift while resizing / rotating"], ["Skip snapping", "Alt while dragging"],
  ]],
];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-backdrop" onPointerDown={onClose}>
      <div className="help" role="dialog" aria-label="Keyboard shortcuts" onPointerDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <strong>Keyboard shortcuts</strong>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="help-grid">
          {SECTIONS.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              {rows.map(([label, keys]) => (
                <div key={label} className="help-row">
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
