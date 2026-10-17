import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    // Dev server only: lets the AI dialog offer the local MCP server file before the npm package is published.
    // Production builds never contain a local path.
    __LOCAL_MCP_SERVER__: JSON.stringify(command === "serve" ? fileURLToPath(new URL("./mcp/server.mjs", import.meta.url)) : null),
  },
  test: { environment: "node" },
}) as never);
