// End-to-end smoke test: drives the dev server in a Chrome started with --remote-debugging-port.
// Usage: node scripts/e2e.mjs <cdpPort> <appUrl> <outDir>
// Sends real mouse/keyboard input through CDP and checks the editor state after each step.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [port = "9333", appUrl = "http://127.0.0.1:5199/", outDir = "e2e-output"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// Close this test's leftover tabs from earlier runs (they can block the database reset below).
for (const t of await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) {
  if (t.type === "page" && t.url.includes("mcp=3998")) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 1;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const MOD = 4; // Meta: the app maps Cmd on macOS
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
async function drag(from, to, steps = 12, modifiers = 0) {
  await mouse("mouseMoved", ...from, { buttons: 0, modifiers });
  await mouse("mousePressed", ...from, { modifiers });
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, { modifiers });
  }
  await mouse("mouseReleased", ...to, { modifiers });
  await sleep(60);
}
async function click(x, y) {
  await mouse("mouseMoved", x, y, { buttons: 0 });
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(400); // stay outside the double-click window
}
async function key(k, code, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, modifiers, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers });
  await sleep(40);
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
}
const state = () =>
  evaluate(`(() => { const e = window.__editor; const d = e.doc;
    return { tool: e.tool, selection: [...e.selection], editing: e.editingId, zoom: e.camera.zoom, cam: e.camera,
      els: d.order.map((id) => { const x = d.elements[id]; return { id, type: x.type, x: x.x, y: x.y, w: x.w, h: x.h, text: x.text ?? x.label ?? x.title, parentId: x.parentId,
        start: x.start?.bind?.id ?? null, end: x.end?.bind?.id ?? null }; }) }; })()`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
// Fresh storage so the run is repeatable.
// A private bridge port: opening the AI dialog must never take over a real assistant connection.
const ISOLATE = "mcp=3998";
await send("Page.navigate", { url: `${appUrl}?${ISOLATE}` });
await sleep(800);
await evaluate("indexedDB.deleteDatabase('whiteboard'); localStorage.clear(); true");
await send("Page.navigate", { url: `${appUrl}?sample&${ISOLATE}` });
// Wait for the app (a cold dev server can take a few seconds on first load).
for (let i = 0; i < 60 && !(await evaluate("!!window.__editor && document.querySelector('.board') !== null")); i++) await sleep(250);
await sleep(300);

let s = await state();
check("sample board loads with all element types", ["frame", "text", "sticky", "shape", "arrow", "stroke"].every((t) => s.els.some((e) => e.type === t)), `${s.els.length} elements`);
await shot("01-sample-board.png");

// Reset camera to 100% at a known origin for deterministic coordinates.
await evaluate("window.__editor.setCamera({ x: 0, y: 0, zoom: 1 }); window.__editor.select([]); true");
await evaluate("window.__editor.store.reset({ ...window.__editor.doc, elements: {}, order: [] }); true");
await sleep(100);

// 1. Shape by drag (S).
await key("s", "KeyS");
await drag([700, 200], [900, 330]);
s = await state();
const shape = s.els.find((e) => e.type === "shape");
check("S + drag creates a shape and returns to select", !!shape && s.tool === "select" && Math.round(shape.w) === 200 && Math.round(shape.h) === 130);

// 2. Sticky by click, type, Escape.
await key("n", "KeyN");
await click(300, 260);
await send("Input.insertText", { text: "Hello from e2e" });
await sleep(50);
await key("Escape", "Escape");
s = await state();
const sticky = s.els.find((e) => e.type === "sticky");
check("N + click creates a sticky and typing edits it", sticky?.text === "Hello from e2e" && !s.editing, sticky?.text);

// 3. Connector from sticky to shape binds both ends.
await key("a", "KeyA");
await drag([330, 260], [720, 265]);
s = await state();
const arrow = s.els.find((e) => e.type === "arrow");
check("A + drag connects sticky → shape", arrow?.start === sticky.id && arrow?.end === shape.id);

// 4. Moving the shape keeps the connector attached.
await click(1200, 700); // deselect on empty canvas
await drag([800, 300], [850, 500]);
s = await state();
const moved = s.els.find((e) => e.id === shape.id);
const arrow2 = s.els.find((e) => e.type === "arrow");
check("dragging a shape moves it and the connector stays bound", Math.round(moved.y) === 400 && arrow2.end === shape.id, `y=${moved.y}`);
await shot("02-created-and-connected.png");

// 5. Frame adopts the sticky, moves it along.
await key("f", "KeyF");
await drag([150, 120], [480, 420]);
s = await state();
const frame = s.els.find((e) => e.type === "frame");
check("F + drag creates a frame that adopts the sticky", s.els.find((e) => e.id === sticky.id).parentId === frame.id);
await drag([460, 400], [460, 630]); // drag frame body (230px, clear of snap lines)
s = await state();
check("moving the frame carries its children", Math.round(s.els.find((e) => e.id === sticky.id).y) === 170 + 230, `sticky y=${s.els.find((e) => e.id === sticky.id).y}`);

// 6. Marquee select + delete + undo.
await click(1300, 150);
await drag([1150, 720], [100, 100]); // start clear of the minimap
s = await state();
check("marquee selects everything inside", s.selection.length === 4, `${s.selection.length} selected`);
await key("Delete", "Delete");
s = await state();
check("Delete removes the selection", s.els.length === 0);
await sleep(100);
check("empty board shows a hint", await evaluate("!!document.querySelector('.empty-hint')"));
await key("?", "Slash", 8);
await sleep(100);
check("? opens the shortcuts panel", await evaluate("!!document.querySelector('.help')"));
await shot("04-shortcuts-panel.png");
await key("Escape", "Escape");
check("Esc closes it", await evaluate("!document.querySelector('.help')"));
await key("z", "KeyZ", MOD);
s = await state();
check("Cmd/Ctrl+Z restores it", s.els.length === 4);

// 7. Zoom with ctrl+wheel around the cursor, and pan with plain wheel.
const before = await evaluate("JSON.stringify(window.__editor.toWorld({x: 600, y: 400}))");
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: -120, modifiers: 2 });
await sleep(100);
const after = await evaluate("JSON.stringify(window.__editor.toWorld({x: 600, y: 400}))");
s = await state();
const b = JSON.parse(before), a = JSON.parse(after);
check("ctrl+wheel zooms in around the cursor", s.zoom > 1 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5, `zoom=${s.zoom.toFixed(2)}`);
const camBefore = s.cam;
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 40, deltaY: 60 });
await sleep(100);
s = await state();
check("plain wheel pans", Math.round(camBefore.x - s.cam.x) === 40 && Math.round(camBefore.y - s.cam.y) === 60);

// 8. Pen stroke, then erase it.
await evaluate("window.__editor.setCamera({ x: 0, y: 0, zoom: 1 }); true");
await key("p", "KeyP");
await drag([900, 700], [1200, 720], 20);
s = await state();
check("P + drag draws a stroke and stays in pen", s.els.some((e) => e.type === "stroke") && s.tool === "pen");
await key("e", "KeyE");
await drag([1050, 650], [1050, 780], 10);
s = await state();
check("eraser removes the stroke", !s.els.some((e) => e.type === "stroke"));

await shot("03-after-interactions.png");

// AI dialog: the top-bar button opens it, it switches the board to "waiting", and shows copyable setup.
const aiBtn = await evaluate("(() => { const r = document.querySelector('.ai-button').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
await click(...aiBtn);
check("AI button opens the connect dialog", await evaluate("!!document.querySelector('.ai-dialog')"));
check("dialog puts the board in waiting state", await evaluate("!!document.querySelector('.ai-state.connecting')"));
check("Claude Code step shows a one-line command", await evaluate("[...document.querySelectorAll('.steps pre')].some((p) => p.textContent.startsWith('claude mcp add infiniteboard -- '))"));
await shot("05-ai-dialog.png");
const desk = await evaluate("(() => { const b = [...document.querySelectorAll('.app-option')].find((x) => x.textContent.includes('Claude Desktop')); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
await click(...desk);
check("Claude Desktop tab shows config JSON", await evaluate("[...document.querySelectorAll('.steps pre')].some((p) => p.textContent.includes('\"mcpServers\"'))"));
// Short window: the dialog must fit the viewport and its body must scroll to the last prompt.
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 600, deviceScaleFactor: 1, mobile: false });
await sleep(150);
const fit = await evaluate("(() => { const d = document.querySelector('.ai-dialog').getBoundingClientRect(); const b = document.querySelector('.ai-dialog .dialog-body'); return { bottom: d.bottom, vh: innerHeight, scrollable: b.scrollHeight > b.clientHeight }; })()");
check("dialog fits a short window and its body scrolls", fit.bottom <= fit.vh && fit.scrollable, JSON.stringify(fit));
for (let i = 0; i < 6; i++) await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 380, deltaX: 0, deltaY: 400 });
await sleep(200);
const lastVisible = await evaluate("(() => { const p = [...document.querySelectorAll('.prompts .copy-block')].pop().getBoundingClientRect(); return p.bottom <= innerHeight; })()");
check("mouse wheel scrolls the dialog to the last prompt", lastVisible);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await key("Escape", "Escape");
check("Esc closes the dialog", await evaluate("!document.querySelector('.ai-dialog')"));
check("AI button shows the waiting dot", await evaluate("!!document.querySelector('.ai-button.connecting .dot')"));
check("minimap is shown", await evaluate("!!document.querySelector('.minimap canvas')"));
check("no console errors or uncaught exceptions", errors.length === 0, errors.slice(0, 3).join(" | "));

writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, errors }, null, 2));
await send("Target.closeTarget", { targetId: target.id }).catch(() => {});
ws.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
