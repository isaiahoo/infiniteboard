// Endpoints used by the board tab, authenticated with the board key from that browser.
//   POST poll    – long-poll for the next command (claims the board for this tab if asked)
//   POST result  – reply to a command
//   POST leave   – this tab is closing / stopped listening
//   POST status  – list connected apps
//   POST revoke  – disconnect one app ({ grantId }) or all apps ({})
import { boardFromRequest, listGrants, revokeGrants, touchBoard } from "../_lib/auth.js";
import { actionOf, handle, json, preflight, readJson } from "../_lib/http.js";
import { blpop, redis } from "../_lib/redis.js";
import { ACTIVE_TTL, activeKey, deliverResult, queueKey } from "../_lib/relay.js";

export const config = { maxDuration: 60 };

const POLL_WAIT = 45; // seconds; well inside the function time limit

// Marks this tab as the board's active tab. Another tab only takes over when it explicitly claims.
const CLAIM = `
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] and ARGV[2] ~= '1' then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1`;

async function poll(request) {
  const boardId = boardFromRequest(request);
  const { tabId, claim, wait = true } = await readJson(request, 2000);
  if (typeof tabId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(tabId)) return json({ error: "Bad tabId" }, 400);
  const ok = await redis().eval(CLAIM, 1, activeKey(boardId), tabId, claim ? "1" : "0", ACTIVE_TTL);
  if (!ok) return json({ status: "replaced" });
  if (claim) await touchBoard(boardId);
  // The first poll of a session returns at once so the tab can show it's online.
  if (wait === false) return json({ status: "idle" });

  // Stop waiting if the browser goes away, so we don't steal a command meant for its replacement.
  const raw = await blpop(queueKey(boardId), POLL_WAIT, request.signal);
  if (!raw) return json({ status: "idle" });
  // Hand the command back if this tab went away or was replaced while it waited.
  const stillActive = (await redis().get(activeKey(boardId))) === tabId;
  if (request.signal?.aborted || !stillActive) {
    await redis().lpush(queueKey(boardId), raw);
    return json({ status: stillActive ? "idle" : "replaced" });
  }
  return json({ status: "command", command: JSON.parse(raw) });
}

const LEAVE = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end return 1`;

async function leave(request) {
  const boardId = boardFromRequest(request);
  const { tabId } = await readJson(request, 2000);
  if (typeof tabId === "string") await redis().eval(LEAVE, 1, activeKey(boardId), tabId);
  return json({ ok: true });
}

async function result(request) {
  boardFromRequest(request);
  const { id, result, error } = await readJson(request);
  await deliverResult(id, error ? { error: String(error).slice(0, 2000) } : { result });
  return json({ ok: true });
}

async function status(request) {
  const boardId = boardFromRequest(request);
  return json({ apps: await listGrants(boardId) });
}

async function revoke(request) {
  const boardId = boardFromRequest(request);
  const { grantId } = await readJson(request, 2000);
  await revokeGrants(boardId, typeof grantId === "string" ? grantId : undefined);
  return json({ apps: await listGrants(boardId) });
}

const ROUTES = { poll, leave, result, status, revoke };

export const POST = handle(async (request) => {
  const fn = ROUTES[actionOf(request)];
  if (!fn) return json({ error: "Not found" }, 404);
  return fn(request);
});
export const OPTIONS = preflight;
