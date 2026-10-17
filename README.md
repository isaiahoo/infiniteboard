# Infiniteboard

An open-source infinite-canvas whiteboard that AI assistants can work on directly.

You get sticky notes, shapes, text, frames, connectors, freehand drawing and images on an infinite canvas. An MCP server lets an assistant read the board, sketch diagrams, rearrange notes and check its own work with screenshots while you watch. Every change it makes is one undo step for you.

- **Connects to AI assistants through MCP.** Use the hosted connector for apps that support remote MCP servers, such as Claude on the web and desktop (no install), or the local `npx` server for apps that run local MCP servers.
- **No account, no backend.** Boards save in your browser and export to JSON.
- **Built with Claude Code** in a single session.

```bash
npm install
npm run dev        # http://localhost:5173  (add ?sample to start with demo content)
npm test           # 41 unit + interaction tests
npm run build      # typecheck + production build in dist/ (static; deploys to Vercel as-is)
```

End-to-end checks in a real browser (Chrome started with `--remote-debugging-port=9333`, `npm run dev` running):

```bash
node scripts/e2e.mjs 9333 http://127.0.0.1:5173/ e2e-output       # UI: 25 checks
cd mcp && npm install && node e2e.mjs 9333 http://127.0.0.1:5173/ e2e-output   # MCP: 11 checks (uses its own bridge port)
```

## Using it

| Action | How |
|---|---|
| Pan | Hand tool (H), hold **Space** and drag, middle/right-drag, or scroll with the wheel/trackpad |
| Zoom | Ctrl/⌘ + wheel, trackpad pinch, −/+ buttons, Ctrl/⌘ +/−, Ctrl/⌘ 0 (100%), Shift+1 (fit all), Shift+2 (fit selection) |
| Select | V. Click; Shift+click toggles; drag on empty canvas for a marquee (frames must be fully enclosed); Ctrl/⌘+A; Esc clears |
| Move | Drag; arrow keys nudge (Shift = 10 px). Snaps to edges and centres of nearby objects; hold Alt to bypass |
| Resize / rotate | Handles on the selection box (also on rotated objects). Shift toggles aspect lock; rotation snaps to 45°, Shift = 15° steps |
| Text | T then click, or double-click empty canvas. Double-click/Enter edits any object's text; Esc or Ctrl/⌘+Enter finishes |
| Sticky note | N then click (pick a colour in the sub-bar). Font size auto-fits |
| Shape | S then drag (or click for a default size). Pick rect/rounded/ellipse/diamond/triangle in the sub-bar |
| Frame | F then drag. Objects at least half inside belong to it and move, duplicate and delete with it. Double-click the title to rename |
| Connector | A then drag between objects. Ends attach to side midpoints or the outline and follow when objects move. Straight/elbow/curved, heads and dash style are in the property bar. Double-click a connector to add a label; drag the label along it |
| Pen / marker / eraser | P / M / E. The eraser removes whole strokes |
| Image | Toolbar button, drag-and-drop, or paste |
| Edit | Delete/Backspace, Ctrl/⌘+D duplicate, Ctrl/⌘+C/X/V, Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl/⌘+Y redo, `]`/`[` forward/backward, Ctrl/⌘+`]`/`[` front/back |

The menu (☰) has export/import (`.json`), sample content, background, grid style, wheel behaviour and snapping. The minimap (bottom-right, toggle in the top bar) shows the whole board: click or drag it to move around. Press **?** for all shortcuts.

## AI assistants (MCP)

Click **AI** in the top bar. There are two ways to connect an assistant. Both offer the same tools.

### Hosted connector (no install)

Copy the connector address shown in the dialog (for the public site: `https://infiniteboard-three.vercel.app/api/mcp`) and add it as a remote MCP server in your app. In Claude: **Settings → Connectors → Add custom connector**, paste the address, then **Connect**. An InfiniteBoard page opens where you click **Allow access**; open it in the browser where your board is. There's no key to copy.

- **Transport:** MCP Streamable HTTP, stateless, with JSON responses.
- **Auth:** OAuth 2.1 with PKCE (S256), dynamic client registration (RFC 7591), protected-resource metadata (RFC 9728) and refresh-token rotation.
- **Your board stays in your browser.** The open tab long-polls the server for commands and runs them locally. Commands and results pass through Redis briefly (they expire within a minute) and are never stored. Keep the board tab open while the assistant works.
- **Revoking:** the dialog lists connected apps; *Disconnect* cuts an app off immediately. Only one tab per board answers at a time; opening the AI dialog in a tab makes it the active one.

Verified end to end: the MCP SDK's Streamable HTTP client, plus OAuth via `scripts/remote-e2e.mjs`. The setup steps for Claude Code, Cursor and VS Code follow each app's documented remote-MCP flow, but haven't been tested against those apps yet. Other apps that support remote MCP servers with OAuth sign-in should work the same way.

### Local server (`npx`)

For apps that launch local MCP servers (Claude Code, Claude Desktop, Cursor, VS Code and others), or to keep everything on your machine:

```bash
claude mcp add infiniteboard -- npx -y infiniteboard-mcp
```

The server (`mcp/`, published to npm as **infiniteboard-mcp**) runs over stdio, and the board tab connects to it at `ws://127.0.0.1:3917`. Find it in the dialog under *Run it locally instead*. Options: `--allow-origin <url>` lets a hosted board connect (the dialog adds it for you), and `--port <n>` changes the port (then open the board with `?mcp=<n>`).

### Tools

| Tool | What it does |
|---|---|
| `get_board` | Elements with ids, positions, sizes, text, colours, frame membership and connector ends; viewport and selection |
| `create_elements` | Batch-create `sticky`, `shape`, `text`, `frame`, `connector`, `stroke`. Use `ref`s to connect items created in the same call; omit `x`/`y` to auto-place |
| `update_elements` | Move, resize, rotate, recolour, retext, re-route or lock existing elements |
| `delete_elements` | Delete by id (frames take their contents), or `all: true` |
| `focus_view`, `select_elements` | Move the user's view; highlight elements |
| `get_screenshot` | Image of the current view, so the assistant can check its work |
| `undo`, `redo` | History, shared with the user. Every AI change is one undo step |

### Running the hosted connector yourself

It's a set of Vercel functions in `api/` plus a Redis database (Upstash via the Vercel Marketplace works; the functions read `REDIS_URL`). Each idle open board with the connector on costs about one Redis command per 45 seconds. Tabs pause after 15 minutes in the background. For local development, put `REDIS_URL` in `.env.local`, then run `npm run dev:api` next to `npm run dev`.

## Architecture

```
src/core/         framework-free model and logic (unit-tested)
  geom.ts         vectors, rects, rotation, hit maths, RDP simplification, smoothing
  model.ts        element types and document shape
  store.ts        immutable document store; gestures batch into one undo step (diff by reference)
  camera.ts       screen↔world, zoom-at-point, zoom steps, fit
  elements.ts     paint order, bounds, hit tests, connector geometry/binding, frame membership
  ops.ts          factories, move/delete/duplicate/reorder, clipboard (de)serialisation
  transform.ts    resize (rotation-aware, anchored) and rotate maths
  snap.ts         alignment snapping and guides
  text.ts         wrapping and auto-fit sizing
  persist.ts      IndexedDB autosave, JSON import/export, image ingestion
src/canvas/render.ts      Canvas 2D renderer: grid, elements (viewport-culled), overlay
src/interaction/editor.ts tool state machine: pointer gestures, keyboard, commands
src/ai/commands.ts        board commands for AI assistants (validated; one undo step per call)
src/ai/bridge.ts          opt-in WebSocket link from the tab to the local MCP server
src/ai/remote.ts          board side of the hosted connector (long-poll, runs commands)
src/connect/              consent page an AI app opens to request access
api/                      Vercel functions: MCP endpoint, OAuth server, board relay (Redis)
src/ui/                   React chrome: toolbar, top bar, property bar, minimap, help, inline text editor
mcp/tools.mjs             MCP tool definitions shared by the local server and the hosted endpoint
mcp/server.mjs            local MCP server (stdio) + loopback WebSocket relay to the board tab
```

Key design points:
- **One source of truth.** Connector ends bound to an object store `(id, u, v)` in the object's local coordinates. Their world position is derived on every render, so connectors follow moves, resizes and rotations with no patch-up code.
- **Gesture = transaction.** `store.begin()` on pointer-down, cheap previews on move, `commit()` on pointer-up. Undo restores exactly the elements whose object identity changed.
- **The DOM is used only for text editing.** A `contenteditable` is positioned with `translate · rotate · scale(zoom)` so the caret sits where canvas text is drawn.

## Design notes

Interaction behaviour follows common whiteboard conventions: Esc to deselect, Ctrl/⌘+A, hold-Space panning, Shift+click to toggle selection, and resize handles that work on rotated objects. All code, icons and styling were written for this project.

## Not built yet

Realtime multi-user collaboration (needs a server), accounts and sharing, per-character rich text, groups, lasso, search, templates, embeds/PDF, two-finger touch pinch, and a spatial index for very large boards.
