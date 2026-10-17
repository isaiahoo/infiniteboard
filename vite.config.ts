import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// In production vercel.json rewrites /connect; mirror that in the dev server.
const connectPage: Plugin = {
  name: "connect-page",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith("/connect?") || req.url === "/connect") req.url = req.url.replace("/connect", "/connect.html");
      next();
    });
  },
};

export default defineConfig(({ command }) => ({
  plugins: [react(), connectPage],
  define: {
    // Dev server only: lets the AI dialog offer the local MCP server file before the npm package is published.
    // Production builds never contain a local path.
    __LOCAL_MCP_SERVER__: JSON.stringify(command === "serve" ? fileURLToPath(new URL("./mcp/server.mjs", import.meta.url)) : null),
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        connect: fileURLToPath(new URL("./connect.html", import.meta.url)),
      },
    },
  },
  server: {
    // `npm run dev:api` serves the Vercel functions locally (needs REDIS_URL in .env.local).
    proxy: {
      // Keep the browser-facing Host so OAuth metadata advertises the dev server's own address.
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: false },
      "/.well-known": { target: "http://127.0.0.1:3001", changeOrigin: false },
    },
  },
  test: { environment: "node" },
}) as never);
