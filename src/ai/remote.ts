// Hosted connector, board side: long-polls our API for commands from remote MCP clients
// (claude.ai and others) and answers them with the same commands the local bridge uses.
import type { Editor } from "../interaction/editor";
import { boardApi } from "./boardKey";
import { runCommand } from "./commands";

export type RemoteStatus = "off" | "connecting" | "ready" | "replaced" | "paused" | "error";
export interface ConnectedApp {
  id: string;
  clientName: string;
  created: number;
}

const PREF = "infiniteboard:remote";
const HIDDEN_PAUSE_MS = 15 * 60 * 1000;

interface Command {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  deadline: number;
}

export class RemoteLink {
  status: RemoteStatus = "off";
  apps: ConnectedApp[] = [];
  lastUsed: number | null = null;
  private running = false;
  private claim = false;
  private abort: AbortController | null = null;
  private hiddenSince: number | null = null;
  private listeners = new Set<() => void>();
  private readonly tabId = crypto.randomUUID().replace(/-/g, "");

  constructor(private editor: Editor) {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("storage", this.onStorage);
    window.addEventListener("pagehide", this.leave);
    if (readPref() === "on") this.start(false);
  }

  /** Tells the server this tab stopped listening, so assistants get a clear "board isn't open". */
  private leave = () => {
    if (this.status === "off") return;
    void boardApi("leave", { tabId: this.tabId }, undefined, true).catch(() => {});
  };

  // The consent page (another tab) turns the link on after the user approves an app.
  private onStorage = (e: StorageEvent) => {
    if (e.key !== PREF || e.newValue !== "on") return;
    this.start(false);
    // The app finishes its token exchange a moment after the user approves; pick the new grant up.
    for (const ms of [3000, 8000, 20000]) setTimeout(() => void this.refreshApps(), ms);
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Snapshot for useSyncExternalStore. */
  getSnapshot = () => this.version;
  private version = 0;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private set(status: RemoteStatus) {
    if (this.status !== status) {
      this.status = status;
      this.emit();
    }
  }

  /** Starts listening. `claim` takes the board over from another tab. */
  start(claim = true) {
    writePref("on");
    this.claim = this.claim || claim;
    if (!this.running) void this.loop();
    void this.refreshApps();
  }

  stop() {
    writePref("off");
    this.leave();
    this.running = false;
    this.abort?.abort();
    this.set("off");
  }

  dispose() {
    this.running = false;
    this.abort?.abort();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("storage", this.onStorage);
    window.removeEventListener("pagehide", this.leave);
  }

  async refreshApps() {
    try {
      const { apps } = await boardApi<{ apps: ConnectedApp[] }>("status");
      this.apps = apps;
      this.emit();
    } catch {
      /* shown via status */
    }
  }

  async disconnect(grantId?: string) {
    const { apps } = await boardApi<{ apps: ConnectedApp[] }>("revoke", grantId ? { grantId } : {});
    this.apps = apps;
    this.emit();
  }

  private onVisibility = () => {
    if (document.hidden) this.hiddenSince = Date.now();
    else {
      this.hiddenSince = null;
      if (this.status === "paused" && readPref() === "on") void this.loop();
    }
  };

  private async loop() {
    this.running = true;
    let backoff = 1000;
    let first = true;
    if (this.status === "off" || this.status === "paused" || this.status === "replaced") this.set("connecting");
    while (this.running) {
      if (this.hiddenSince && Date.now() - this.hiddenSince > HIDDEN_PAUSE_MS) {
        // A forgotten background tab shouldn't keep a connection open forever.
        this.running = false;
        this.set("paused");
        return;
      }
      this.abort = new AbortController();
      const timer = setTimeout(() => this.abort?.abort(), 60_000);
      try {
        const claimed = this.claim;
        const res = await boardApi<{ status: string; command?: Command }>("poll", { tabId: this.tabId, claim: claimed, wait: !first }, this.abort.signal);
        first = false;
        if (claimed) this.claim = false;
        backoff = 1000;
        // A takeover requested while this poll was in flight wins over its "replaced" answer.
        if (res.status === "replaced" && !this.claim) {
          this.running = false;
          this.set("replaced");
          return;
        }
        this.set("ready");
        if (res.command) await this.execute(res.command);
      } catch {
        if (!this.running) break;
        this.set("error");
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async execute(cmd: Command) {
    let reply: { id: string; result?: unknown; error?: string };
    if (Date.now() > cmd.deadline) reply = { id: cmd.id, error: "Request expired before the board received it" };
    else {
      try {
        reply = { id: cmd.id, result: await runCommand(this.editor, cmd.method, cmd.params ?? {}) };
      } catch (e) {
        reply = { id: cmd.id, error: e instanceof Error ? e.message : String(e) };
      }
    }
    this.lastUsed = Date.now();
    this.emit();
    try {
      await boardApi("result", reply);
    } catch {
      /* the caller times out and reports it */
    }
    // A new app may have been approved since we last looked.
    if (!this.apps.length) void this.refreshApps();
  }
}

function readPref() {
  try {
    return localStorage.getItem(PREF);
  } catch {
    return null;
  }
}

function writePref(v: string) {
  try {
    localStorage.setItem(PREF, v);
  } catch {
    /* ignore */
  }
}
