import type { Rect, Vec } from "./geom";

/** screen = world * zoom + (x, y) */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const screenToWorld = (c: Camera, p: Vec): Vec => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom });
export const worldToScreen = (c: Camera, p: Vec): Vec => ({ x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y });

/** Zooms so that the world point under `screenPt` stays under it. */
export function zoomAt(c: Camera, screenPt: Vec, zoom: number): Camera {
  const z = clampZoom(zoom);
  const w = screenToWorld(c, screenPt);
  return { zoom: z, x: screenPt.x - w.x * z, y: screenPt.y - w.y * z };
}

export function nextZoomStep(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 1e-6) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z - 1e-6) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

export function visibleWorldRect(c: Camera, viewW: number, viewH: number): Rect {
  return { x: -c.x / c.zoom, y: -c.y / c.zoom, w: viewW / c.zoom, h: viewH / c.zoom };
}

/** Camera that fits `r` inside the viewport with a margin, never zooming beyond 100%. */
export function fitRect(r: Rect, viewW: number, viewH: number, margin = 80): Camera {
  const zoom = clampZoom(Math.min(1, (viewW - margin * 2) / Math.max(r.w, 1), (viewH - margin * 2) / Math.max(r.h, 1)));
  return { zoom, x: viewW / 2 - (r.x + r.w / 2) * zoom, y: viewH / 2 - (r.y + r.h / 2) * zoom };
}
