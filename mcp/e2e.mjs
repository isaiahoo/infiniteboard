// End-to-end check of the MCP path: MCP client → server.mjs (stdio) → WebSocket → whiteboard tab.
// Usage: node mcp/e2e.mjs <cdpPort> <appUrl> <outDir>
// Needs a Chrome started with --remote-debugging-port and the app served at appUrl (npm run dev).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [port = "9334", appUrl = "http://127.0.0.1:5173/", outDir = "e2e-output"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
// A private bridge port so the test can never drive a real board the user has open on the default port.
const BRIDGE_PORT = "3999";
const testUrl = `${appUrl}${appUrl.includes("?") ? "&" : "?"}mcp=${BRIDGE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- open the app with the AI bridge enabled (minimal CDP client) ---
// Close app tabs left over from earlier runs: they would also connect to the bridge.
const origin = new URL(appUrl).origin;
for (const t of await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) {
  if (t.type === "page" && t.url.startsWith(origin) && t.url.includes(`mcp=${BRIDGE_PORT}`)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const waiting = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result);
    waiting.delete(m.id);
  }
});
const cdp = (method, params = {}) => new Promise((r) => {
  const id = nextId++;
  waiting.set(id, r);
  ws.send(JSON.stringify({ id, method, params }));
});
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url: testUrl });
await sleep(800);
await cdp("Runtime.evaluate", { expression: "indexedDB.deleteDatabase('whiteboard'); localStorage.clear(); localStorage.setItem('whiteboard:ai-bridge', 'on'); true" });
await cdp("Page.navigate", { url: testUrl });

// --- start the MCP server through a real MCP client ---
const client = new Client({ name: "whiteboard-e2e", version: "0.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [join(here, "server.mjs")], stderr: "inherit",
  env: { ...process.env, WHITEBOARD_BRIDGE_PORT: BRIDGE_PORT },
}));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
process.on("exit", () => void fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.content[0].type === "text" ? JSON.parse(r.content[0].text) : r.content[0];
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("server lists the board tools", ["create_elements", "delete_elements", "focus_view", "get_board", "get_screenshot", "redo", "select_elements", "undo", "update_elements"].every((t) => tools.includes(t)), tools.join(", "));

// The page retries every 2s; wait for it.
let board = null;
for (let i = 0; i < 20 && !board; i++) {
  try {
    board = await call("get_board");
  } catch {
    await sleep(500);
  }
}
await cdp("Runtime.evaluate", { expression: "document.querySelector('.ai-button').click()" });
await sleep(200);
const connectedUi = (await cdp("Runtime.evaluate", { expression: "!!document.querySelector('.local-status.connected') && !!document.querySelector('.ai-button.connected')", returnByValue: true })).result.value;
check("dialog and AI button show Connected", connectedUi === true);
const { data: dlg } = await cdp("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "mcp-dialog-connected.png"), Buffer.from(dlg, "base64"));
await cdp("Runtime.evaluate", { expression: "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))" });
check("board tab connects to the MCP server", !!board && board.elementCount === 0, board ? `${board.elementCount} elements: ${board.elements.map((e) => e.type + ":" + (e.text ?? e.title ?? "")).join(", ")}` : "no board");

const created = await call("create_elements", {
  elements: [
    { type: "frame", ref: "f", title: "Onboarding flow", x: 0, y: 0, w: 1100, h: 520 },
    { type: "text", text: "New user onboarding", x: 40, y: 30, fontSize: 32, bold: true },
    { type: "sticky", ref: "a", text: "Sign up", x: 60, y: 160, color: "yellow" },
    { type: "shape", ref: "b", kind: "diamond", text: "Email verified?", x: 400, y: 180, w: 220, h: 150, fill: "#fff7d6" },
    { type: "sticky", ref: "c", text: "Welcome tour", x: 820, y: 160, color: "green" },
    { type: "sticky", ref: "d", text: "Resend email", x: 420, y: 560, color: "pink" },
    { type: "connector", from: "a", to: "b" },
    { type: "connector", from: "b", to: "c", label: "yes" },
    { type: "connector", from: "b", to: "d", label: "no", route: "elbow" },
  ],
});
check("create_elements builds a connected flow", created.created.length === 9);

board = await call("get_board");
const byText = (t) => board.elements.find((e) => e.text === t);
const frameId = created.created[0].id;
check("children inside the frame belong to it", byText("Sign up").frame === frameId && !byText("Resend email").frame);
const conns = board.elements.filter((e) => e.type === "connector");
check("connectors are bound at both ends", conns.length === 3 && conns.every((c) => c.from && c.to));

await call("update_elements", { updates: [{ id: byText("Resend email").id, x: 860, y: 600, color: "orange" }] });
board = await call("get_board");
const moved = board.elements.find((e) => e.text === "Resend email");
const noConn = board.elements.find((e) => e.type === "connector" && e.label === "no");
check("update_elements moves an element and its connector follows", moved.x === 860 && noConn.toPoint[1] === 600, `connector end ${noConn.toPoint}`);

await call("focus_view", {});
await sleep(200);
const shot = await call("get_screenshot", { maxWidth: 1200 }).catch((e) => ({ error: e.message }));
check("get_screenshot returns a PNG", shot.type === "image" && shot.mimeType === "image/png" && shot.data.length > 1000, shot.error ?? "");
if (shot.data) writeFileSync(join(outDir, "mcp-board.png"), Buffer.from(shot.data, "base64"));

await call("undo");
board = await call("get_board");
check("undo reverts the assistant's last change", board.elements.find((e) => e.text === "Resend email").x === 420);

const err = await client.callTool({ name: "update_elements", arguments: { updates: [{ id: "does-not-exist", x: 1 }] } });
check("bad ids come back as tool errors", err.isError === true && /Unknown element id/.test(err.content[0].text));

await call("delete_elements", { all: true });
board = await call("get_board");
check("delete_elements clears the board", board.elementCount === 0);

writeFileSync(join(outDir, "mcp-results.json"), JSON.stringify(results, null, 2));
await client.close();
await cdp("Target.closeTarget", { targetId: target.id });
ws.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
