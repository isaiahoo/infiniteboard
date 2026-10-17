// End-to-end test of the hosted MCP connector: real OAuth (DCR + PKCE + consent click), real
// Streamable HTTP MCP client, real board tabs in Chrome. Works against the dev server or a deployment.
// Usage: node scripts/remote-e2e.mjs <cdpPort> <baseUrl> <outDir>
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [port = "9337", baseArg = "http://127.0.0.1:5173", outDir = "e2e-output"] = process.argv.slice(2);
const BASE = baseArg.replace(/\/+$/, "");
const MCP_URL = `${BASE}/api/mcp`;
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString("base64url");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---------- minimal CDP over the browser endpoint (supports isolated profiles) ----------
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

async function openTab(url, browserContextId) {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => cdp(m, p, sessionId);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  return {
    targetId, send, evaluate,
    waitFor: async (expr, ms = 20000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await evaluate(expr).catch(() => false)) return true;
      return false;
    },
    navigate: (u) => send("Page.navigate", { url: u }),
    close: () => cdp("Target.closeTarget", { targetId }),
  };
}

// ---------- OAuth helpers ----------
const codes = new Map();
const callback = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  codes.set(u.searchParams.get("state"), { code: u.searchParams.get("code"), error: u.searchParams.get("error") });
  res.writeHead(200, { "content-type": "text/plain" }).end("You can close this window.");
});
await new Promise((r) => callback.listen(0, "127.0.0.1", r));
const REDIRECT = `http://127.0.0.1:${callback.address().port}/callback`;

async function register(name) {
  const res = await fetch(`${BASE}/api/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  return res.json();
}

/** Full authorization-code flow; `tab` is a tab in the browser profile whose board should be approved. */
async function authorize(clientId, tab) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const u = new URL(`${BASE}/api/oauth/authorize`);
  Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, resource: MCP_URL })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { redirect: "manual" });
  const consent = res.headers.get("location");
  await tab.navigate(consent);
  await tab.waitFor("!!document.querySelector('.actions .primary')");
  await tab.evaluate("document.querySelector('.actions .primary').click()");
  for (let i = 0; i < 50 && !codes.has(state); i++) await sleep(200);
  const { code } = codes.get(state) ?? {};
  const tok = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  return { status: res.status, consent, tokens: await tok.json() };
}

async function mcpClient(accessToken) {
  const client = new Client({ name: "remote-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}
const tool = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.content[0].type === "text" ? JSON.parse(r.content[0].text) : r.content[0];
};

let failedHard = null;
try {
  // ---------- discovery & protection ----------
  const unauth = await fetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  const challenge = unauth.headers.get("www-authenticate") ?? "";
  check("MCP endpoint requires a token (401 + resource metadata)", unauth.status === 401 && challenge.includes("resource_metadata="));
  const metaUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  const meta = await (await fetch(metaUrl)).json();
  const as = await (await fetch(`${meta.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  check("discovery documents point at this deployment", meta.resource === MCP_URL && as.registration_endpoint === `${BASE}/api/oauth/register` && as.code_challenge_methods_supported.includes("S256"));

  // ---------- user A: board + consent (fresh, isolated browser profile so runs don't interfere) ----------
  const { browserContextId: ctxA } = await cdp("Target.createBrowserContext");
  const board = await openTab(`${BASE}/?sample`, ctxA);
  await board.waitFor("document.title.includes('Infiniteboard') && !!document.querySelector('.board')");
  const consentTab = await openTab("about:blank", ctxA);
  const clientA = await register("E2E Assistant");
  check("dynamic client registration", typeof clientA.client_id === "string" && clientA.client_id.length >= 32);

  const { status, consent, tokens } = await authorize(clientA.client_id, consentTab);
  check("authorize redirects to the consent page", status === 302 && consent.startsWith(`${BASE}/connect?request=`));
  check("consent + PKCE token exchange issues tokens", typeof tokens.access_token === "string" && typeof tokens.refresh_token === "string", tokens.error ?? "");
  await consentTab.close();

  // Board tab picks up the approval via the storage event and starts listening.
  const listening = await board.waitFor("document.querySelector('.ai-button')?.classList.contains('connected')", 15000);
  check("board tab starts listening after approval", listening, listening ? "" : await board.evaluate("document.querySelector('.ai-button')?.className + ' pref=' + localStorage.getItem('infiniteboard:remote')"));

  // ---------- real MCP over Streamable HTTP ----------
  const client = await mcpClient(tokens.access_token);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("tools/list over remote MCP", ["get_board", "create_elements", "update_elements", "delete_elements", "focus_view", "get_screenshot", "undo", "redo"].every((t) => tools.includes(t)));

  let t0 = Date.now();
  let b = await tool(client, "get_board");
  check("get_board reads the open board", b.elementCount === 14, `${b.elementCount} elements, ${Date.now() - t0} ms`);

  t0 = Date.now();
  const created = await tool(client, "create_elements", {
    elements: [
      { type: "frame", ref: "f", title: "Remote MCP", x: 2000, y: 0, w: 900, h: 400 },
      { type: "sticky", ref: "a", text: "From the cloud", x: 2060, y: 120, color: "blue" },
      { type: "shape", ref: "b", kind: "ellipse", text: "Board", x: 2500, y: 130 },
      { type: "connector", from: "a", to: "b", label: "relay" },
    ],
  });
  check("create_elements through the relay", created.created.length === 4, `${Date.now() - t0} ms`);
  const sticky = created.created[1].id;
  await tool(client, "update_elements", { updates: [{ id: sticky, text: "Moved remotely", y: 200 }] });
  b = await tool(client, "get_board");
  const s = b.elements.find((e) => e.id === sticky);
  check("update_elements changes the board", s.text === "Moved remotely" && s.y === 200 && s.frame === created.created[0].id);

  await tool(client, "focus_view", { ids: [created.created[0].id] });
  const shot = await tool(client, "get_screenshot");
  check("get_screenshot returns a JPEG", shot.type === "image" && shot.mimeType === "image/jpeg" && shot.data.length > 2000, `${Math.round(shot.data.length / 1024)} KB base64`);
  writeFileSync(join(outDir, "remote-screenshot.jpg"), Buffer.from(shot.data, "base64"));

  await tool(client, "undo");
  b = await tool(client, "get_board");
  check("undo through the relay", b.elements.find((e) => e.id === sticky)?.text === "From the cloud");

  // ---------- refresh token rotation ----------
  const refresh = async (rt) => (await fetch(`${BASE}/api/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientA.client_id }),
  })).json();
  const t2 = await refresh(tokens.refresh_token);
  const reuse = await refresh(tokens.refresh_token);
  check("refresh token rotates and can't be reused", !!t2.access_token && reuse.error === "invalid_grant");
  const client2 = await mcpClient(t2.access_token);
  check("refreshed access token works", (await tool(client2, "get_board")).elementCount === b.elementCount);

  // ---------- user B: separate browser profile must not see user A's board ----------
  const { browserContextId } = await cdp("Target.createBrowserContext");
  const boardB = await openTab(`${BASE}/`, browserContextId);
  await boardB.waitFor("!!document.querySelector('.board')");
  const consentB = await openTab("about:blank", browserContextId);
  const clientB = await register("Other user's assistant");
  const authB = await authorize(clientB.client_id, consentB);
  await consentB.close();
  await boardB.waitFor("document.querySelector('.ai-button')?.classList.contains('connected')", 15000);
  const cB = await mcpClient(authB.tokens.access_token);
  const bB = await tool(cB, "get_board");
  check("another user's token only reaches their own board", bB.elementCount === 0 && !bB.elements.some((e) => e.id === sticky));
  const bA = await tool(client2, "get_board");
  check("and user A's board is unaffected", bA.elementCount === b.elementCount);
  await cdp("Target.disposeBrowserContext", { browserContextId });

  // ---------- two tabs of the same board ----------
  const second = await openTab(`${BASE}/`, ctxA);
  await second.waitFor("!!document.querySelector('.ai-button')");
  await second.evaluate("document.querySelector('.ai-button').click()"); // opening the dialog claims the board
  const replaced = await board.waitFor("document.querySelector('.ai-button')?.classList.contains('replaced')", 60000);
  check("opening the AI dialog in another tab takes over; the old tab says so", replaced);
  check("commands now go to the new tab", (await tool(client2, "get_board")).elementCount >= 14);

  // ---------- revoke ----------
  await second.evaluate("document.querySelector('.app-list button')?.click()");
  await sleep(1500);
  const revoked = await fetch(MCP_URL, { method: "POST", headers: { authorization: `Bearer ${t2.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  check("Disconnect in the dialog revokes the app immediately", revoked.status === 401);

  // ---------- offline board ----------
  const authC = await authorize((await register("Offline check")).client_id, await openTab("about:blank", ctxA));
  await second.close();
  await board.close();
  await sleep(1500);
  const cC = await mcpClient(authC.tokens.access_token);
  const r = await cC.callTool({ name: "get_board", arguments: {} });
  check("closed board gives a clear error", r.isError && /isn't open/.test(r.content[0].text), r.content[0].text.slice(0, 80));
  await cdp("Target.disposeBrowserContext", { browserContextId: ctxA });
} catch (e) {
  failedHard = e;
  check("script completed", false, e instanceof Error ? e.message : String(e));
}

writeFileSync(join(outDir, "remote-results.json"), JSON.stringify(results, null, 2));
callback.close();
ws.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || failedHard ? 1 : 0);
