import { useEffect, useState } from "react";
import { makeImage, CLIPBOARD_MIME, parseClipboard } from "../core/ops";
import { imageFileToAsset, loadDoc, saveDoc } from "../core/persist";
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
import { Minimap } from "./Minimap";
import { useEditor } from "./useEditor";

const CAMERA_KEY = "whiteboard:camera";
const MINIMAP_KEY = "whiteboard:minimap";

function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Empty-board hint and the browser tab title; both follow document changes. */
function BoardChrome({ editor }: { editor: Editor }) {
  useEditor(editor);
  const { doc } = editor;
  useEffect(() => {
    document.title = doc.title ? `${doc.title} · Infiniteboard` : "Infiniteboard";
  }, [doc.title]);
  if (doc.order.length > 0 || editor.editingId) return null;
  return (
    <div className="empty-hint">
      <strong>Your board is empty</strong>
      <span>Press N for a sticky note, S for a shape, T for text, or double-click anywhere to type.</span>
      <span>Press ? for all shortcuts.</span>
    </div>
  );
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
    void loadDoc().then((doc) => {
      if (cancelled) return;
      const ed = new Editor(new Store(doc));
      try {
        const cam = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null");
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
      setEditor(ed);
      setBridge(aiBridge);
      setRemote(remoteLink);
    });
    return () => {
      cancelled = true;
      aiBridge?.dispose();
      remoteLink?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    // Autosave (debounced). Camera is a per-device preference kept in localStorage.
    let timer = 0;
    const offStore = editor.store.subscribe((doc) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void saveDoc(doc).catch((e) => console.error("Save failed", e)), 400);
    });
    let camTimer = 0;
    const offEditor = editor.subscribe(() => {
      clearTimeout(camTimer);
      camTimer = window.setTimeout(() => {
        try {
          localStorage.setItem(CAMERA_KEY, JSON.stringify(editor.camera));
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
      offStore();
      offEditor();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", blur);
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", paste);
    };
  }, [editor]);

  if (!editor || !bridge || !remote) return <div className="loading">Loading board…</div>;
  return (
    <div className="app">
      <Board editor={editor} />
      <BoardChrome editor={editor} />
      <TextEditor editor={editor} />
      <PropertyBar editor={editor} />
      <TopBar editor={editor} bridge={bridge} remote={remote} minimap={minimap} onToggleMinimap={toggleMinimap} onHelp={() => setHelp(true)} onOpenAi={() => setAiOpen(true)} />
      <Toolbar editor={editor} />
      {minimap && <Minimap editor={editor} />}
      {help && <HelpPanel onClose={() => setHelp(false)} />}
      {aiOpen && <AiDialog bridge={bridge} remote={remote} onClose={() => setAiOpen(false)} />}
    </div>
  );
}
