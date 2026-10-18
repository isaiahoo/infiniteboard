import { useEffect, useState } from "react";
import { makeImage, CLIPBOARD_MIME, parseClipboard } from "../core/ops";
import { loadBoard, rememberBoard, resolveBoard } from "../core/boards";
import { imageFileToAsset } from "../core/persist";
import { BoardSession } from "../core/session";
import { Store } from "../core/store";
import { isTextual } from "../core/model";
import { Editor } from "../interaction/editor";
import { Board } from "./Board";
import { PropertyBar } from "./PropertyBar";
import { TextEditor } from "./TextEditor";
import { Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";
import { addSampleBoard } from "./sample";
import { AiBridge } from "../ai/bridge";
import { RemoteLink } from "../ai/remote";
import { HelpPanel } from "./HelpPanel";
import { AiDialog } from "./AiDialog";
import { StartGuide } from "./StartGuide";
import { Minimap } from "./Minimap";
import { useEditor } from "./useEditor";

const CAMERA_KEY = "whiteboard:camera";
const cameraKey = (boardId: string) => `${CAMERA_KEY}:${boardId}`;
const MINIMAP_KEY = "whiteboard:minimap";

function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Start guide on an empty board, and the browser tab title; both follow document changes. */
function BoardChrome({ editor, remote, aiOpen, onOpenAi }: { editor: Editor; remote: RemoteLink; aiOpen: boolean; onOpenAi: () => void }) {
  useEditor(editor);
  const { doc } = editor;
  useEffect(() => {
    document.title = doc.title ? `${doc.title} · Infiniteboard` : "Infiniteboard";
  }, [doc.title]);
  // Picking a drawing tool means you're drawing yourself; the card would sit where you draw.
  const drawing = editor.tool !== "select" && editor.tool !== "hand";
  if (doc.order.length > 0 || editor.editingId || aiOpen || drawing) return null;
  return <StartGuide remote={remote} onOpenAi={onOpenAi} />;
}
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

export function App() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [bridge, setBridge] = useState<AiBridge | null>(null);
  const [remote, setRemote] = useState<RemoteLink | null>(null);
  const [session, setSession] = useState<BoardSession | null>(null);
  const [help, setHelp] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [minimap, setMinimap] = useState(() => readPref(MINIMAP_KEY, "on") === "on");

  const toggleMinimap = () => {
    setMinimap((v) => {
      try {
        localStorage.setItem(MINIMAP_KEY, v ? "off" : "on");
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  useEffect(() => {
    let cancelled = false;
    let aiBridge: AiBridge | null = null;
    let remoteLink: RemoteLink | null = null;
    let boardSession: BoardSession | null = null;
    const params = new URLSearchParams(location.search);
    void resolveBoard(params.get("board")).then(({ id, doc }) => {
      if (cancelled) return;
      rememberBoard(id);
      // Every board has its own address, so it can be bookmarked or reopened.
      if (params.get("board") !== id) {
        params.set("board", id);
        history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
      }
      const ed = new Editor(new Store(doc));
      ed.boardId = id;
      try {
        const cam = JSON.parse(localStorage.getItem(cameraKey(id)) ?? (id === "default" ? localStorage.getItem(CAMERA_KEY) : null) ?? "null");
        if (cam && typeof cam.zoom === "number") ed.camera = cam;
        else ed.camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
      } catch {
        ed.camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
      }
      // `?sample` seeds an empty board with demo content (handy for demos and smoke tests).
      if (new URLSearchParams(location.search).has("sample") && ed.doc.order.length === 0) {
        ed.store.transact((d) => addSampleBoard(d));
        ed.viewW = window.innerWidth;
        ed.viewH = window.innerHeight;
        ed.zoomToFit();
      }
      // Dev-only handle for the end-to-end script (scripts/e2e.mjs).
      if (import.meta.env.DEV) (window as unknown as { __editor: Editor }).__editor = ed;
      aiBridge = new AiBridge(ed);
      remoteLink = new RemoteLink(ed);
      boardSession = new BoardSession(id, ed.store, loadBoard);
      // Large deletions (by an assistant, or clearing the board) leave a restore point first.
      ed.beforeDestructive = (reason) => boardSession!.checkpoint(reason);
      setSession(boardSession);
      setEditor(ed);
      setBridge(aiBridge);
      setRemote(remoteLink);
    });
    return () => {
      cancelled = true;
      aiBridge?.dispose();
      remoteLink?.dispose();
      boardSession?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    // The board itself is saved by BoardSession. The camera is a per-device preference per board.
    let camTimer = 0;
    const offEditor = editor.subscribe(() => {
      clearTimeout(camTimer);
      camTimer = window.setTimeout(() => {
        try {
          localStorage.setItem(cameraKey(editor.boardId), JSON.stringify(editor.camera));
        } catch {
          /* storage unavailable */
        }
      }, 300);
    });

    const keyInput = (e: KeyboardEvent) => ({
      key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey, mod: isMac ? e.metaKey : e.ctrlKey, repeat: e.repeat,
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === "?") {
        setHelp((h) => !h);
        return e.preventDefault();
      }
      if (e.key === "Escape") setHelp(false);
      if (editor.keyDown(keyInput(e))) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => editor.keyUp(keyInput(e));

    const onCopy = (e: ClipboardEvent, cut = false) => {
      if (isEditableTarget(e.target) || !e.clipboardData) return;
      const payload = cut ? editor.cut() : editor.copy();
      if (!payload) return;
      e.preventDefault();
      const json = JSON.stringify(payload);
      e.clipboardData.setData(CLIPBOARD_MIME, json);
      // Plain-text fallback carries the visible text; HTML carries the data for cross-tab pastes.
      const plain = payload.elements.filter(isTextual).map((el) => el.text).filter(Boolean).join("\n");
      e.clipboardData.setData("text/plain", plain || " ");
      e.clipboardData.setData("text/html", `<span data-whiteboard="${encodeURIComponent(json)}"></span>`);
    };
    const onPaste = async (e: ClipboardEvent) => {
      if (isEditableTarget(e.target) || !e.clipboardData) return;
      const data = e.clipboardData;
      e.preventDefault();
      const images = [...data.files].filter((f) => f.type.startsWith("image/"));
      if (images.length) {
        for (const f of images) {
          const asset = await imageFileToAsset(f);
          editor.store.transact((d) => d.addAsset(asset));
          editor.insertElement(makeImage(asset, editor.pastePoint()));
        }
        return;
      }
      const custom = data.getData(CLIPBOARD_MIME);
      const html = /data-whiteboard="([^"]+)"/.exec(data.getData("text/html"))?.[1];
      const payload = parseClipboard(custom || (html ? decodeURIComponent(html) : ""));
      if (payload) return editor.paste(payload);
      const text = data.getData("text/plain");
      if (text.trim()) editor.pasteText(text);
    };
    const copy = (e: ClipboardEvent) => onCopy(e);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    const paste = (e: ClipboardEvent) => void onPaste(e);
    const blur = () => editor.keyUp({ key: " ", code: "Space", shift: false, alt: false, mod: false, repeat: false });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", blur);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", paste);
    return () => {
      offEditor();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", blur);
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", paste);
    };
  }, [editor]);

  if (!editor || !bridge || !remote || !session) return <div className="loading">Loading board…</div>;
  return (
    <div className="app">
      <Board editor={editor} />
      <BoardChrome editor={editor} remote={remote} aiOpen={aiOpen} onOpenAi={() => setAiOpen(true)} />
      <TextEditor editor={editor} />
      <PropertyBar editor={editor} />
      <TopBar editor={editor} bridge={bridge} remote={remote} session={session} minimap={minimap} onToggleMinimap={toggleMinimap} onHelp={() => setHelp(true)} onOpenAi={() => setAiOpen(true)} />
      <Toolbar editor={editor} />
      {minimap && <Minimap editor={editor} />}
      {help && <HelpPanel onClose={() => setHelp(false)} />}
      {aiOpen && <AiDialog bridge={bridge} remote={remote} onClose={() => setAiOpen(false)} />}
    </div>
  );
}
