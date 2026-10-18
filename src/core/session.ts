// Keeps one open board saved: debounced autosave, flush when the tab is hidden or closed, retries,
// version snapshots, and live merging of changes saved by other tabs showing the same board.
import { addSnapshot, listSnapshots, saveBoard } from "./boards";
import type { Doc } from "./model";
import { rebase, type Store } from "./store";

export type SaveStatus = "saved" | "saving" | "error";

const SAVE_DELAY = 300;
const SNAPSHOT_EVERY = 10 * 60 * 1000;
const CHANNEL = "infiniteboard:boards";

interface Message {
  type: "saved";
  boardId: string;
  tab: string;
}

export class BoardSession {
  status: SaveStatus = "saved";
  lastSaved: number | null = null;
  private timer = 0;
  private retry = 0;
  private saving: Promise<void> | null = null;
  /** What this tab last wrote or read from storage; local edits are measured against it. */
  private base: Doc;
  private lastSnapshot = 0;
  private dirtySinceSnapshot = false;
  private pendingRemote = false;
  private readonly tab = Math.random().toString(36).slice(2);
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<() => void>();
  private offStore: () => void;

  constructor(readonly boardId: string, private store: Store, private load: (id: string) => Promise<Doc | null>) {
    this.base = store.doc;
    this.offStore = store.subscribe(() => this.onChange());
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e: MessageEvent<Message>) => {
        if (e.data?.type === "saved" && e.data.boardId === this.boardId && e.data.tab !== this.tab) void this.pullRemote();
      };
    } catch {
      /* no BroadcastChannel: tabs simply don't sync live */
    }
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.flushNow);
    void this.snapshotOnOpen();
    // Ask the browser not to evict boards under storage pressure (granted silently in most browsers).
    void navigator.storage?.persist?.().catch(() => {});
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getStatus = () => this.status;

  private set(status: SaveStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const fn of this.listeners) fn();
  }

  get dirty() {
    return this.store.doc !== this.base;
  }

  private onChange() {
    if (this.pendingRemote && !this.store.inTransaction) {
      this.pendingRemote = false;
      void this.pullRemote();
    }
    if (!this.dirty) return;
    this.dirtySinceSnapshot = true;
    this.set("saving");
    clearTimeout(this.timer);
    // Mid-gesture previews (dragging) are saved once the gesture ends or the timer fires.
    this.timer = window.setTimeout(() => void this.save(), SAVE_DELAY);
  }

  private onHide = () => {
    if (document.visibilityState === "hidden") this.flushNow();
  };

  /** Starts a save right away (closing tab, switching boards). */
  flushNow = () => {
    if (this.dirty) {
      clearTimeout(this.timer);
      void this.save();
    }
  };

  /** Resolves once everything changed so far is on disk. */
  async flush() {
    this.flushNow();
    while (this.saving) await this.saving;
  }

  private async save(): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (this.dirty) return this.save();
      return;
    }
    const doc = this.store.doc;
    this.saving = (async () => {
      try {
        const meta = await saveBoard(this.boardId, doc);
        this.base = doc;
        this.retry = 0;
        this.lastSaved = meta.updatedAt;
        this.channel?.postMessage({ type: "saved", boardId: this.boardId, tab: this.tab } satisfies Message);
        if (this.dirtySinceSnapshot && Date.now() - this.lastSnapshot > SNAPSHOT_EVERY) {
          this.dirtySinceSnapshot = false;
          this.lastSnapshot = Date.now();
          await addSnapshot(this.boardId, doc, "Auto-save", meta.updatedAt).catch(() => {});
        }
      } catch (e) {
        console.error("Save failed", e);
        this.set("error");
        // Keep trying with backoff; the edits stay in memory meanwhile.
        this.retry = Math.min(this.retry + 1, 6);
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.save(), 1000 * 2 ** this.retry);
      } finally {
        this.saving = null;
      }
    })();
    await this.saving;
    if (this.status !== "error") this.set(this.dirty ? "saving" : "saved");
    if (this.dirty && this.status !== "error") {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.save(), SAVE_DELAY);
    }
  }

  /** Another tab saved this board: merge its version with any unsaved edits here. */
  private async pullRemote() {
    if (this.store.inTransaction) {
      this.pendingRemote = true;
      return;
    }
    const remote = await this.load(this.boardId);
    if (!remote) return;
    if (this.store.inTransaction) {
      this.pendingRemote = true;
      return;
    }
    const local = this.store.doc;
    const merged = rebase(this.base, local, remote);
    this.base = remote;
    this.store.replaceExternal(merged);
  }

  /** A restore point of the board as it is now, e.g. before something destructive. */
  async checkpoint(reason: string) {
    await this.flush();
    this.lastSnapshot = Date.now();
    this.dirtySinceSnapshot = false;
    await addSnapshot(this.boardId, this.store.doc, reason, this.lastSaved ?? Date.now()).catch((e) => console.error("Snapshot failed", e));
  }

  /** A snapshot of the board as it was opened, unless the newest one already shows this state. */
  private async snapshotOnOpen() {
    if (!this.store.doc.order.length) return;
    try {
      const [latest] = await listSnapshots(this.boardId);
      const doc = this.store.doc;
      if (latest && latest.count === doc.order.length && Date.now() - latest.at < SNAPSHOT_EVERY) {
        this.lastSnapshot = latest.at;
        return;
      }
      this.lastSnapshot = Date.now();
      await addSnapshot(this.boardId, doc, "Opened", Date.now());
    } catch {
      /* snapshots are best-effort */
    }
  }

  dispose() {
    this.flushNow();
    this.offStore();
    this.channel?.close();
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.flushNow);
  }
}
