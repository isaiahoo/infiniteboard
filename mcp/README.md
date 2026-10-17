# infiniteboard-mcp

Lets AI assistants (Claude Code, Claude Desktop, Cursor, VS Code, or any MCP client) read and draw on your open Infiniteboard whiteboard.

1. Open the board and click **AI** in the top bar. The board starts waiting for your assistant.
2. Add this MCP server to your assistant. The dialog shows the exact steps for each app. The command is:

   ```bash
   npx -y infiniteboard-mcp
   ```

3. Ask away: *"Sketch a user-signup flowchart on my board"*.

The server runs on your machine. The board tab connects to it over `ws://127.0.0.1:3917` only while its AI switch is on.

Options: `--port <n>` (open the board with `?mcp=<n>` to match) and `--allow-origin <url>` for a hosted board other than localhost. Requires Node.js 18+.
