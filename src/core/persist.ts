import { DEFAULT_SETTINGS, emptyDoc, newId, type Asset, type Doc } from "./model";

const DB_NAME = "whiteboard";
const STORE = "boards";
const KEY = "default";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDoc(): Promise<Doc> {
  try {
    const db = await openDb();
    try {
      const data = await new Promise<unknown>((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return normalizeDoc(data) ?? emptyDoc();
    } finally {
      db.close();
    }
  } catch {
    return emptyDoc();
  }
}

export async function saveDoc(doc: Doc): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(doc, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    // Closing lets other tabs upgrade or delete the database without being blocked.
    db.close();
  }
}

/** Validates loosely and fills in fields added in later versions. */
export function normalizeDoc(data: unknown): Doc | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<Doc>;
  if (!d.elements || !Array.isArray(d.order)) return null;
  const order = d.order.filter((id) => typeof id === "string" && id in d.elements!);
  return {
    title: typeof d.title === "string" ? d.title : "Untitled board",
    elements: d.elements,
    order,
    assets: d.assets ?? {},
    settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
  };
}

export function exportJson(doc: Doc): Blob {
  return new Blob([JSON.stringify({ format: "whiteboard", version: 1, doc })], { type: "application/json" });
}

export async function importJson(file: File): Promise<Doc | null> {
  try {
    const parsed = JSON.parse(await file.text());
    return normalizeDoc(parsed?.format === "whiteboard" ? parsed.doc : parsed);
  } catch {
    return null;
  }
}

/** Reads an image file into an asset, downscaling large images to keep boards light. */
export async function imageFileToAsset(file: Blob, maxSide = 2048): Promise<Asset> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Unsupported image"));
      i.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const type = file.type === "image/png" || file.type === "image/gif" || file.type === "image/svg+xml" ? "image/png" : "image/jpeg";
    return { id: newId(), dataUrl: canvas.toDataURL(type, 0.9), width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
