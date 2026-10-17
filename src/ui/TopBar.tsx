import { useRef, useState, useSyncExternalStore } from "react";
import type { AiBridge } from "../ai/bridge";
import { downloadBlob, exportJson, importJson } from "../core/persist";
import { emptyDoc } from "../core/model";
import type { Editor } from "../interaction/editor";
import { Icon } from "./icons";
import { addSampleBoard } from "./sample";
import { useEditor } from "./useEditor";

const BACKGROUNDS = [
  { label: "Paper", value: "#f7f7f5" },
  { label: "White", value: "#ffffff" },
  { label: "Slate", value: "#1f2328" },
  { label: "Chalkboard", value: "#2f5d3a" },
];

interface Props {
  editor: Editor;
  bridge: AiBridge;
  minimap: boolean;
  onToggleMinimap: () => void;
  onHelp: () => void;
  onOpenAi: () => void;
}

const AI_TITLE = {
  off: "Connect an AI assistant to this board",
  connecting: "AI assistant: waiting for your assistant to connect",
  connected: "AI assistant connected",
  replaced: "AI assistant is connected to another tab",
} as const;

export function TopBar({ editor, bridge, minimap, onToggleMinimap, onHelp, onOpenAi }: Props) {
  useEditor(editor);
  const aiStatus = useSyncExternalStore(bridge.subscribe, () => bridge.status);
  const [menu, setMenu] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const { store } = editor;
  const settings = store.doc.settings;

  return (
    <>
      <div className="topbar left">
        <div className="pill">
          <button title="Menu" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="menu" />
          </button>
          <input
            className="title"
            aria-label="Board title"
            defaultValue={store.doc.title}
            key={store.doc.title}
            onBlur={(e) => {
              const t = e.target.value.trim() || "Untitled board";
              if (t !== store.doc.title) store.transact((d) => d.setTitle(t));
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </div>
        <div className="pill">
          <button title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled={!store.canUndo} onClick={() => store.undo()}>
            <Icon name="undo" />
          </button>
          <button title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled={!store.canRedo} onClick={() => store.redo()}>
            <Icon name="redo" />
          </button>
        </div>
      </div>

      <div className="topbar right">
        <button className={`ai-button ${aiStatus}`} title={AI_TITLE[aiStatus]} onClick={onOpenAi}>
          <Icon name="ai" size={18} />
          <span>AI</span>
          {aiStatus !== "off" && <span className="dot" aria-hidden="true" />}
        </button>
        <div className="pill">
          <button className={minimap ? "active" : ""} title="Minimap" aria-label="Toggle minimap" aria-pressed={minimap} onClick={onToggleMinimap}>
            <Icon name="map" />
          </button>
          <button title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={onHelp}>
            <Icon name="help" />
          </button>
        </div>
        <div className="pill">
          <button title="Zoom out (Ctrl/Cmd+−)" aria-label="Zoom out" onClick={() => editor.zoomStep(-1)}>
            <Icon name="minus" />
          </button>
          <button className="zoom" title="Reset to 100% (Ctrl/Cmd+0)" onClick={() => editor.zoomTo(1)}>
            {Math.round(editor.camera.zoom * 100)}%
          </button>
          <button title="Zoom in (Ctrl/Cmd++)" aria-label="Zoom in" onClick={() => editor.zoomStep(1)}>
            <Icon name="plus" />
          </button>
          <button title="Zoom to fit (Shift+1)" aria-label="Zoom to fit" onClick={() => editor.zoomToFit()}>
            <Icon name="fit" />
          </button>
        </div>
      </div>

      {menu && (
        <div className="menu" role="menu" onPointerLeave={() => setMenu(false)}>
          <button onClick={() => downloadBlob(exportJson(store.doc), `${store.doc.title || "board"}.whiteboard.json`)}>Export board (.json)</button>
          <button onClick={() => file.current?.click()}>Import board…</button>
          <button
            onClick={() => {
              const c = editor.viewportCenter();
              store.transact((d) => editor.select(addSampleBoard(d, c.x - 700, c.y - 300)));
              editor.zoomToFit(editor.selection);
              setMenu(false);
            }}
          >
            Insert sample content
          </button>
          <button onClick={() => { setMenu(false); onOpenAi(); }}>Connect an AI assistant…</button>
          <div className="menu-label">Background</div>
          <div className="menu-row">
            {BACKGROUNDS.map((b) => (
              <button key={b.value} className={`swatch ${settings.background === b.value ? "active" : ""}`} style={{ background: b.value }} title={b.label}
                onClick={() => store.setSettings({ background: b.value })} />
            ))}
          </div>
          <div className="menu-label">Grid</div>
          <div className="menu-row">
            {(["lines", "dots", "none"] as const).map((g) => (
              <button key={g} className={settings.grid === g ? "chip active" : "chip"} onClick={() => store.setSettings({ grid: g })}>{g}</button>
            ))}
          </div>
          <div className="menu-label">Mouse wheel</div>
          <div className="menu-row">
            {(["pan", "zoom"] as const).map((w) => (
              <button key={w} className={settings.wheel === w ? "chip active" : "chip"} onClick={() => store.setSettings({ wheel: w })}>{w}</button>
            ))}
          </div>
          <label className="menu-check">
            <input type="checkbox" checked={settings.snapping} onChange={(e) => store.setSettings({ snapping: e.target.checked })} /> Snap to objects (hold Alt to bypass)
          </label>
          <button
            className="danger"
            onClick={() => {
              if (confirm("Clear the whole board? This cannot be undone.")) {
                store.reset({ ...emptyDoc(), settings });
                editor.select([]);
              }
            }}
          >
            Clear board
          </button>
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const doc = await importJson(f);
          if (!doc) return alert("That file is not a whiteboard export.");
          store.reset(doc);
          editor.select([]);
          editor.zoomToFit();
          setMenu(false);
        }}
      />
    </>
  );
}
