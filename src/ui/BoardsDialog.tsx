import { useEffect, useRef, useState } from "react";
import { emptyOverlay, render } from "../canvas/render";
import { fitRect } from "../core/camera";
import {
  createBoard, deleteBoardForever, exportAllBoards, importBoards, listBoards, listSnapshots, loadBoard, loadSnapshot,
  restoreBoard, trashBoard, TRASH_DAYS, type BoardMeta, type SnapshotInfo,
} from "../core/boards";
import type { Doc } from "../core/model";
import { replaceContent, selectionBounds } from "../core/ops";
import { downloadBlob } from "../core/persist";
import type { BoardSession } from "../core/session";
import type { Editor } from "../interaction/editor";

/** Opens another board (after saving this one). Boards are separate pages, so this reloads. */
export async function openBoard(session: BoardSession | null, id: string) {
  await session?.flush();
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (params.get("mcp")) keep.set("mcp", params.get("mcp")!);
  keep.set("board", id);
  location.assign(`${location.pathname}?${keep}`);
}

export function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div className={`dialog ${wide ? "history-dialog" : "boards-dialog"}`} role="dialog" aria-modal="true" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

export function BoardsDialog({ editor, session, onClose }: { editor: Editor; session: BoardSession; onClose: () => void }) {
  const [boards, setBoards] = useState<BoardMeta[] | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    await session.flush();
    setBoards(await listBoards());
  };
  useEffect(() => void refresh(), []);

  const live = boards?.filter((b) => !b.deletedAt) ?? [];
  const trash = boards?.filter((b) => b.deletedAt) ?? [];
  const current = editor.boardId;

  return (
    <Dialog title="Boards" onClose={onClose}>
      <div className="boards-actions">
        <button className="primary" onClick={async () => openBoard(session, await createBoard())}>New board</button>
        <button onClick={() => file.current?.click()}>Import…</button>
        <button onClick={async () => downloadBlob(await exportAllBoards(), `infiniteboard-backup-${new Date().toISOString().slice(0, 10)}.json`)}>Back up all boards</button>
      </div>
      <p className="muted small">Boards are saved automatically in this browser. Back them up to move them to another browser or keep a copy.</p>

      {!boards ? <p className="muted">Loading…</p> : (
        <ul className="board-list">
          {live.map((b) => (
            <li key={b.id} className={b.id === current ? "current" : ""}>
              <button className="board-open" onClick={() => (b.id === current ? onClose() : void openBoard(session, b.id))}>
                <b>{b.title || "Untitled board"}</b>
                <span>{b.id === current ? "Open now · " : ""}{items(b.count)} · edited {ago(b.updatedAt)}</span>
              </button>
              <button title="Duplicate" onClick={async () => {
                const doc = await loadBoard(b.id);
                if (doc) await createBoard({ ...doc, title: `${doc.title} (copy)` });
                await refresh();
              }}>Duplicate</button>
              <button title="Move to trash" onClick={async () => {
                await trashBoard(b.id);
                if (b.id === current) {
                  const next = live.find((x) => x.id !== b.id);
                  await openBoard(null, next ? next.id : await createBoard());
                } else await refresh();
              }}>Delete</button>
            </li>
          ))}
        </ul>
      )}

      {trash.length > 0 && (
        <details className="trash" open={showTrash} onToggle={(e) => setShowTrash((e.target as HTMLDetailsElement).open)}>
          <summary>Recently deleted ({trash.length})</summary>
          <p className="muted small">Deleted boards are kept for {TRASH_DAYS} days.</p>
          <ul className="board-list">
            {trash.map((b) => (
              <li key={b.id}>
                <span className="board-open static">
                  <b>{b.title || "Untitled board"}</b>
                  <span>{items(b.count)} · deleted {ago(b.deletedAt!)}</span>
                </span>
                <button onClick={async () => { await restoreBoard(b.id); await refresh(); }}>Restore</button>
                <button className="danger" onClick={async () => {
                  if (confirm(`Delete "${b.title}" forever? This can't be undone.`)) {
                    await deleteBoardForever(b.id);
                    await refresh();
                  }
                }}>Delete forever</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        const ids = await importBoards(f);
        if (!ids.length) return alert("That file isn't an InfiniteBoard export or backup.");
        if (ids.length === 1) await openBoard(session, ids[0]);
        else await refresh();
      }} />
    </Dialog>
  );
}

const REASON_LABEL: Record<string, string> = { "Auto-save": "Autosaved", Opened: "When opened" };

function Preview({ doc }: { doc: Doc | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !doc) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const b = selectionBounds(doc, doc.order);
    const cam = b ? fitRect(b, w, h, 20) : { x: w / 2, y: h / 2, zoom: 1 };
    render(c.getContext("2d")!, doc, cam, w, h, dpr, emptyOverlay(), () => {});
  }, [doc]);
  return <canvas ref={ref} className="history-preview" />;
}

export function HistoryDialog({ editor, session, onClose }: { editor: Editor; session: BoardSession; onClose: () => void }) {
  const [snaps, setSnaps] = useState<SnapshotInfo[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);

  useEffect(() => {
    void session.flush().then(() => listSnapshots(session.boardId)).then((s) => {
      setSnaps(s);
      if (s.length) setPicked(s[0].id);
    });
  }, [session]);
  useEffect(() => {
    if (picked === null) return;
    let stale = false;
    void loadSnapshot(picked).then((d) => !stale && setDoc(d));
    return () => {
      stale = true;
    };
  }, [picked]);

  const restore = async () => {
    if (!doc) return;
    await session.checkpoint("Before restoring an earlier version");
    editor.store.transact((d) => replaceContent(d, doc));
    editor.select([]);
    editor.zoomToFit();
    onClose();
  };

  const info = snaps?.find((s) => s.id === picked);
  return (
    <Dialog title="Version history" onClose={onClose} wide>
      {!snaps ? <p className="muted">Loading…</p> : !snaps.length ? (
        <p className="muted">No earlier versions yet. InfiniteBoard keeps one every 10 minutes while you work, when you open a board, and before anything big is deleted.</p>
      ) : (
        <div className="history">
          <ul className="history-list">
            {snaps.map((s) => (
              <li key={s.id}>
                <button className={s.id === picked ? "active" : ""} onClick={() => setPicked(s.id)}>
                  <b>{new Date(s.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</b>
                  <span>{REASON_LABEL[s.reason] ?? s.reason} · {items(s.count)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-side">
            <Preview doc={doc} />
            <p className="muted small">{info ? `${ago(info.at)} · ${items(info.count)}` : ""}</p>
            <button className="primary" disabled={!doc} onClick={() => void restore()}>Restore this version</button>
            <p className="muted small">The current board is kept as a version first, and you can undo the restore.</p>
          </div>
        </div>
      )}
    </Dialog>
  );
}
