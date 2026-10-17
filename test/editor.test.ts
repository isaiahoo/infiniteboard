import { beforeAll, describe, expect, it } from "vitest";
import { endPoint } from "../src/core/elements";
import { emptyDoc, type ArrowEl, type BoardElement } from "../src/core/model";
import { Store } from "../src/core/store";
import { setMeasure } from "../src/core/text";
import { Editor, type PointerInput } from "../src/interaction/editor";

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  setMeasure((text, font) => text.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]) / 2));
});

function setup() {
  const ed = new Editor(new Store(emptyDoc()));
  ed.viewW = 1000;
  ed.viewH = 800;
  ed.camera = { x: 0, y: 0, zoom: 1 };
  return ed;
}

const at = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({ screen: { x, y }, button: 0, shift: false, alt: false, mod: false, ...extra });

function drag(ed: Editor, from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}) {
  ed.pointerDown(at(...from, extra));
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    ed.pointerMove(at(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, extra));
  }
  ed.pointerUp(at(...to, extra));
}

const els = (ed: Editor): BoardElement[] => ed.doc.order.map((id) => ed.doc.elements[id]);
const key = (k: string, extra: Partial<{ shift: boolean; mod: boolean; code: string }> = {}) => ({ key: k, code: extra.code ?? "", shift: false, alt: false, mod: false, repeat: false, ...extra });

describe("editor interactions", () => {
  it("drag-creates a shape, then returns to select with it selected", () => {
    const ed = setup();
    ed.setTool("shape");
    drag(ed, [100, 100], [300, 250]);
    const [s] = els(ed);
    expect(s).toMatchObject({ type: "shape", x: 100, y: 100, w: 200, h: 150 });
    expect(ed.tool).toBe("select");
    expect([...ed.selection]).toEqual([s.id]);
    ed.store.undo();
    expect(els(ed)).toHaveLength(0);
  });

  it("click with the shape tool places a default-sized shape", () => {
    const ed = setup();
    ed.setTool("shape");
    ed.pointerDown(at(400, 400));
    ed.pointerUp(at(400, 400));
    const [s] = els(ed);
    expect(s.w).toBeGreaterThan(20);
    expect(s.x + s.w / 2).toBeCloseTo(400);
  });

  it("moves selection, ignores tiny jitter, and snaps to neighbours", () => {
    const ed = setup();
    ed.setTool("shape");
    drag(ed, [0, 0], [100, 100]);
    ed.setTool("shape");
    drag(ed, [300, 0], [400, 100]);
    const [a, b] = els(ed);
    // Jitter below the threshold is a click, not a move.
    ed.pointerDown(at(330, 30));
    ed.pointerMove(at(331, 31));
    ed.pointerUp(at(331, 31));
    expect(ed.doc.elements[b.id].x).toBe(300);
    expect([...ed.selection]).toEqual([b.id]);
    // Drag b so its left edge lands 4px right of a's right edge → snaps flush.
    drag(ed, [350, 50], [154, 50]);
    expect(ed.doc.elements[b.id].x).toBe(100);
    expect(ed.doc.elements[a.id].x).toBe(0);
  });

  it("marquee selects intersecting elements but frames only when fully enclosed", () => {
    const ed = setup();
    ed.setTool("frame");
    drag(ed, [500, 500], [900, 700]);
    ed.setTool("shape");
    drag(ed, [100, 100], [200, 200]);
    ed.select([]);
    drag(ed, [0, 0], [600, 150]); // touches the shape, partially covers nothing of the frame
    expect(ed.selection.size).toBe(1);
    ed.select([]);
    drag(ed, [50, 50], [950, 750]);
    expect(ed.selection.size).toBe(2);
  });

  it("frames adopt elements and carry them when moved", () => {
    const ed = setup();
    ed.setTool("shape");
    drag(ed, [120, 120], [220, 220]);
    const shapeId = [...ed.selection][0];
    ed.setTool("frame");
    drag(ed, [100, 100], [500, 400]);
    const frameId = [...ed.selection][0];
    expect(ed.doc.elements[shapeId].parentId).toBe(frameId);
    // Drag the frame by an empty spot inside it.
    drag(ed, [400, 350], [600, 350]);
    expect(ed.doc.elements[frameId].x).toBe(300);
    expect(ed.doc.elements[shapeId].x).toBe(320);
    // Dragging the child out releases it.
    ed.select([]);
    drag(ed, [370, 170], [370, 600]);
    expect(ed.doc.elements[shapeId].parentId).toBeNull();
  });

  it("connector binds to shapes and follows them", () => {
    const ed = setup();
    ed.setTool("shape");
    drag(ed, [0, 0], [100, 100]);
    const a = [...ed.selection][0];
    ed.setTool("shape");
    drag(ed, [400, 0], [500, 100]);
    const b = [...ed.selection][0];
    ed.setTool("arrow");
    drag(ed, [50, 50], [420, 50]);
    const arrow = els(ed).find((e) => e.type === "arrow") as ArrowEl;
    expect(arrow.start.bind?.id).toBe(a);
    expect(arrow.end.bind?.id).toBe(b);
    expect(arrow.end.bind).toMatchObject({ u: 0, v: 0.5 });
    // Move b down; the arrow end follows without being edited.
    ed.select([b]);
    drag(ed, [450, 50], [450, 350]);
    // The arrow itself is untouched; its bound end is derived from the target.
    expect(ed.doc.elements[arrow.id]).toBe(arrow);
    expect(endPoint(ed.doc, arrow.end)).toEqual({ x: 400, y: 350 });
  });

  it("resizes from a corner handle and rotates with 45° snapping", () => {
    const ed = setup();
    ed.setTool("shape");
    drag(ed, [100, 100], [200, 200]);
    const id = [...ed.selection][0];
    drag(ed, [200, 200], [300, 260]);
    expect(ed.doc.elements[id]).toMatchObject({ x: 100, y: 100, w: 200, h: 160 });
    // Rotate handle sits 26px above the top-centre (200, 100).
    const cx = 200, cy = 180;
    ed.pointerDown(at(200, 100 - 26));
    // Pointer at ~47° clockwise from straight up around the centre.
    const ang = (-90 + 47) * (Math.PI / 180);
    ed.pointerMove(at(cx + Math.cos(ang) * 150, cy + Math.sin(ang) * 150));
    ed.pointerUp(at(cx + Math.cos(ang) * 150, cy + Math.sin(ang) * 150));
    expect(ed.doc.elements[id].angle).toBeCloseTo(Math.PI / 4);
  });

  it("pen strokes stay in the pen tool; eraser removes whole strokes", () => {
    const ed = setup();
    ed.setTool("pen");
    drag(ed, [100, 100], [300, 100]);
    drag(ed, [100, 300], [300, 300]);
    expect(els(ed).filter((e) => e.type === "stroke")).toHaveLength(2);
    expect(ed.tool).toBe("pen");
    ed.setTool("eraser");
    drag(ed, [200, 80], [200, 120]);
    expect(els(ed).filter((e) => e.type === "stroke")).toHaveLength(1);
    ed.store.undo();
    expect(els(ed).filter((e) => e.type === "stroke")).toHaveLength(2);
  });

  it("text tool: create, type, empty text is discarded without a history entry", () => {
    const ed = setup();
    ed.setTool("text");
    ed.pointerDown(at(100, 100));
    ed.pointerUp(at(100, 100));
    expect(ed.editingId).toBeTruthy();
    ed.stopEditing();
    expect(els(ed)).toHaveLength(0);
    expect(ed.store.canUndo).toBe(false);

    ed.setTool("sticky");
    ed.pointerDown(at(100, 100));
    ed.pointerUp(at(100, 100));
    ed.editText("Hello");
    ed.editText("Hello world");
    ed.stopEditing();
    const [n] = els(ed);
    expect(n).toMatchObject({ type: "sticky", text: "Hello world" });
    ed.store.undo();
    expect(els(ed)).toHaveLength(0); // creation + typing is one step
  });

  it("keyboard: delete, undo, select all, duplicate, escape, space-to-pan", () => {
    const ed = setup();
    ed.setTool("shape");
    drag(ed, [0, 0], [100, 100]);
    ed.keyDown(key("d", { mod: true }));
    expect(els(ed)).toHaveLength(2);
    expect(ed.doc.elements[[...ed.selection][0]].x).toBeGreaterThan(100);
    ed.keyDown(key("a", { mod: true }));
    expect(ed.selection.size).toBe(2);
    ed.keyDown(key("Delete"));
    expect(els(ed)).toHaveLength(0);
    ed.keyDown(key("z", { mod: true }));
    expect(els(ed)).toHaveLength(2);
    ed.keyDown(key("Escape"));
    expect(ed.selection.size).toBe(0);
    ed.keyDown(key(" ", { code: "Space" }));
    expect(ed.tool).toBe("hand");
    drag(ed, [500, 500], [600, 550]);
    expect(ed.camera).toMatchObject({ x: 100, y: 50 });
    ed.keyUp(key(" ", { code: "Space" }));
    expect(ed.tool).toBe("select");
  });

  it("wheel pans by default and ctrl+wheel zooms around the cursor", () => {
    const ed = setup();
    ed.onWheel({ x: 0, y: 0 }, 30, 40, false, false);
    expect(ed.camera).toMatchObject({ x: -30, y: -40 });
    const before = ed.toWorld({ x: 500, y: 400 });
    ed.onWheel({ x: 500, y: 400 }, 0, -20, true, false);
    expect(ed.camera.zoom).toBeGreaterThan(1);
    const after = ed.toWorld({ x: 500, y: 400 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("copy/paste duplicates content at the pointer", () => {
    const ed = setup();
    ed.setTool("sticky");
    ed.pointerDown(at(100, 100));
    ed.pointerUp(at(100, 100));
    ed.editText("note");
    ed.stopEditing();
    const payload = ed.copy()!;
    ed.pointerMove(at(700, 500));
    ed.paste(payload);
    const notes = els(ed);
    expect(notes).toHaveLength(2);
    expect(notes[1].x + notes[1].w / 2).toBeCloseTo(700);
    expect(notes[1].id).not.toBe(notes[0].id);
  });
});
