// Remote MCP endpoint (Streamable HTTP). Stateless: every request carries its OAuth bearer token,
// so any function instance can serve it. Tool calls are relayed to the user's open board tab.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { INSTRUCTIONS, registerBoardTools } from "../mcp/tools.mjs";
import { authenticateAccess } from "./_lib/auth.js";
import { CORS, json, originOf, preflight } from "./_lib/http.js";
import { callBoard } from "./_lib/relay.js";

export const config = { maxDuration: 60 };

function unauthorized(request, invalid) {
  const meta = `${originOf(request)}/.well-known/oauth-protected-resource/api/mcp`;
  const challenge = `Bearer resource_metadata="${meta}"${invalid ? ', error="invalid_token"' : ""}`;
  return json({ error: invalid ? "invalid_token" : "unauthorized" }, 401, { "WWW-Authenticate": challenge });
}

async function handle(request) {
  let auth;
  try {
    auth = await authenticateAccess(request);
  } catch {
    return json({ error: "Service temporarily unavailable" }, 503);
  }
  if (!auth) return unauthorized(request, !!request.headers.get("authorization"));

  const server = new McpServer({ name: "infiniteboard", version: "0.3.0" }, { instructions: INSTRUCTIONS });
  registerBoardTools(server, (method, params = {}) =>
    // Screenshots go through Redis, so keep them compact.
    callBoard(auth.boardId, method, method === "screenshot" ? { maxWidth: 1280, ...params, format: "jpeg" } : params),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
  return response;
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = preflight;
