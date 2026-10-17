// Small helpers shared by the API functions. Nothing here may log secrets.
import { createHash, randomBytes } from "node:crypto";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers },
  });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

/** Public origin of this deployment, e.g. https://infiniteboard-three.vercel.app */
export function originOf(request) {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Last path segment, used by the [action] routes. */
export const actionOf = (request) => new URL(request.url).pathname.replace(/\/+$/, "").split("/").pop();

/** 256-bit random token, URL-safe. */
export const randomToken = () => randomBytes(32).toString("base64url");

export const sha256 = (s) => createHash("sha256").update(s).digest("base64url");

export function bearer(request) {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function readJson(request, limit = 6 * 1024 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "Request too large");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Wraps a handler so HttpErrors become JSON responses and unexpected errors don't leak details. */
export const handle = (fn) => async (request) => {
  try {
    return await fn(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error("Unhandled error:", e instanceof Error ? e.message : "unknown");
    return json({ error: "Internal error" }, 500);
  }
};
