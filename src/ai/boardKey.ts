// The board key identifies this browser's board to the hosted connector. It never leaves this
// origin except in Authorization headers to our own API, and the server stores only its hash.
const KEY = "infiniteboard:board-key";

export function boardKey(): string {
  let k: string | null = null;
  try {
    k = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  if (k && /^[A-Za-z0-9_-]{43}$/.test(k)) return k;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  k = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    localStorage.setItem(KEY, k);
  } catch {
    /* key lives for this session only */
  }
  return k;
}

export async function boardApi<T>(action: string, body: unknown = {}, signal?: AbortSignal, keepalive = false): Promise<T> {
  const res = await fetch(`/api/board/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${boardKey()}` },
    body: JSON.stringify(body),
    signal,
    keepalive,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
