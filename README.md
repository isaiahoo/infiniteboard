# Infiniteboard

An infinite-canvas whiteboard that AI assistants can draw on.

I built it in about 30 minutes with Claude Code and liked the result enough to share it. You get sticky notes, shapes, text, frames, connectors, freehand drawing and images. Connect Claude (or any MCP app) and it can read the board, sketch diagrams and tidy things up while you watch. Each change it makes is one undo step.

There's no account and no backend for your boards: they live in your browser.

**Try it:** [infiniteboard-three.vercel.app](https://infiniteboard-three.vercel.app)

## Connect an assistant

Open an empty board and follow the guide. It takes about two minutes and shows when you're connected. In Claude Code it comes down to:

```sh
claude mcp add --transport http --scope user infiniteboard https://infiniteboard-three.vercel.app/api/mcp
```

Restart Claude Code, run `/mcp`, choose **infiniteboard → Authenticate** and click **Allow access**. In claude.ai, add the same address under **Settings → Connectors → Add custom connector**. On Team and Enterprise plans only an Owner can do that, so use Claude Code there.

Keep the board tab open while the assistant works. Commands pass through the server briefly (they expire within a minute); the board itself never leaves your browser. *Disconnect* in the **AI** dialog revokes an app immediately.

Prefer to keep everything local? `claude mcp add infiniteboard -- npx -y infiniteboard-mcp` runs the MCP server on your machine (the **AI** dialog has the details for other apps).

### What an assistant can do

Describe a product or an idea and ask it to plan it on the board. It builds titled sections side by side: overview, user journey, features by priority, system architecture, roadmap, risks. The assistant describes the structure and the board does the layout: it sizes nodes to their text, keeps things from overlapping, groups related parts in frames and routes connectors around nodes. In Claude Code, `/mcp__infiniteboard__plan_board` starts this for any idea.

| Tool | What it does |
|---|---|
| `create_diagram` | A whole laid-out diagram in one call: flowchart or architecture (`flow`), `tree`, `mindmap`, `columns` (kanban, roadmap), `grid` (brainstorm), `timeline`. Node kinds include decision, database, queue, service, user, note |
| `arrange_elements` | Tidies existing elements: re-layout along their connectors, or grid / row / column |
| `get_board` | Everything on the board; `outline` for a section summary of big boards, `frame` to read one section |
| `create_elements` / `update_elements` / `delete_elements` | Individual stickies, shapes, text, frames, connectors and strokes |
| `get_screenshot` | Any region or the whole board, without moving your view, so it can check its own work |
| `focus_view` / `select_elements` / `undo` / `redo` | Move your view, highlight things, shared history |

Tested end to end with the MCP SDK client and real OAuth. The Claude Code, Cursor and VS Code steps follow each app's docs but haven't been tested in those apps yet.

## Your boards are saved

Every change saves to this browser as you go, and the save status sits next to the board title. Each board has its own link, and **☰ → All boards** lists them. Deleted boards stay in *Recently deleted* for 30 days.

**Version history** (in the same menu) keeps a version every 10 minutes while you work, one when you open a board, and one before anything big is removed: clearing the board, restoring an older version, or an assistant deleting many items. Restoring a version can be undone too. Two tabs on the same board stay in sync and merge each other's edits instead of overwriting them.

Boards don't sync across browsers or devices. Use **Back up all boards** to keep a copy or move them, and **Import** to bring them in (always as new boards, never over an existing one).

## Using the board

N sticky, S shape, T text, F frame, A connector, P pen, Space-drag to pan, Ctrl/⌘ + scroll to zoom, double-click to type. Press **?** in the app for every shortcut.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (?sample loads demo content)
npm test           # unit + interaction tests
npm run build      # static build in dist/
```

The hosted connector is a few Vercel functions in `api/` plus Redis (`REDIS_URL`; Upstash's free tier is plenty). For local work put `REDIS_URL` in `.env.local` and run `npm run dev:api` next to `npm run dev`.

Browser tests drive Chrome started with `--remote-debugging-port=9333`:

```bash
node scripts/e2e.mjs 9333 http://127.0.0.1:5173/ out          # editor UI
node scripts/guide-e2e.mjs 9333 http://127.0.0.1:5173 out     # start guide
node scripts/remote-e2e.mjs 9333 http://127.0.0.1:5173 out    # hosted connector + OAuth
node scripts/boards-e2e.mjs 9333 http://127.0.0.1:5173 out    # saving, tabs, history, boards
node mcp/e2e.mjs 9333 http://127.0.0.1:5173/ out              # local MCP server
```

Code map: `src/core` is the framework-free model (geometry, store with undo, connectors, snapping) plus storage (`boards.ts`, `session.ts`), `src/canvas` renders it, `src/interaction` handles input, `src/ui` is the React chrome, `src/ai` runs assistant commands (`diagram.ts` does the layouts, with [dagre](https://github.com/dagrejs/dagre) for layered graphs), and `mcp/tools.mjs` defines the tools for both the local server and the hosted endpoint.

Not built yet: real-time collaboration, accounts and sharing, rich text, groups, touch pinch-zoom.

Apache-2.0.
