import type { ArrowEl, BoardElement } from "../core/model";
import { makeArrow, makeFrame, makeShape, makeSticky, makeStroke, makeText } from "../core/ops";
import type { Draft } from "../core/store";
import { measureTextBlockHeight } from "../core/text";

/** Adds a small demo board exercising every element type. Returns the new ids. */
export function addSampleBoard(d: Draft, ox = 0, oy = 0): string[] {
  const out: BoardElement[] = [];
  const frame = makeFrame({ x: ox - 40, y: oy - 40, w: 1180, h: 640 }, "Sprint planning");
  out.push(frame);

  const title = makeText({ x: ox, y: oy + 10 }, frame.id, "Plan for this week");
  title.fontSize = 36;
  title.bold = true;
  title.w = 520;
  title.h = measureTextBlockHeight(title.text, 36, 520, true);
  out.push(title);

  const colors = ["#fff3a3", "#c7e3ff", "#c4f0dd", "#ffc4d0"];
  const notes = ["Collect feedback from beta users", "Fix arrow routing", "Ship image upload", "Write onboarding guide"];
  const stickies = notes.map((t, i) => {
    const s = makeSticky({ x: ox + 90 + i * 210, y: oy + 200 }, frame.id, colors[i]);
    s.text = t;
    out.push(s);
    return s;
  });

  const decision = makeShape("diamond", { x: ox + 300, y: oy + 380, w: 200, h: 140 }, frame.id);
  decision.text = "Ready?";
  decision.fill = "#fff7d6";
  const done = makeShape("roundrect", { x: ox + 700, y: oy + 400, w: 220, h: 100 }, frame.id);
  done.text = "Release";
  done.fill = "#e6ebfb";
  done.stroke = "#3e63dd";
  out.push(decision, done);

  const link = (from: BoardElement, fu: number, fv: number, to: BoardElement, tu: number, tv: number, route: ArrowEl["route"], label = "") => {
    const a = makeArrow({ x: 0, y: 0 }, { x: 0, y: 0 }, frame.id);
    a.start = { x: 0, y: 0, bind: { id: from.id, u: fu, v: fv } };
    a.end = { x: 0, y: 0, bind: { id: to.id, u: tu, v: tv } };
    a.route = route;
    a.label = label;
    out.push(a);
  };
  link(stickies[1], 0.5, 1, decision, 0.5, 0, "elbow");
  link(decision, 1, 0.5, done, 0, 0.5, "straight", "yes");
  link(decision, 0, 0.5, stickies[0], 0.5, 1, "curved", "no");

  const circle = makeShape("ellipse", { x: ox + 1240, y: oy + 60, w: 180, h: 180 });
  circle.text = "Outside the frame";
  circle.fillOpacity = 0;
  out.push(circle);

  const wave = Array.from({ length: 40 }, (_, i) => ({ x: ox + 1240 + i * 6, y: oy + 360 + Math.sin(i / 4) * 30 }));
  out.push(makeStroke(wave, { color: "#e5484d", width: 3, opacity: 1, highlighter: false }));
  out.push(makeStroke([{ x: ox + 1230, y: oy + 460 }, { x: ox + 1480, y: oy + 460 }], { color: "#ffd84d", width: 18, opacity: 0.45, highlighter: true }));

  for (const el of out) d.set(el);
  return out.map((e) => e.id);
}
