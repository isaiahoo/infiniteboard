#!/usr/bin/env node
// MCP server for the whiteboard. AI assistants talk to it over stdio; it relays each tool call
// to the open whiteboard tab, which connects to a loopback WebSocket once the user enables
// "Let a local AI assistant edit this board" in the menu.
//
// Options (flags or env):
//   --port <n>            | WHITEBOARD_BRIDGE_PORT      WebSocket port (default 3917; the page uses ?mcp=<port> to match)
//   --allow-origin <url>  | WHITEBOARD_ALLOWED_ORIGINS  extra page origins allowed to connect (repeatable / comma-separated);
//                                                       localhost and 127.0.0.1 are always allowed
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { INSTRUCTIONS, registerBoardTools } from "./tools.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []));
const PORT = Number(flag("--port")[0] ?? process.env.WHITEBOARD_BRIDGE_PORT) || 3917;
const EXTRA_ORIGINS = [...flag("--allow-origin"), ...(process.env.WHITEBOARD_ALLOWED_ORIGINS ?? "").split(",")]
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const log = (...args) => console.error("[whiteboard-mcp]", ...args); // stdout is reserved for MCP

function originAllowed(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
  } catch {
    return false;
  }
  return EXTRA_ORIGINS.includes(origin);
}

// ---------- bridge to the board tab ----------

let board = null;
let bridgeError = null;
let seq = 0;
const pending = new Map();

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  maxPayload: 32 * 1024 * 1024,
  verifyClient: ({ origin }) => {
    const ok = originAllowed(origin);
    if (!ok) log(`rejected connection from origin ${origin ?? "(none)"}; start the server with --allow-origin ${origin} to allow it`);
    return ok;
  },
});
wss.on("listening", () => log(`waiting for the whiteboard on ws://127.0.0.1:${PORT}`));
wss.on("error", (e) => {
  bridgeError = e.code === "EADDRINUSE" ? `Port ${PORT} is already in use (is another whiteboard MCP server running?)` : String(e.message ?? e);
  log(bridgeError);
});
wss.on("connection", (ws) => {
  // Newest tab wins; code 4000 tells the old tab to stop reconnecting instead of fighting for the slot.
  if (board && board !== ws) board.close(4000, "Another board tab connected");
  board = ws;
  log("board connected");
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "hello") return log(`board: "${msg.title}"`);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  ws.on("close", () => {
    if (board === ws) board = null;
    log("board disconnected");
  });
});

function call(method, params = {}) {
  if (bridgeError) return Promise.reject(new Error(bridgeError));
  if (!board || board.readyState !== board.OPEN) {
    return Promise.reject(new Error(
      "No whiteboard is connected. Ask the user to open the whiteboard and click the AI button in its top bar.",
    ));
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The board did not answer "${method}" within 20s`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    board.send(JSON.stringify({ id, method, params }));
  });
}

// ---------- MCP server ----------

const server = new McpServer({ name: "infiniteboard", version: "0.3.0" }, { instructions: INSTRUCTIONS });
registerBoardTools(server, call);
await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = () => {
  wss.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
