# infiniteboard-mcp

Lets AI assistants (Claude Code, Claude Desktop, Cursor, VS Code, or any MCP client) read and draw on your open Infiniteboard whiteboard.

1. Open the board and click **AI** in the top bar. The board starts waiting for your assistant.
2. Add this MCP server to your assistant. The dialog shows the exact steps for each app. The command is:

   ```bash
   npx -y infiniteboard-mcp
   ```

3. Ask away: *"Plan a habit-tracking app on my board: users, features, architecture and a roadmap"*.

Assistants can build laid-out flowcharts, system architectures, org charts, mind maps, kanban columns, grids and timelines in one call (`create_diagram`), tidy existing content (`arrange_elements`), and check their work with screenshots that don't move your view. In Claude Code, `/mcp__infiniteboard__plan_board` starts a guided plan of any idea.

The server runs on your machine. The board tab connects to it over `ws://127.0.0.1:3917` only while its AI switch is on.

Options: `--port <n>` (open the board with `?mcp=<n>` to match) and `--allow-origin <url>` for a hosted board other than localhost. Requires Node.js 18+.
