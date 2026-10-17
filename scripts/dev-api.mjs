// Runs the Vercel functions in api/ locally, with the same routes as vercel.json.
// Usage: node --env-file=.env.local scripts/dev-api.mjs   (Vite proxies /api and /.well-known here)
import { createServer } from "node:http";

const PORT = Number(process.env.API_PORT) || 3001;

function route(pathname) {
  if (pathname.startsWith("/.well-known/oauth-protected-resource")) return ["../api/well-known.js", "doc=resource"];
  if (pathname.startsWith("/.well-known/oauth-authorization-server")) return ["../api/well-known.js", "doc=server"];
  if (pathname === "/api/mcp") return ["../api/mcp.js"];
  if (pathname.startsWith("/api/oauth/")) return ["../api/oauth/[action].js"];
  if (pathname.startsWith("/api/board/")) return ["../api/board/[action].js"];
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = route(url.pathname);
  if (!target) return res.writeHead(404).end();
  const [file, query] = target;
  if (query) url.search = url.search ? `${url.search}&${query}` : `?${query}`;
  const mod = await import(new URL(file, import.meta.url));
  const fn = mod[req.method];
  if (!fn) return res.writeHead(405).end();

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const abort = new AbortController();
  res.on("close", () => !res.writableFinished && abort.abort());
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    signal: abort.signal,
  });
  const response = await fn(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.error(`API on http://127.0.0.1:${PORT}`));
