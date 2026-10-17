import { describe, expect, it } from "vitest";
import { nextZoomStep, screenToWorld, worldToScreen, zoomAt } from "../src/core/camera";
import { arrowGeometry, endPoint, findBinding, frameFor, hitTest } from "../src/core/elements";
import { simplify, snapAngle } from "../src/core/geom";
import { emptyDoc, type ArrowEl, type ShapeEl, type TextEl } from "../src/core/model";
import {
  deleteElements, duplicate, makeArrow, makeFrame, makeShape, makeText, pastePayload, reorder, serializeSelection,
} from "../src/core/ops";
import { snapRect } from "../src/core/snap";
import { HISTORY_LIMIT, Store } from "../src/core/store";
import { setMeasure, wrapText } from "../src/core/text";
import { resizeSingle } from "../src/core/transform";

// Deterministic text metrics: every glyph is 10px wide at 20px.
setMeasure((text, font) => text.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]) / 2));

const shape = (x: number, y: number, w = 100, h = 100): ShapeEl => makeShape("rect", { x, y, w, h });

describe("camera", () => {
  it("round-trips screen and world coordinates", () => {
    const c = { x: 120, y: -40, zoom: 2.5 };
    const p = { x: 33, y: 77 };
    const back = worldToScreen(c, screenToWorld(c, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const c = { x: 10, y: 20, zoom: 1 };
    const cursor = { x: 400, y: 300 };
    const before = screenToWorld(c, cursor);
    const after = screenToWorld(zoomAt(c, cursor, 3.7), cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("steps through preset zoom levels and clamps", () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    expect(nextZoomStep(0.9, 1)).toBe(1);
    expect(nextZoomStep(8, 1)).toBe(8);
  });
});

describe("store & history", () => {
  it("folds a gesture into one undo step and redoes it", () => {
    const s = new Store(emptyDoc());
    const el = shape(0, 0);
    s.transact((d) => d.set(el));
    s.begin();
    for (let i = 1; i <= 10; i++) s.update((d) => d.patch(el.id, { x: i * 10 }));
    s.commit();
    expect(s.doc.elements[el.id].x).toBe(100);
    s.undo();
    expect(s.doc.elements[el.id].x).toBe(0);
    s.undo();
    expect(s.doc.elements[el.id]).toBeUndefined();
    expect(s.doc.order).toEqual([]);
    s.redo();
    s.redo();
    expect(s.doc.elements[el.id].x).toBe(100);
  });

  it("does not record empty gestures and clears redo on new edits", () => {
    const s = new Store(emptyDoc());
    s.begin();
    s.commit();
    expect(s.canUndo).toBe(false);
    const a = shape(0, 0);
    s.transact((d) => d.set(a));
    s.undo();
    expect(s.canRedo).toBe(true);
    s.transact((d) => d.set(shape(5, 5)));
    expect(s.canRedo).toBe(false);
  });

  it("caps history length", () => {
    const s = new Store(emptyDoc());
    const el = shape(0, 0);
    s.transact((d) => d.set(el));
    for (let i = 0; i < HISTORY_LIMIT + 50; i++) s.transact((d) => d.patch(el.id, { x: i }));
    let n = 0;
    while (s.canUndo) {
      s.undo();
      n++;
    }
    expect(n).toBe(HISTORY_LIMIT);
  });

  it("cancel restores the pre-gesture document", () => {
    const s = new Store(emptyDoc());
    const el = shape(0, 0);
    s.transact((d) => d.set(el));
    s.begin();
    s.update((d) => d.patch(el.id, { x: 500 }));
    s.cancel();
    expect(s.doc.elements[el.id].x).toBe(0);
  });
});

describe("arrows", () => {
  it("bound endpoints follow their target", () => {
    const s = new Store(emptyDoc());
    const box = shape(100, 100);
    const arrow = makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 });
    arrow.end = { x: 0, y: 0, bind: { id: box.id, u: 0, v: 0.5 } };
    s.transact((d) => {
      d.set(box);
      d.set(arrow);
    });
    expect(endPoint(s.doc, arrow.end)).toEqual({ x: 100, y: 150 });
    s.transact((d) => d.patch(box.id, { x: 300 }));
    expect(endPoint(s.doc, (s.doc.elements[arrow.id] as ArrowEl).end)).toEqual({ x: 300, y: 150 });
  });

  it("binds to side midpoints when the pointer is inside an element", () => {
    const doc = emptyDoc();
    const box = shape(0, 0, 200, 100);
    const d = { ...doc, elements: { [box.id]: box }, order: [box.id] };
    const b = findBinding(d, { x: 190, y: 55 }, 1)!;
    expect(b.id).toBe(box.id);
    expect([b.u, b.v]).toEqual([1, 0.5]);
    expect(findBinding(d, { x: 500, y: 500 }, 1)).toBeNull();
  });

  it("routes elbow connectors with only axis-aligned segments", () => {
    const a = shape(0, 0);
    const b = shape(300, 200);
    const arrow: ArrowEl = { ...makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 }), route: "elbow" };
    arrow.start = { x: 0, y: 0, bind: { id: a.id, u: 1, v: 0.5 } };
    arrow.end = { x: 0, y: 0, bind: { id: b.id, u: 0, v: 0.5 } };
    const doc = { ...emptyDoc(), elements: { [a.id]: a, [b.id]: b, [arrow.id]: arrow }, order: [a.id, b.id, arrow.id] };
    const pts = arrowGeometry(doc, arrow).points;
    expect(pts[0]).toEqual({ x: 100, y: 50 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 250 });
    for (let i = 1; i < pts.length; i++) {
      const horizontal = Math.abs(pts[i].y - pts[i - 1].y) < 1e-9;
      const vertical = Math.abs(pts[i].x - pts[i - 1].x) < 1e-9;
      expect(horizontal || vertical).toBe(true);
    }
  });

  it("hit-tests the line, not its bounding box", () => {
    const arrow = makeArrow({ x: 0, y: 0 }, { x: 100, y: 100 });
    const doc = { ...emptyDoc(), elements: { [arrow.id]: arrow }, order: [arrow.id] };
    expect(hitTest(doc, arrow, { x: 50, y: 52 }, 1)).toBe(true);
    expect(hitTest(doc, arrow, { x: 90, y: 10 }, 1)).toBe(false);
  });
});

describe("ops", () => {
  it("deleting a target leaves arrows with a free end at the old position", () => {
    const s = new Store(emptyDoc());
    const box = shape(100, 100);
    const arrow = makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 });
    arrow.end = { x: 0, y: 0, bind: { id: box.id, u: 0.5, v: 0 } };
    s.transact((d) => {
      d.set(box);
      d.set(arrow);
    });
    s.transact((d) => deleteElements(d, [box.id]));
    const a = s.doc.elements[arrow.id] as ArrowEl;
    expect(a.end.bind ?? null).toBeNull();
    expect([a.end.x, a.end.y]).toEqual([150, 100]);
  });

  it("deleting a frame deletes its children", () => {
    const s = new Store(emptyDoc());
    const f = makeFrame({ x: 0, y: 0, w: 500, h: 500 }, "F");
    const child = { ...shape(10, 10), parentId: f.id };
    s.transact((d) => {
      d.set(f);
      d.set(child);
    });
    s.transact((d) => deleteElements(d, [f.id]));
    expect(Object.keys(s.doc.elements)).toEqual([]);
  });

  it("duplicates a frame with its children and remaps internal references", () => {
    const s = new Store(emptyDoc());
    const f = makeFrame({ x: 0, y: 0, w: 500, h: 500 }, "F");
    const a = { ...shape(10, 10), parentId: f.id };
    const b = { ...shape(200, 10), parentId: f.id };
    const arrow = { ...makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 }), parentId: f.id };
    arrow.start = { x: 0, y: 0, bind: { id: a.id, u: 1, v: 0.5 } };
    arrow.end = { x: 0, y: 0, bind: { id: b.id, u: 0, v: 0.5 } };
    s.transact((d) => [f, a, b, arrow].forEach((e) => d.set(e)));
    let ids: string[] = [];
    s.transact((d) => {
      ids = duplicate(d, [f.id], 600, 0);
    });
    expect(ids).toHaveLength(1);
    const els = Object.values(s.doc.elements);
    expect(els).toHaveLength(8);
    const newFrame = s.doc.elements[ids[0]];
    const kids = els.filter((e) => e.parentId === newFrame.id);
    expect(kids).toHaveLength(3);
    const newArrow = kids.find((e) => e.type === "arrow") as ArrowEl;
    expect(kids.map((k) => k.id)).toContain(newArrow.start.bind!.id);
    expect(endPoint(s.doc, newArrow.start)).toEqual({ x: 710, y: 60 });
  });

  it("copy/paste recentres, gives new ids and drops bindings to uncopied targets", () => {
    const s = new Store(emptyDoc());
    const a = shape(0, 0);
    const outside = shape(500, 0);
    const arrow = makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 });
    arrow.start = { x: 0, y: 0, bind: { id: a.id, u: 1, v: 0.5 } };
    arrow.end = { x: 0, y: 0, bind: { id: outside.id, u: 0, v: 0.5 } };
    s.transact((d) => [a, outside, arrow].forEach((e) => d.set(e)));
    const payload = serializeSelection(s.doc, [a.id, arrow.id]);
    let pasted: string[] = [];
    s.transact((d) => {
      pasted = pastePayload(d, payload, { x: 1000, y: 1000 });
    });
    expect(pasted).toHaveLength(2);
    expect(pasted).not.toContain(a.id);
    const pa = pasted.map((id) => s.doc.elements[id]).find((e) => e.type === "arrow") as ArrowEl;
    expect(pa.start.bind).toBeTruthy();
    expect(pa.end.bind ?? null).toBeNull();
  });

  it("reorders the paint order", () => {
    const s = new Store(emptyDoc());
    const [a, b, c] = [shape(0, 0), shape(1, 1), shape(2, 2)];
    s.transact((d) => [a, b, c].forEach((e) => d.set(e)));
    s.transact((d) => reorder(d, [a.id], "front"));
    expect(s.doc.order).toEqual([b.id, c.id, a.id]);
    s.transact((d) => reorder(d, [a.id], "backward"));
    expect(s.doc.order).toEqual([b.id, a.id, c.id]);
  });

  it("frame membership needs half the element inside", () => {
    const f = makeFrame({ x: 0, y: 0, w: 300, h: 300 }, "F");
    const doc = { ...emptyDoc(), elements: { [f.id]: f }, order: [f.id] };
    expect(frameFor(doc, { x: 250, y: 10, w: 100, h: 100 })?.id).toBe(f.id); // 50% inside
    expect(frameFor(doc, { x: 260, y: 10, w: 100, h: 100 })).toBeNull(); // 40% inside
  });
});

describe("resize", () => {
  it("keeps the opposite corner fixed for a rotated element", () => {
    const el = { ...shape(0, 0, 100, 50), angle: Math.PI / 2 };
    // With a 90° rotation the local top-left corner maps to world (75, -25).
    const anchorBefore = { x: 75, y: -25 };
    const patch = resizeSingle(el, { sx: 1, sy: 1 }, { x: -20, y: 200 }, false) as ShapeEl;
    const next = { ...el, ...patch };
    const c = { x: next.x + next.w / 2, y: next.y + next.h / 2 };
    const tl = { x: next.x, y: next.y };
    const rotated = { x: c.x - (tl.y - c.y), y: c.y + (tl.x - c.x) };
    expect(rotated.x).toBeCloseTo(anchorBefore.x);
    expect(rotated.y).toBeCloseTo(anchorBefore.y);
  });

  it("scales text font size from corners and rewraps from sides", () => {
    const t: TextEl = { ...makeText({ x: 0, y: 0 }, null, "hello world foo bar"), w: 400 };
    const corner = resizeSingle(t, { sx: 1, sy: 1 }, { x: 800, y: t.h * 1.5 }, false) as TextEl;
    expect(corner.fontSize).toBeCloseTo(t.fontSize * 2);
    const side = resizeSingle(t, { sx: 1, sy: 0 }, { x: 60, y: 0 }, false) as TextEl;
    expect(side.w).toBeCloseTo(60);
    expect(side.h).toBeGreaterThan(t.h);
  });
});

describe("snapping & geometry", () => {
  it("snaps edges and centres within the threshold and reports guides", () => {
    const res = snapRect({ x: 103, y: 500, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 100 }], 7);
    expect(res.dx).toBe(-3); // left edge → right edge of the candidate
    expect(res.dy).toBe(0);
    expect(res.guides).toHaveLength(1);
    expect(snapRect({ x: 120, y: 500, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 100 }], 7).dx).toBe(0);
  });

  it("snaps rotation to 45° only when close", () => {
    expect(snapAngle((47 * Math.PI) / 180, Math.PI / 4, (4 * Math.PI) / 180)).toBeCloseTo(Math.PI / 4);
    expect(snapAngle((52 * Math.PI) / 180, Math.PI / 4, (4 * Math.PI) / 180)).toBeCloseTo((52 * Math.PI) / 180);
  });

  it("simplifies collinear points away but keeps corners", () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }];
    expect(simplify(pts, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it("wraps text by words and breaks long words", () => {
    const font = "400 20px sans-serif"; // 10px per glyph
    expect(wrapText("aaa bbb ccc", font, 75)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapText("abcdefghij", font, 40)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", font, 100)).toEqual(["a", "", "b"]);
  });
});
