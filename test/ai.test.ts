import { beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/ai/commands";
import { endPoint } from "../src/core/elements";
import { emptyDoc, type ArrowEl } from "../src/core/model";
import { Store } from "../src/core/store";
import { setMeasure } from "../src/core/text";
import { Editor } from "../src/interaction/editor";

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  setMeasure((text, font) => text.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]) / 2));
});

function setup() {
  const ed = new Editor(new Store(emptyDoc()));
  ed.viewW = 1000;
  ed.viewH = 800;
  ed.camera = { x: 500, y: 400, zoom: 1 };
  return ed;
}

type Created = { created: { ref?: string; id: string; type: string }[] };

describe("AI commands", () => {
  it("creates linked elements with refs in one undo step", async () => {
    const ed = setup();
    const res = (await runCommand(ed, "create_elements", {
      elements: [
        { type: "sticky", ref: "a", text: "Idea", x: 0, y: 0, color: "blue" },
        { type: "shape", ref: "b", kind: "diamond", text: "Decide", x: 400, y: 0 },
        { type: "connector", from: "a", to: "b", label: "next", route: "elbow" },
      ],
    })) as Created;
    expect(res.created.map((c) => c.type)).toEqual(["sticky", "shape", "connector"]);
    const arrow = ed.doc.elements[res.created[2].id] as ArrowEl;
    expect(arrow.start.bind).toMatchObject({ id: res.created[0].id, u: 1, v: 0.5 });
    expect(arrow.end.bind).toMatchObject({ id: res.created[1].id, u: 0, v: 0.5 });
    expect(arrow.label).toBe("next");
    ed.store.undo();
    expect(ed.doc.order).toHaveLength(0);
  });

  it("auto-places elements without coordinates so they don't overlap", async () => {
    const ed = setup();
    await runCommand(ed, "create_elements", { elements: [{ type: "sticky", x: 0, y: 0 }] });
    const res = (await runCommand(ed, "create_elements", { elements: [{ type: "sticky" }, { type: "sticky" }] })) as Created;
    const [a, b] = res.created.map((c) => ed.doc.elements[c.id]);
    expect(a.x).toBeGreaterThan(180);
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.w);
  });

  it("frames adopt elements placed inside them", async () => {
    const ed = setup();
    const res = (await runCommand(ed, "create_elements", {
      elements: [
        { type: "frame", ref: "f", title: "Plan", x: 0, y: 0, w: 600, h: 400 },
        { type: "sticky", ref: "s", x: 50, y: 50 },
      ],
    })) as Created;
    const frame = ed.doc.elements[res.created[0].id];
    expect(ed.doc.elements[res.created[1].id].parentId).toBe(frame.id);
    expect(ed.doc.order[0]).toBe(frame.id); // frames paint underneath
  });

  it("updates text, colour, geometry and connector targets", async () => {
    const ed = setup();
    const res = (await runCommand(ed, "create_elements", {
      elements: [
        { type: "sticky", ref: "a", x: 0, y: 0 },
        { type: "sticky", ref: "b", x: 400, y: 0 },
        { type: "sticky", ref: "c", x: 0, y: 400 },
        { type: "connector", ref: "k", from: "a", to: "b" },
      ],
    })) as Created;
    const [a, , c, k] = res.created.map((x) => x.id);
    await runCommand(ed, "update_elements", {
      updates: [
        { id: a, text: "Hello", color: "pink", x: 10 },
        { id: k, to: c, route: "curved" },
      ],
    });
    expect(ed.doc.elements[a]).toMatchObject({ text: "Hello", x: 10 });
    expect((ed.doc.elements[a] as { fill: string }).fill).not.toBe("#fff3a3");
    const arrow = ed.doc.elements[k] as ArrowEl;
    expect(arrow.end.bind?.id).toBe(c);
    expect(arrow.route).toBe("curved");
    expect(endPoint(ed.doc, arrow.end).y).toBe(400); // top side of c
  });

  it("reads the board compactly and deletes", async () => {
    const ed = setup();
    await runCommand(ed, "create_elements", { elements: [{ type: "text", text: "Title", x: 0, y: 0 }, { type: "shape", x: 0, y: 100 }] });
    const board = (await runCommand(ed, "get_board", {})) as { elements: { id: string; type: string; text?: string }[]; elementCount: number };
    expect(board.elementCount).toBe(2);
    expect(board.elements[0]).toMatchObject({ type: "text", text: "Title" });
    const shapesOnly = (await runCommand(ed, "get_board", { type: "shape" })) as { elements: unknown[] };
    expect(shapesOnly.elements).toHaveLength(1);
    await runCommand(ed, "delete_elements", { all: true });
    expect(ed.doc.order).toHaveLength(0);
  });

  it("reports clear errors for bad input", async () => {
    const ed = setup();
    await expect(runCommand(ed, "create_elements", { elements: [{ type: "connector", from: "nope", to: "x" }] })).rejects.toThrow(/Unknown element "nope"/);
    await expect(runCommand(ed, "create_elements", { elements: [{ type: "sticky", color: "sparkly" }] })).rejects.toThrow(/Invalid colour/);
    await expect(runCommand(ed, "update_elements", { updates: [{ id: "missing" }] })).rejects.toThrow(/Unknown element id/);
    await expect(runCommand(ed, "drop_tables", {})).rejects.toThrow(/Unknown method/);
    expect(ed.doc.order).toHaveLength(0); // failed calls leave nothing behind
    expect(ed.store.inTransaction).toBe(false);
    expect(ed.store.canUndo).toBe(false);
  });
});
