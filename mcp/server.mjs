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
import { z } from "zod";

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

const asText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });
const asError = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
const relay = (method) => async (params) => {
  try {
    return asText(await call(method, params));
  } catch (e) {
    return asError(e);
  }
};

// ---------- tools ----------

const server = new McpServer(
  { name: "infiniteboard", version: "0.1.0" },
  {
    instructions: [
      "Tools for reading and editing the user's open whiteboard (an infinite canvas).",
      "Coordinates are world units: 1 unit = 1 px at 100% zoom, x grows right, y grows down. Elements have x/y (top-left) and w/h.",
      "Typical sizes: sticky 180×180, shape 160×110, frame 800×500, text 20px font. Leave ~40–80 units between items.",
      "Start with get_board to see what exists; omit x/y when creating to place items in free space to the right of existing content.",
      "Connectors attach to elements via from/to (ids, or refs defined earlier in the same create_elements call) and follow them when they move.",
      "Each create/update/delete call is one undo step for the user. Use get_screenshot to check the visual result.",
    ].join(" "),
  },
);

const color = z.string().describe("Hex colour (#rrggbb) or a name: yellow, orange, pink, purple, blue, green, lime, gray, white, black, red, darkblue, darkgreen");
const point = z.tuple([z.number(), z.number()]);
const common = {
  x: z.number().optional().describe("Left edge (world units). Omit x and y to auto-place in free space"),
  y: z.number().optional().describe("Top edge (world units)"),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  text: z.string().optional().describe("Text for sticky, shape and text elements (plain text, \\n for new lines)"),
  title: z.string().optional().describe("Frame title"),
  color: color.optional().describe("Sticky/frame: background. Text/shape: text colour. Connector/stroke: line colour"),
  fill: z.string().optional().describe('Shape fill colour, or "none"'),
  stroke: color.optional().describe("Shape border colour"),
  kind: z.enum(["rect", "roundrect", "ellipse", "diamond", "triangle"]).optional().describe("Shape kind (default rect)"),
  fontSize: z.number().positive().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  bold: z.boolean().optional(),
  angle: z.number().optional().describe("Rotation in degrees, clockwise"),
  from: z.string().optional().describe("Connector start: element id or ref"),
  to: z.string().optional().describe("Connector end: element id or ref"),
  fromPoint: point.optional().describe("Connector start as [x, y] when not attached"),
  toPoint: point.optional().describe("Connector end as [x, y] when not attached"),
  route: z.enum(["straight", "elbow", "curved"]).optional(),
  label: z.string().optional().describe("Connector label"),
  endHead: z.enum(["none", "open", "filled"]).optional(),
  startHead: z.enum(["none", "open", "filled"]).optional(),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
};

server.registerTool("get_board", {
  title: "Read the board",
  description: "Lists the board's elements (id, type, position, size, text, colours, frame membership, connector endpoints), the visible viewport, content bounds and current selection.",
  inputSchema: {
    type: z.enum(["sticky", "shape", "text", "frame", "connector", "stroke", "image"]).optional().describe("Only list this element type"),
    limit: z.number().int().positive().max(5000).optional().describe("Maximum elements to return (default 500)"),
  },
  annotations: { readOnlyHint: true },
}, relay("get_board"));

server.registerTool("create_elements", {
  title: "Create elements",
  description:
    "Creates sticky notes, shapes, text, frames, connectors and pen strokes in one undoable step. " +
    "Give elements a `ref` to connect them in the same call, e.g. [{type:'sticky',ref:'a',text:'Idea'},{type:'sticky',ref:'b',text:'Plan'},{type:'connector',from:'a',to:'b'}]. " +
    "Elements placed at least half inside a frame automatically belong to it. Returns the new ids.",
  inputSchema: {
    elements: z.array(z.object({
      type: z.enum(["sticky", "shape", "text", "frame", "connector", "stroke"]),
      ref: z.string().optional().describe("Your own key for referring to this element later in the same call"),
      ...common,
      points: z.array(point).optional().describe("Stroke points [[x, y], …] in world units"),
      width: z.number().positive().optional().describe("Stroke width"),
    })).min(1).max(500),
  },
}, relay("create_elements"));

server.registerTool("update_elements", {
  title: "Update elements",
  description: "Moves, resizes, recolours, retexts or rewires existing elements (one undoable step). Only the fields you pass change. Set locked to stop the user moving an element.",
  inputSchema: {
    updates: z.array(z.object({ id: z.string(), ...common, locked: z.boolean().optional() })).min(1).max(1000),
  },
}, relay("update_elements"));

server.registerTool("delete_elements", {
  title: "Delete elements",
  description: "Deletes elements by id (deleting a frame deletes its contents). Pass all: true to clear the board. One undoable step.",
  inputSchema: {
    ids: z.array(z.string()).optional(),
    all: z.boolean().optional().describe("Delete everything on the board"),
  },
  annotations: { destructiveHint: true },
}, relay("delete_elements"));

server.registerTool("focus_view", {
  title: "Move the view",
  description: "Pans/zooms the user's view: fit the given element ids, centre on x/y (optionally at a zoom), set a zoom level, or with no arguments fit the whole board.",
  inputSchema: {
    ids: z.array(z.string()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    zoom: z.number().positive().max(8).optional().describe("1 = 100%"),
  },
}, relay("focus_view"));

server.registerTool("select_elements", {
  title: "Select elements",
  description: "Highlights elements for the user by selecting them (empty list clears the selection).",
  inputSchema: { ids: z.array(z.string()) },
}, relay("select"));

server.registerTool("undo", { title: "Undo", description: "Undoes the last change on the board (the user's or the assistant's).", inputSchema: {} }, relay("undo"));
server.registerTool("redo", { title: "Redo", description: "Redoes the last undone change.", inputSchema: {} }, relay("redo"));

server.registerTool("get_screenshot", {
  title: "Screenshot the board",
  description: "Returns a PNG of what the user currently sees. Use focus_view first to frame the area you want to check.",
  inputSchema: { maxWidth: z.number().int().min(200).max(2400).optional().describe("Maximum image width in pixels (default 1280)") },
  annotations: { readOnlyHint: true },
}, async (params) => {
  try {
    const { image } = await call("screenshot", params);
    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(image ?? "");
    if (!m) throw new Error("The board returned no image");
    return { content: [{ type: "image", mimeType: m[1], data: m[2] }] };
  } catch (e) {
    return asError(e);
  }
});

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = () => {
  wss.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
