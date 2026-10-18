// End-to-end test of the empty-board start guide: app tabs, phone layout, and the live
// "connected" state after a real OAuth approval in another tab. Works against dev or a deployment.
// Usage: node scripts/guide-e2e.mjs <cdpPort> <baseUrl> <outDir>
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
const shot = async (tab, name) => {
  const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
};
const click = (tab, selector) => tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const text = (tab, selector) => tab.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

try {
  const { browserContextId } = await cdp("Target.createBrowserContext");
  const board = await openTab(`${BASE}/`, browserContextId);
  const has = (sel) => board.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const clickText = (sel, label) => board.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`);
  const choose = (name) => board.evaluate(`[...document.querySelectorAll('.guide-choice')].find((b) => b.querySelector('b').textContent === ${JSON.stringify(name)}).click()`);
  const heading = () => text(board, ".guide-title-row");
  const key = async (k, code) => {
    await board.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k });
    await board.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
    await sleep(150);
  };

  check("empty board opens the guide at step 1", await board.waitFor("!!document.querySelector('.start-guide')") && (await heading()).includes("Step 1 of 4"));
  check("old empty-board message is gone", !(await board.evaluate("document.body.innerText.includes('Your board is empty')")));
  await shot(board, "guide-1-choose.png");

  // Claude path, including the Team-plan detour to Claude Code.
  await choose("Claude");
  check("choosing Claude moves to step 2 with the connector address", (await heading()).includes("Step 2 of 4") && (await text(board, ".guide-step pre")) === MCP_URL);
  await shot(board, "guide-2-claude.png");
  await clickText(".guide-step button.link", "Use Claude Code instead");
  check("Team-plan link switches to the Claude Code command", (await text(board, ".guide-step pre")) === `claude mcp add --transport http --scope user infiniteboard ${MCP_URL}`);
  await shot(board, "guide-2-add.png");
  await clickText(".guide-step button", "I've run it");
  const auth = await text(board, ".guide-step");
  check("step 3 says to start a new session, then /mcp, then Allow access", (await heading()).includes("Step 3 of 4") && auth.includes("Restart Claude Code") && auth.includes("/mcp") && auth.includes("Allow access"));
  check("step 3 shows it's waiting", await has(".guide-status .dot.waiting"));
  await shot(board, "guide-3-auth.png");

  await board.navigate(`${BASE}/`);
  await board.waitFor("!!document.querySelector('.start-guide')");
  check("a reload resumes at the same step", (await heading()).includes("Step 3 of 4"));
  await clickText(".guide-nav button", "Back");
  await clickText(".guide-nav button", "Back");
  check("Back returns to step 1", (await heading()).includes("Step 1 of 4"));

  await choose("Cursor");
  const cursorHref = await board.evaluate("document.querySelector('.guide-install').href");
  const cursorCfg = JSON.parse(Buffer.from(new URL(cursorHref).searchParams.get("config"), "base64").toString());
  check("Cursor: one-click install link with the connector address", cursorHref.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=infiniteboard") && cursorCfg.url === MCP_URL);
  await clickText(".guide-nav button", "Back");
  await choose("VS Code");
  const vsHref = await board.evaluate("document.querySelector('.guide-install').href");
  const vsCfg = JSON.parse(decodeURIComponent(vsHref.slice("vscode:mcp/install?".length)));
  check("VS Code: one-click install link with the connector address", vsCfg.type === "http" && vsCfg.url === MCP_URL && vsCfg.name === "infiniteboard");
  await clickText(".guide-nav button", "Back");
  await choose("Claude Code");
  await clickText(".guide-step button", "I've run it");

  await board.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const fits = await board.evaluate("(() => { const r = document.querySelector('.start-guide').getBoundingClientRect(); return r.left >= 15 && r.right <= innerWidth - 15 && document.documentElement.scrollWidth <= innerWidth; })()");
  check("guide fits a phone screen with no sideways scroll", fits);
  await shot(board, "guide-phone.png");
  await board.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  await key("s", "KeyS");
  check("guide steps aside when you pick a drawing tool", !(await has(".start-guide")));
  await key("v", "KeyV");
  check("and comes back on the select tool", await board.waitFor("!!document.querySelector('.start-guide')", 2000));
  await click(board, ".ai-button");
  await sleep(200);
  check("guide steps aside while the AI dialog is open", !(await has(".start-guide")));
  await click(board, ".dialog-head button");
  await sleep(200);

  // Approve an app in another tab, the way a real sign-in does; the guide should notice by itself.
  const client = await register("Claude Code");
  const consentTab = await openTab("about:blank", browserContextId);
  const tokens = (await authorize(client.client_id, consentTab)).tokens;
  await consentTab.close();
  const t0 = Date.now();
  check("guide moves to step 4 by itself after Allow access", await board.waitFor("!!document.querySelector('.guide-status.connected')", 25000), `${Date.now() - t0} ms`);
  check("step 4 names the app and offers prompts", (await heading()).includes("Step 4 of 4") && (await text(board, ".guide-status")).includes("Claude Code is connected") && (await board.evaluate("document.querySelectorAll('.start-guide .prompts .copy-block').length")) === 2);
  await shot(board, "guide-4-connected.png");

  const mcp = await mcpClient(tokens.access_token);
  await tool(mcp, "get_board");
  check("after the assistant reads the board, the guide suggests drawing", await board.waitFor("document.querySelector('.guide-status')?.textContent.includes('just read your board')", 5000));
  await shot(board, "guide-5-read.png");
  await tool(mcp, "create_elements", { elements: [{ type: "sticky", text: "Hello from the assistant", x: 0, y: 0 }] });
  check("guide disappears once the assistant draws", await board.waitFor("!document.querySelector('.start-guide')", 5000));
  await tool(mcp, "undo");
  check("guide returns, still connected, when the board is empty again", await board.waitFor("!!document.querySelector('.guide-status.connected')", 5000));

  await click(board, ".guide-head button");
  await sleep(200);
  check("✕ hides the guide", !(await has(".start-guide")));
  await board.navigate(`${BASE}/`);
  await sleep(1500);
  check("hidden guide stays hidden after reload", !(await has(".start-guide")) && (await has(".ai-button")));
  await cdp("Target.disposeBrowserContext", { browserContextId });
} catch (e) {
  failedHard = e;
  check("script completed", false, e instanceof Error ? e.message : String(e));
}

writeFileSync(join(outDir, "guide-results.json"), JSON.stringify(results, null, 2));
callback.close();
ws.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || failedHard ? 1 : 0);
