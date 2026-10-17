# Infiniteboard

An open-source infinite-canvas whiteboard that AI assistants can work on directly.

You get sticky notes, shapes, text, frames, connectors, freehand drawing and images on an infinite canvas. An MCP server lets an assistant read the board, sketch diagrams, rearrange notes and check its own work with screenshots while you watch. Every change it makes is one undo step for you.

- **Connects to AI assistants through MCP.** Works today with Claude Code, Claude Desktop, Cursor, VS Code and any other MCP client that can run a local server. Support for browser-based assistants such as claude.ai and ChatGPT, through a hosted connector, is in progress.
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

Click the **AI** button in the top bar. The dialog switches this board on for assistants, shows a live status (waiting → connected), and gives copy-paste setup steps for Claude Code, Claude Desktop, Cursor, VS Code and any other MCP app. For Claude Code, setup is one command:

```bash
claude mcp add infiniteboard -- npx -y infiniteboard-mcp
```

Then just ask, e.g. *"Turn the stickies on my board into a user-journey flow with a frame per stage"*. Every AI change is a normal undo step for you.

The server (`mcp/`, published to npm as **infiniteboard-mcp**) runs on your own machine, started by your assistant over stdio. The board tab connects to it through `ws://127.0.0.1:3917`, and only while its AI switch is on. When several tabs are switched on, the newest one wins and the others show *Connected in another tab*.

| Tool | What it does |
|---|---|
| `get_board` | Elements with ids, positions, sizes, text, colours, frame membership and connector ends; viewport and selection |
| `create_elements` | Batch-create `sticky`, `shape`, `text`, `frame`, `connector`, `stroke`. Use `ref`s to connect items created in the same call; omit `x`/`y` to auto-place |
| `update_elements` | Move, resize, rotate, recolour, retext, re-route or lock existing elements |
| `delete_elements` | Delete by id (frames take their contents), or `all: true` |
| `focus_view`, `select_elements` | Move the user's view; highlight elements |
| `get_screenshot` | PNG of the current view, so the assistant can check its work |
| `undo`, `redo` | History, shared with the user |

Server options: `--allow-origin <url>` lets a hosted board (e.g. your Vercel URL) connect; localhost is always allowed, and the dialog adds this flag automatically. `--port <n>` changes the port (open the board with `?mcp=<n>`). Other origins are rejected, so a random website can't pose as your board. When you run the dev server, the dialog points at your local `mcp/server.mjs`, so you can test before publishing.

**Publishing the server:** `cd mcp && npm publish` (the name `infiniteboard-mcp` was free at the time of writing).

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
src/ui/                   React chrome: toolbar, top bar, property bar, minimap, help, inline text editor
mcp/server.mjs            MCP server (stdio) + loopback WebSocket relay to the board tab
```

Key design points:
- **One source of truth.** Connector ends bound to an object store `(id, u, v)` in the object's local coordinates. Their world position is derived on every render, so connectors follow moves, resizes and rotations with no patch-up code.
- **Gesture = transaction.** `store.begin()` on pointer-down, cheap previews on move, `commit()` on pointer-up. Undo restores exactly the elements whose object identity changed.
- **The DOM is used only for text editing.** A `contenteditable` is positioned with `translate · rotate · scale(zoom)` so the caret sits where canvas text is drawn.

## Design notes

Interaction behaviour follows common whiteboard conventions: Esc to deselect, Ctrl/⌘+A, hold-Space panning, Shift+click to toggle selection, and resize handles that work on rotated objects. All code, icons and styling were written for this project.

## Not built yet

Realtime multi-user collaboration (needs a server), accounts and sharing, per-character rich text, groups, lasso, search, templates, embeds/PDF, two-finger touch pinch, and a spatial index for very large boards.
