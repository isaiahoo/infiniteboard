# Infiniteboard

An infinite-canvas whiteboard that AI assistants can draw on.

I built it in about 30 minutes with Claude Code and liked the result enough to share it. You get sticky notes, shapes, text, frames, connectors, freehand drawing and images. Connect Claude (or any MCP app) and it can read the board, sketch diagrams and tidy things up while you watch. Each change it makes is one undo step.

There's no account and no backend for your boards: they live in your browser and export to JSON.

**Try it:** [infiniteboard-three.vercel.app](https://infiniteboard-three.vercel.app)

## Connect an assistant

Open an empty board and follow the guide. It takes about two minutes and shows when you're connected. In Claude Code it comes down to:

```sh
claude mcp add --transport http --scope user infiniteboard https://infiniteboard-three.vercel.app/api/mcp
```

Restart Claude Code, run `/mcp`, choose **infiniteboard → Authenticate** and click **Allow access**. In claude.ai, add the same address under **Settings → Connectors → Add custom connector**. On Team and Enterprise plans only an Owner can do that, so use Claude Code there.

Keep the board tab open while the assistant works. Commands pass through the server briefly (they expire within a minute); the board itself never leaves your browser. *Disconnect* in the **AI** dialog revokes an app immediately.

Prefer to keep everything local? `claude mcp add infiniteboard -- npx -y infiniteboard-mcp` runs the MCP server on your machine (the **AI** dialog has the details for other apps).

| Tool | What it does |
|---|---|
| `get_board` | Everything on the board, plus the viewport and selection |
| `create_elements` | Stickies, shapes, text, frames, connectors and strokes in one call |
| `update_elements` / `delete_elements` | Move, resize, restyle, retext or remove elements |
| `focus_view` / `select_elements` | Move your view, highlight elements |
| `get_screenshot` | Lets the assistant check its own work |
| `undo` / `redo` | Shared history with you |

Tested end to end with the MCP SDK client and real OAuth. The Claude Code, Cursor and VS Code steps follow each app's docs but haven't been tested in those apps yet.

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
node mcp/e2e.mjs 9333 http://127.0.0.1:5173/ out              # local MCP server
```

Code map: `src/core` is the framework-free model (geometry, store with undo, connectors, snapping), `src/canvas` renders it, `src/interaction` handles input, `src/ui` is the React chrome, `src/ai` runs assistant commands, and `mcp/tools.mjs` defines the tools for both the local server and the hosted endpoint.

Not built yet: real-time collaboration, accounts and sharing, rich text, groups, touch pinch-zoom.

Apache-2.0.
