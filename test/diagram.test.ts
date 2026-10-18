import { beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/ai/commands";
import { arrowGeometry, boxOf } from "../src/core/elements";
import { rectsIntersect } from "../src/core/geom";
import { emptyDoc, type ArrowEl, type BoardElement } from "../src/core/model";
import { Store } from "../src/core/store";
import { setMeasure } from "../src/core/text";
import { Editor } from "../src/interaction/editor";

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  setMeasure((text, font) => text.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]) / 2));
});

function setup() {
  const ed = new Editor(new Store(emptyDoc()));
  ed.viewW = 1200;
  ed.viewH = 800;
  ed.camera = { x: 600, y: 400, zoom: 1 };
  return ed;
}

type Result = { nodes: Record<string, string>; groups?: Record<string, string>; section?: string; bounds: { x: number; y: number; w: number; h: number }; warning?: string };
const diagram = (ed: Editor, spec: Record<string, unknown>) => runCommand(ed, "create_diagram", spec) as Promise<Result>;

const nodesOf = (ed: Editor, r: Result) => Object.values(r.nodes).map((id) => ed.doc.elements[id]);
function overlapping(els: BoardElement[]) {
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) if (rectsIntersect(boxOf(els[i]), boxOf(els[j]))) return [els[i], els[j]];
  return null;
}

const FLOW = {
  layout: "flow", title: "Checkout",
  nodes: [
    { id: "a", text: "Cart", kind: "terminal" }, { id: "b", text: "Logged in?", kind: "decision" }, { id: "c", text: "Sign in" },
    { id: "d", text: "Pay" }, { id: "e", text: "Orders DB", kind: "database" }, { id: "f", text: "Done", kind: "terminal" },
  ],
  edges: [
    { from: "a", to: "b" }, { from: "b", to: "c", label: "No" }, { from: "b", to: "d", label: "Yes" }, { from: "c", to: "d" },
    { from: "d", to: "e", style: "dashed" }, { from: "d", to: "f" }, { from: "f", to: "a", label: "again" },
  ],
};

describe("create_diagram", () => {
  it("lays out a flowchart without overlaps, sized to its text, in one undo step", async () => {
    const ed = setup();
    const r = await diagram(ed, FLOW);
    const nodes = nodesOf(ed, r);
    expect(nodes).toHaveLength(6);
    expect(overlapping(nodes)).toBeNull();
    const kinds = Object.fromEntries(Object.entries(r.nodes).map(([k, id]) => [k, (ed.doc.elements[id] as { kind?: string }).kind]));
    expect(kinds).toMatchObject({ a: "ellipse", b: "diamond", e: "cylinder", c: "roundrect" });
    const arrows = ed.doc.order.map((id) => ed.doc.elements[id]).filter((el): el is ArrowEl => el.type === "arrow");
    expect(arrows).toHaveLength(7);
    expect(arrows.every((a) => a.start.bind && a.end.bind)).toBe(true);
    expect(arrows.find((a) => a.label === "Yes")).toBeTruthy();
    // Titled diagram without groups: one frame holding everything.
    const frame = ed.doc.elements[r.section!];
    expect(frame.type).toBe("frame");
    expect(nodes.every((n) => n.parentId === frame.id)).toBe(true);
    ed.store.undo();
    expect(ed.doc.order).toHaveLength(0);
  });

  it("routes edges that skip ranks around nodes, and keeps the route when the diagram moves", async () => {
    const ed = setup();
    const r = await diagram(ed, FLOW);
    const loop = ed.doc.order.map((id) => ed.doc.elements[id]).find((el): el is ArrowEl => el.type === "arrow" && el.label === "again")!;
    expect(loop.via?.points.length).toBeGreaterThan(0);
    const before = arrowGeometry(ed.doc, loop).points.length;
    expect(before).toBeGreaterThan(3);
    // Moving every node together keeps the stored route…
    await runCommand(ed, "update_elements", { updates: Object.values(r.nodes).map((id) => ({ id, x: ed.doc.elements[id].x + 500 })) });
    expect(arrowGeometry(ed.doc, ed.doc.elements[loop.id] as ArrowEl).points.length).toBe(before);
    // …moving one end drops back to automatic routing.
    await runCommand(ed, "update_elements", { updates: [{ id: r.nodes.a, x: ed.doc.elements[r.nodes.a].x - 300 }] });
    const after = arrowGeometry(ed.doc, ed.doc.elements[loop.id] as ArrowEl).points;
    expect(after.length).toBeLessThanOrEqual(6);
  });

  it("wraps groups in frames and puts the title above them", async () => {
    const ed = setup();
    const r = await diagram(ed, {
      layout: "flow", direction: "right", title: "Architecture",
      groups: [{ id: "fe", title: "Frontend" }, { id: "be", title: "Backend" }],
      nodes: [{ id: "w", text: "Web", group: "fe" }, { id: "api", text: "API", group: "be", kind: "service" }, { id: "db", text: "DB", group: "be", kind: "database" }],
      edges: [{ from: "w", to: "api" }, { from: "api", to: "db" }],
    });
    expect(Object.keys(r.groups!)).toEqual(["fe", "be"]);
    const be = ed.doc.elements[r.groups!.be];
    expect(be.type === "frame" && be.title).toBe("Backend");
    expect(ed.doc.elements[r.nodes.db].parentId).toBe(be.id);
    const heading = ed.doc.elements[r.section!];
    expect(heading.type).toBe("text");
    expect(heading.y).toBeLessThan(be.y);
    // Left to right: web, then api, then db.
    const x = (k: string) => ed.doc.elements[r.nodes[k]].x;
    expect(x("w")).toBeLessThan(x("api"));
    expect(x("api")).toBeLessThan(x("db"));
  });

  it("builds mind maps on both sides of the root, and validates structure", async () => {
    const ed = setup();
    const kids = ["A", "B", "C", "D"].map((t) => ({ id: t, text: t, parent: "root" }));
    const r = await diagram(ed, { layout: "mindmap", nodes: [{ id: "root", text: "Idea" }, ...kids, { id: "A1", text: "A1", parent: "A" }] });
    const root = ed.doc.elements[r.nodes.root];
    const sides = kids.map((k) => Math.sign(ed.doc.elements[r.nodes[k.id]].x - root.x));
    expect(sides).toContain(1);
    expect(sides).toContain(-1);
    expect(overlapping(nodesOf(ed, r))).toBeNull();
    await expect(diagram(ed, { layout: "mindmap", nodes: [{ id: "a", text: "a" }, { id: "b", text: "b" }] })).rejects.toThrow(/exactly one root/);
    await expect(diagram(ed, { layout: "tree", nodes: [{ id: "a", text: "a", parent: "b" }, { id: "b", text: "b", parent: "a" }] })).rejects.toThrow(/cycle/);
    await expect(diagram(ed, { layout: "flow", nodes: [{ id: "a", text: "a" }], edges: [{ from: "a", to: "zz" }] })).rejects.toThrow(/unknown node/);
  });

  it("columns, grid and timeline produce tidy structures", async () => {
    const ed = setup();
    const cols = await diagram(ed, {
      layout: "columns", title: "Roadmap",
      nodes: [{ id: "1", text: "Auth", group: "Now" }, { id: "2", text: "Billing", group: "Now" }, { id: "3", text: "Teams", group: "Next" }, { id: "4", text: "SSO", group: "Later" }],
    });
    const frames = Object.values(cols.groups!).map((id) => ed.doc.elements[id]);
    expect(frames.map((f) => (f as { title: string }).title)).toEqual(["Now", "Next", "Later"]);
    expect(new Set(frames.map((f) => f.h)).size).toBe(1);
    const grid = await diagram(ed, { layout: "grid", place: { near: cols.section!, side: "below" }, nodes: Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, text: `Idea ${i}` })) });
    expect(overlapping(nodesOf(ed, grid))).toBeNull();
    expect(ed.doc.elements[grid.nodes.n0].type).toBe("sticky");
    const t = await diagram(ed, { layout: "timeline", place: { near: cols.section!, side: "right" }, nodes: ["Jan", "Feb", "Mar"].map((m, i) => ({ id: m, text: `Step ${i}`, detail: m })) });
    const cards = nodesOf(ed, t);
    expect(cards[0].x).toBeLessThan(cards[1].x);
    // The date sits on the axis, not in the card.
    expect((cards[0] as { text: string }).text).toBe("Step 0");
    expect(ed.doc.order.some((id) => (ed.doc.elements[id] as { text?: string }).text === "Jan")).toBe(true);
  });

  it("places a diagram beside a whole section, not on top of it", async () => {
    const ed = setup();
    const a = await diagram(ed, { layout: "columns", title: "Features", nodes: [{ id: "1", text: "One", group: "Must" }, { id: "2", text: "Two", group: "Should" }] });
    const b = await diagram(ed, { layout: "flow", title: "Flow", place: { near: a.section!, side: "right" }, nodes: [{ id: "x", text: "X" }, { id: "y", text: "Y" }], edges: [{ from: "x", to: "y" }] });
    expect(b.warning).toBeUndefined();
    const right = Math.max(...Object.values(a.groups!).map((id) => ed.doc.elements[id].x + ed.doc.elements[id].w));
    expect(ed.doc.elements[b.section!].x).toBeGreaterThan(right);
  });
});

describe("arrange_elements", () => {
  it("re-lays out scattered connected elements and re-attaches connectors", async () => {
    const ed = setup();
    const res = (await runCommand(ed, "create_elements", {
      elements: [
        { type: "shape", ref: "a", text: "A", x: 0, y: 0 }, { type: "shape", ref: "b", text: "B", x: 30, y: 20 },
        { type: "shape", ref: "c", text: "C", x: 900, y: -400 }, { type: "connector", from: "a", to: "b" }, { type: "connector", from: "b", to: "c" },
      ],
    })) as { created: { id: string; type: string }[] };
    const ids = res.created.filter((c) => c.type === "shape").map((c) => c.id);
    const out = (await runCommand(ed, "arrange_elements", { ids, layout: "flow", direction: "down" })) as { arranged: number; connectorsRerouted: number };
    expect(out).toMatchObject({ arranged: 3, connectorsRerouted: 2 });
    const [a, b, c] = ids.map((id) => ed.doc.elements[id]);
    expect(overlapping([a, b, c])).toBeNull();
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);
    await runCommand(ed, "arrange_elements", { ids, layout: "row" });
    expect(new Set(ids.map((id) => Math.round(ed.doc.elements[id].y))).size).toBe(1);
  });
});
