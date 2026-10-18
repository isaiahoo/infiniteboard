import { useState, useSyncExternalStore } from "react";
import type { AiBridge } from "../ai/bridge";
import type { RemoteLink } from "../ai/remote";
import { createBoard } from "../core/boards";
import { downloadBlob, exportJson } from "../core/persist";
import type { BoardSession } from "../core/session";
import { deleteElements } from "../core/ops";
import { BoardsDialog, HistoryDialog, openBoard } from "./BoardsDialog";
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
  remote: RemoteLink;
  session: BoardSession;
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

const SAVE_LABEL = { saved: "Saved", saving: "Saving…", error: "Not saved" } as const;
const SAVE_TITLE = {
  saved: "Saved in this browser. Earlier versions are in the menu under Version history.",
  saving: "Saving in this browser…",
  error: "Couldn't save to this browser's storage (it may be full). Retrying; your changes are kept while this tab is open. Export the board to keep a copy.",
} as const;

function SaveStatus({ session }: { session: BoardSession }) {
  const status = useSyncExternalStore(session.subscribe, session.getStatus);
  return <span className={`save-status ${status}`} role="status" title={SAVE_TITLE[status]}>{SAVE_LABEL[status]}</span>;
}

export function TopBar({ editor, bridge, remote, session, minimap, onToggleMinimap, onHelp, onOpenAi }: Props) {
  useEditor(editor);
  const localStatus = useSyncExternalStore(bridge.subscribe, () => bridge.status);
  useSyncExternalStore(remote.subscribe, remote.getSnapshot);
  // One indicator for both connection types: green once an app can use the board, amber while waiting.
  const aiStatus: keyof typeof AI_TITLE =
    localStatus === "connected" || (remote.status === "ready" && remote.apps.length > 0) ? "connected"
    : remote.status === "replaced" || localStatus === "replaced" ? "replaced"
    : remote.status === "off" && localStatus === "off" ? "off"
    : "connecting";
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"boards" | "history" | null>(null);
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
          <SaveStatus session={session} />
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
          <button onClick={() => { setMenu(false); setDialog("boards"); }}>All boards…</button>
          <button onClick={async () => openBoard(session, await createBoard())}>New board</button>
          <button onClick={() => { setMenu(false); setDialog("history"); }}>Version history…</button>
          <button onClick={() => downloadBlob(exportJson(store.doc), `${store.doc.title || "board"}.whiteboard.json`)}>Export this board (.json)</button>
          <div className="menu-sep" />
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
            disabled={!store.doc.order.length}
            onClick={async () => {
              setMenu(false);
              // Undoable, and a restore point is kept in Version history.
              await session.checkpoint("Before clearing the board");
              store.transact((d) => deleteElements(d, [...d.doc.order]));
              editor.select([]);
            }}
          >
            Clear board
          </button>
        </div>
      )}
      {dialog === "boards" && <BoardsDialog editor={editor} session={session} onClose={() => setDialog(null)} />}
      {dialog === "history" && <HistoryDialog editor={editor} session={session} onClose={() => setDialog(null)} />}
    </>
  );
}
