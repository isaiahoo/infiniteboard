import { DEFAULT_SETTINGS, newId, type Asset, type Doc } from "./model";

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
