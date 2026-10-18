// Word-wrapping and auto-fit for canvas text. The measurer is injectable for tests.

export type Measure = (text: string, font: string) => number;

export const FONT_FAMILY = `"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
export const LINE_HEIGHT = 1.3;

let measureImpl: Measure = (text, font) => {
  // Fallback before a canvas exists: rough average glyph width.
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "16");
  return text.length * size * 0.55;
};

if (typeof document !== "undefined") {
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) {
    const cache = new Map<string, number>();
    measureImpl = (text, font) => {
      const key = font + "\u0000" + text;
      let w = cache.get(key);
      if (w === undefined) {
        ctx.font = font;
        w = ctx.measureText(text).width;
        if (cache.size > 20000) cache.clear();
        cache.set(key, w);
      }
      return w;
    };
  }
}

/** Width of `text` in `font` (canvas units). */
export function measureText(text: string, font: string): number {
  return measureImpl(text, font);
}

export function setMeasure(m: Measure) {
  measureImpl = m;
}

export function fontString(size: number, bold?: boolean, italic?: boolean): string {
  return `${italic ? "italic " : ""}${bold ? "700 " : "400 "}${size}px ${FONT_FAMILY}`;
}

/** Wraps text to `maxWidth`, breaking long words by character. Explicit newlines are kept. */
export function wrapText(text: string, font: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const tokens = para.split(/(\s+)/).filter((t) => t.length > 0);
    let line = "";
    for (const tok of tokens) {
      if (measureImpl(line + tok, font) <= maxWidth) {
        line += tok;
        continue;
      }
      if (/^\s+$/.test(tok)) {
        out.push(line.trimEnd());
        line = "";
        continue;
      }
      if (line.trim() !== "") out.push(line.trimEnd());
      line = "";
      if (measureImpl(tok, font) <= maxWidth) {
        line = tok;
        continue;
      }
      // A single word wider than the line: break it by characters.
      for (const ch of tok) {
        if (line && measureImpl(line + ch, font) > maxWidth) {
          out.push(line);
          line = ch;
        } else line += ch;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function textHeight(lines: number, fontSize: number) {
  return Math.max(1, lines) * fontSize * LINE_HEIGHT;
}

/** Largest font size (binary search) at which the text fits in the box. */
export function fitFontSize(text: string, w: number, h: number, maxSize = 64, minSize = 6, bold = false): number {
  if (!text.trim()) return Math.min(maxSize, Math.max(minSize, Math.min(w, h) / 6));
  let lo = minSize;
  let hi = maxSize;
  const words = text.split(/\s+/).filter(Boolean);
  // Prefer sizes where no single word has to be broken across lines.
  const fits = (s: number, allowBreaks: boolean) => {
    const font = fontString(s, bold);
    if (!allowBreaks && words.some((wd) => measureImpl(wd, font) > w)) return false;
    const lines = wrapText(text, font, w);
    return textHeight(lines.length, s) <= h;
  };
  const allowBreaks = !fits(minSize, false);
  if (fits(hi, allowBreaks)) return hi;
  const fitsAt = (s: number) => fits(s, allowBreaks);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (fitsAt(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 4) / 4;
}

export const TEXT_PADDING = 4;
export const STICKY_PADDING = 14;

/** Height a free text element needs for its content at its current width. */
export function measureTextBlockHeight(text: string, fontSize: number, width: number, bold?: boolean, italic?: boolean) {
  const lines = wrapText(text || " ", fontString(fontSize, bold, italic), Math.max(1, width - TEXT_PADDING * 2));
  return textHeight(lines.length, fontSize) + TEXT_PADDING * 2;
}
