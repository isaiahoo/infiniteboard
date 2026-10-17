// Connects the open board to a local MCP server (mcp/server.mjs) over WebSocket.
// Opt-in: nothing connects until the user enables it from the menu.
import type { Editor } from "../interaction/editor";
import { runCommand } from "./commands";

export type BridgeStatus = "off" | "connecting" | "connected" | "replaced";

const PREF_KEY = "whiteboard:ai-bridge";
export const DEFAULT_BRIDGE_PORT = 3917;

function bridgeUrl(): string {
  const port = Number(new URLSearchParams(location.search).get("mcp")) || DEFAULT_BRIDGE_PORT;
  return `ws://127.0.0.1:${port}`;
}

export class AiBridge {
  status: BridgeStatus = "off";
  lastActivity: string | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private enabled = false;
  private listeners = new Set<() => void>();
  readonly url = bridgeUrl();

  constructor(private editor: Editor) {
    try {
      if (localStorage.getItem(PREF_KEY) === "on") this.enable();
    } catch {
      /* storage unavailable */
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(status: BridgeStatus) {
    this.status = status;
    for (const fn of this.listeners) fn();
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.savePref("on");
    this.connect();
  }

  disable() {
    this.savePref("off");
    this.dispose();
    this.set("off");
  }

  /** Stops connecting without changing the saved preference (e.g. when the app unmounts). */
  dispose() {
    this.enabled = false;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }

  private savePref(v: string) {
    try {
      localStorage.setItem(PREF_KEY, v);
    } catch {
      /* ignore */
    }
  }

  private connect() {
    if (!this.enabled) return;
    this.set("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.set("connected");
      ws.send(JSON.stringify({ type: "hello", app: "whiteboard", protocol: 1, title: this.editor.doc.title }));
    };
    ws.onmessage = (ev) => void this.handle(ws, ev.data);
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      if (ev.code === 4000) {
        // Another tab took over the assistant; stay idle until the user re-enables it here.
        this.enabled = false;
        this.set("replaced");
        return;
      }
      if (this.enabled) {
        this.set("connecting");
        this.scheduleRetry();
      }
    };
  }

  private scheduleRetry() {
    clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.connect(), 2000);
  }

  private async handle(ws: WebSocket, raw: unknown) {
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id !== "number" && typeof msg.id !== "string") return;
    if (typeof msg.method !== "string") return;
    try {
      const params = msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
      const result = await runCommand(this.editor, msg.method, params);
      this.lastActivity = msg.method;
      for (const fn of this.listeners) fn();
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
}
