// Redis access. One shared connection per function instance for normal commands, plus a
// short-lived dedicated connection for each blocking wait (a blocked connection can't serve others).
import Redis from "ioredis";

const URL_ = process.env.REDIS_URL ?? process.env.KV_URL;
const ENV = process.env.VERCEL_ENV ?? "development";

/** Keys are namespaced per environment so preview deployments never touch production data. */
export const key = (...parts) => ["ib", ENV, ...parts].join(":");

const options = { enableReadyCheck: false, maxRetriesPerRequest: 2, connectTimeout: 5000 };

let shared = null;

export function redis() {
  if (!URL_) throw new Error("REDIS_URL is not configured");
  if (!shared) {
    shared = new Redis(URL_, options);
    shared.on("error", () => {}); // reconnects automatically; never log the URL
  }
  return shared;
}

/** BLPOP on a dedicated connection. Resolves to the popped value, or null on timeout. */
export async function blpop(listKey, timeoutSeconds, signal) {
  if (!URL_) throw new Error("REDIS_URL is not configured");
  const conn = new Redis(URL_, { ...options, lazyConnect: true, maxRetriesPerRequest: 0 });
  conn.on("error", () => {});
  const abort = () => conn.disconnect();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await conn.connect();
    const res = await conn.blpop(listKey, timeoutSeconds);
    return res ? res[1] : null;
  } catch (e) {
    if (signal?.aborted) return null;
    throw e;
  } finally {
    signal?.removeEventListener("abort", abort);
    conn.disconnect();
  }
}
