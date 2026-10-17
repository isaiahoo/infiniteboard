// OAuth 2.1 authorization server for MCP clients (RFC 6749 + PKCE, RFC 7591 dynamic registration,
// RFC 7009 revocation). The user approves access on /connect, in the browser that holds their board.
import { timingSafeEqual } from "node:crypto";
import {
  boardFromRequest, createGrant, getClient, issueTokens, registerClient, revokeToken, touchBoard, useRefreshToken,
} from "../_lib/auth.js";
import { HttpError, actionOf, handle, json, originOf, preflight, randomToken, readJson, sha256 } from "../_lib/http.js";
import { key, redis } from "../_lib/redis.js";

const REQUEST_TTL = 600;
const CODE_TTL = 300;

function validRedirect(uri) {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    // Native/desktop clients receive the code on a loopback port (RFC 8252).
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);

function redirectWith(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

// ---------- registration ----------

async function register(request) {
  const body = await readJson(request, 20_000);
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirect)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs (or http loopback URLs)");
  }
  const method = body.token_endpoint_auth_method ?? "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
  }
  const name = String(body.client_name ?? "AI assistant").replace(/[\u0000-\u001f]/g, "").slice(0, 80) || "AI assistant";
  const secret = method === "none" ? null : randomToken();
  const clientId = await registerClient({ name, redirectUris: uris, secret });
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201);
}

// ---------- authorization ----------

async function authorize(request) {
  const q = new URL(request.url).searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const client = await getClient(clientId);
  // Without a trustworthy redirect target we must not redirect at all.
  if (!client) return new Response("Unknown client. Remove the connector in your AI app and add it again.", { status: 400 });
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return new Response("This redirect address isn't registered for the client.", { status: 400 });
  }
  const state = q.get("state");
  const fail = (error, description) => Response.redirect(redirectWith(redirectUri, { error, error_description: description, state }), 302);
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only the authorization code flow is supported");
  const challenge = q.get("code_challenge");
  if (!challenge || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with S256 is required");
  }
  // RFC 8707: tokens are only ever valid for this deployment's MCP endpoint.
  const resource = q.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== `${originOf(request)}/api/mcp`) {
    return fail("invalid_target", "Unknown resource");
  }
  const id = randomToken();
  await redis().set(
    key("authreq", id),
    JSON.stringify({ clientId, clientName: client.name, redirectUri, challenge, state, resource: q.get("resource") }),
    "EX",
    REQUEST_TTL,
  );
  return Response.redirect(`${originOf(request)}/connect?request=${encodeURIComponent(id)}`, 302);
}

/** Lets the consent page show who is asking. */
async function requestInfo(request) {
  const id = new URL(request.url).searchParams.get("id");
  const raw = id && (await redis().get(key("authreq", id)));
  if (!raw) throw new HttpError(404, "This sign-in link has expired. Start connecting again from your AI app.");
  const { clientName, redirectUri } = JSON.parse(raw);
  return json({ clientName, redirectHost: new URL(redirectUri).host });
}

/** Called by the consent page with the board key from this browser. */
async function approve(request) {
  const boardId = boardFromRequest(request);
  const { id, allow } = await readJson(request, 10_000);
  const raw = typeof id === "string" && (await redis().getdel(key("authreq", id)));
  if (!raw) throw new HttpError(404, "This sign-in link has expired. Start connecting again from your AI app.");
  const req = JSON.parse(raw);
  if (!allow) return json({ redirect: redirectWith(req.redirectUri, { error: "access_denied", state: req.state }) });
  await touchBoard(boardId);
  const code = randomToken();
  await redis().set(
    key("code", sha256(code)),
    JSON.stringify({ ...req, boardId }),
    "EX",
    CODE_TTL,
  );
  return json({ redirect: redirectWith(req.redirectUri, { code, state: req.state, iss: originOf(request) }) });
}

// ---------- token ----------

async function readForm(request) {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return readJson(request, 20_000);
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function clientCredentials(request, form) {
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (basic) {
    const [id, secret] = Buffer.from(basic[1], "base64").toString().split(":").map(decodeURIComponent);
    return { clientId: id, clientSecret: secret };
  }
  return { clientId: form.client_id, clientSecret: form.client_secret };
}

const sameHash = (a, b) => a && b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function token(request) {
  const form = await readForm(request);
  const { clientId, clientSecret } = clientCredentials(request, form);
  const client = await getClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client", 401);
  if (client.secretHash && !sameHash(client.secretHash, clientSecret ? sha256(clientSecret) : "")) {
    return oauthError("invalid_client", "Client authentication failed", 401);
  }

  if (form.grant_type === "authorization_code") {
    const raw = typeof form.code === "string" && (await redis().getdel(key("code", sha256(form.code))));
    if (!raw) return oauthError("invalid_grant", "Authorization code is invalid or expired");
    const c = JSON.parse(raw);
    if (c.clientId !== clientId) return oauthError("invalid_grant", "Code was issued to another client");
    if (form.redirect_uri && form.redirect_uri !== c.redirectUri) return oauthError("invalid_grant", "redirect_uri mismatch");
    if (typeof form.code_verifier !== "string" || sha256(form.code_verifier) !== c.challenge) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    const grantId = await createGrant(c.boardId, clientId, c.clientName);
    return json(await issueTokens({ boardId: c.boardId, grantId, clientId, resource: c.resource }));
  }

  if (form.grant_type === "refresh_token") {
    const data = await useRefreshToken(form.refresh_token);
    if (!data || data.clientId !== clientId) return oauthError("invalid_grant", "Refresh token is invalid, expired or revoked");
    return json(await issueTokens(data));
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

async function revoke(request) {
  const form = await readForm(request);
  await revokeToken(form.token);
  return json({}); // RFC 7009: always 200
}

const ROUTES = {
  GET: { authorize, request: requestInfo },
  POST: { register, approve, token, revoke },
};

const route = (method) => handle(async (request) => {
  const fn = ROUTES[method][actionOf(request)];
  if (!fn) return json({ error: "Not found" }, 404);
  return fn(request);
});

export const GET = route("GET");
export const POST = route("POST");
export const OPTIONS = preflight;
