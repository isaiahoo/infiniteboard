// Board identities, OAuth clients, grants and tokens.
//
// - A board is identified by a 256-bit secret that never leaves the user's browser; the server only
//   sees it on requests from that browser and stores nothing but its hash (the boardId).
// - Each app the user approves gets a grant on that board. Access/refresh tokens point at the grant,
//   so removing the grant (or all grants) revokes the app immediately.
// - Every secret is stored as a SHA-256 hash; plaintext tokens exist only in responses to their owner.
import { HttpError, bearer, randomToken, sha256 } from "./http.js";
import { key, redis } from "./redis.js";

const DAY = 86400;
export const ACCESS_TTL = DAY; // 24 h, refreshed silently by MCP clients
const REFRESH_TTL = 90 * DAY;
const BOARD_TTL = 180 * DAY;
const CLIENT_TTL = 180 * DAY;

// ---------- boards ----------

/** Authenticates a request from the board tab; returns its boardId. */
export function boardFromRequest(request) {
  const secret = bearer(request);
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new HttpError(401, "Missing or malformed board key");
  return sha256(secret);
}

export async function touchBoard(boardId) {
  await redis().set(key("board", boardId), Date.now(), "EX", BOARD_TTL);
}

// ---------- clients (dynamic client registration) ----------

export async function registerClient({ name, redirectUris, secret }) {
  const clientId = randomToken();
  const record = { name, redirectUris, secretHash: secret ? sha256(secret) : null, created: Date.now() };
  await redis().set(key("client", clientId), JSON.stringify(record), "EX", CLIENT_TTL);
  return clientId;
}

export async function getClient(clientId) {
  if (typeof clientId !== "string" || clientId.length > 100) return null;
  const raw = await redis().get(key("client", clientId));
  return raw ? JSON.parse(raw) : null;
}

// ---------- grants ----------

export async function createGrant(boardId, clientId, clientName) {
  const grantId = randomToken().slice(0, 16);
  const r = redis();
  await r
    .multi()
    .hset(key("grants", boardId), grantId, JSON.stringify({ clientId, clientName, created: Date.now() }))
    .expire(key("grants", boardId), BOARD_TTL)
    .exec();
  return grantId;
}

export async function listGrants(boardId) {
  const all = await redis().hgetall(key("grants", boardId));
  return Object.entries(all)
    .map(([id, v]) => ({ id, ...JSON.parse(v) }))
    .map(({ id, clientName, created }) => ({ id, clientName, created }))
    .sort((a, b) => a.created - b.created);
}

export async function revokeGrants(boardId, grantId) {
  if (grantId) await redis().hdel(key("grants", boardId), grantId);
  else await redis().del(key("grants", boardId));
}

// ---------- tokens ----------

export async function issueTokens({ boardId, grantId, clientId, resource }) {
  const access = randomToken();
  const refresh = randomToken();
  const data = JSON.stringify({ boardId, grantId, clientId, resource });
  await redis()
    .multi()
    .set(key("at", sha256(access)), data, "EX", ACCESS_TTL)
    .set(key("rt", sha256(refresh)), data, "EX", REFRESH_TTL)
    .exec();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "board" };
}

/** Consumes a refresh token (rotation): returns its grant data or null if unknown/revoked. */
export async function useRefreshToken(token) {
  if (typeof token !== "string") return null;
  const raw = await redis().getdel(key("rt", sha256(token)));
  if (!raw) return null;
  const data = JSON.parse(raw);
  return (await grantExists(data)) ? data : null;
}

export async function revokeToken(token) {
  if (typeof token !== "string") return;
  const h = sha256(token);
  await redis().del(key("at", h), key("rt", h));
}

async function grantExists({ boardId, grantId }) {
  return (await redis().hexists(key("grants", boardId), grantId)) === 1;
}

/** Validates an MCP request's access token. Returns { boardId, grantId, clientId } or null. */
export async function authenticateAccess(request) {
  const token = bearer(request);
  if (!token) return null;
  const raw = await redis().get(key("at", sha256(token)));
  if (!raw) return null;
  const data = JSON.parse(raw);
  return (await grantExists(data)) ? data : null;
}
