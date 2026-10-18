// Board storage in IndexedDB: many boards, a trash, and version snapshots, all in this browser.
// Version 1 kept a single board under the key "default"; it carries over as the first board.
import { emptyDoc, newId, type Doc } from "./model";
import { normalizeDoc } from "./persist";

const DB_NAME = "whiteboard";
const BOARDS = "boards";
const META = "meta";
const SNAPSHOTS = "snapshots";
const LAST_KEY = "infiniteboard:last-board";

export const TRASH_DAYS = 30;
const SNAPSHOTS_PER_BOARD = 40;

export interface BoardMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  count: number;
  deletedAt?: number;
}

export interface SnapshotInfo {
  id: number;
  boardId: string;
  at: number;
  reason: string;
  count: number;
  /** The board's updatedAt when the snapshot was taken, to skip duplicates. */
  rev: number;
}

const metaOf = (id: string, doc: Doc, prev?: BoardMeta): BoardMeta => ({
  id, title: doc.title, count: doc.order.length, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(),
});

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = (e) => {
      const db = r.result;
      const tx = r.transaction!;
      if (!db.objectStoreNames.contains(BOARDS)) db.createObjectStore(BOARDS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: "id", autoIncrement: true }).createIndex("board", "boardId");
      if (e.oldVersion === 1) {
        // Give the version-1 board its listing entry.
        const get = tx.objectStore(BOARDS).get("default");
        get.onsuccess = () => {
          const doc = normalizeDoc(get.result);
          if (doc) tx.objectStore(META).put({ ...metaOf("default", doc), createdAt: 0 });
        };
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("Storage is busy in another tab"));
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    // Closing lets other tabs upgrade or delete the database without being blocked.
    db.close();
  }
}

// ---------- boards ----------

export function listBoards(): Promise<BoardMeta[]> {
  return withDb(async (db) => {
    const all = await req(db.transaction(META).objectStore(META).getAll() as IDBRequest<BoardMeta[]>);
    // Trash older than TRASH_DAYS goes for good.
    const cutoff = Date.now() - TRASH_DAYS * 86400_000;
    const expired = all.filter((m) => m.deletedAt && m.deletedAt < cutoff);
    for (const m of expired) await purge(db, m.id);
    return all.filter((m) => !expired.includes(m)).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export function loadBoard(id: string): Promise<Doc | null> {
  return withDb(async (db) => normalizeDoc(await req(db.transaction(BOARDS).objectStore(BOARDS).get(id))));
}

export function saveBoard(id: string, doc: Doc): Promise<BoardMeta> {
  return withDb(async (db) => {
    const tx = db.transaction([BOARDS, META], "readwrite");
    const meta = tx.objectStore(META);
    const prev = (await req(meta.get(id))) as BoardMeta | undefined;
    const next = { ...metaOf(id, doc, prev), ...(prev?.deletedAt ? { deletedAt: prev.deletedAt } : {}) };
    tx.objectStore(BOARDS).put(doc, id);
    meta.put(next);
    await done(tx);
    return next;
  });
}

export async function createBoard(doc: Doc = emptyDoc()): Promise<string> {
  const id = newId().slice(0, 8);
  await saveBoard(id, doc);
  return id;
}

async function setDeleted(id: string, deletedAt: number | undefined) {
  await withDb(async (db) => {
    const tx = db.transaction(META, "readwrite");
    const m = (await req(tx.objectStore(META).get(id))) as BoardMeta | undefined;
    if (m) {
      const next = { ...m };
      if (deletedAt) next.deletedAt = deletedAt;
      else delete next.deletedAt;
      tx.objectStore(META).put(next);
    }
    await done(tx);
  });
}

/** Moves a board to the trash; it can be restored for TRASH_DAYS days. */
export const trashBoard = (id: string) => setDeleted(id, Date.now());
export const restoreBoard = (id: string) => setDeleted(id, undefined);

async function purge(db: IDBDatabase, id: string) {
  const tx = db.transaction([BOARDS, META, SNAPSHOTS], "readwrite");
  tx.objectStore(BOARDS).delete(id);
  tx.objectStore(META).delete(id);
  const keys = await req(tx.objectStore(SNAPSHOTS).index("board").getAllKeys(id));
  for (const k of keys) tx.objectStore(SNAPSHOTS).delete(k);
  await done(tx);
}

export const deleteBoardForever = (id: string) => withDb((db) => purge(db, id));

export function rememberBoard(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* ignore */
  }
}

/** The board to open: the one in the URL, else the last one used, else the newest, else a new one. */
export async function resolveBoard(requested: string | null): Promise<{ id: string; doc: Doc }> {
  const boards = (await listBoards()).filter((b) => !b.deletedAt);
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {
    /* ignore */
  }
  for (const id of [requested, last, boards[0]?.id]) {
    if (!id) continue;
    const doc = await loadBoard(id);
    if (doc) {
      if (boards.every((b) => b.id !== id)) await restoreBoard(id);
      return { id, doc };
    }
  }
  const doc = emptyDoc();
  const id = await createBoard(doc);
  return { id, doc };
}

/** For the consent page: the board this browser last had open. */
export async function loadLastBoard(): Promise<Doc> {
  try {
    return (await resolveBoardReadOnly()) ?? emptyDoc();
  } catch {
    return emptyDoc();
  }
}

async function resolveBoardReadOnly(): Promise<Doc | null> {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {
    /* ignore */
  }
  return (last && (await loadBoard(last))) || (await loadBoard("default"));
}

// ---------- snapshots ----------

export function addSnapshot(boardId: string, doc: Doc, reason: string, rev: number): Promise<void> {
  return withDb(async (db) => {
    const tx = db.transaction(SNAPSHOTS, "readwrite");
    const store = tx.objectStore(SNAPSHOTS);
    store.add({ boardId, at: Date.now(), reason, count: doc.order.length, rev, doc });
    // Keep the newest SNAPSHOTS_PER_BOARD (keys grow with time; the new one is already counted).
    const keys = (await req(store.index("board").getAllKeys(boardId))) as number[];
    for (const k of keys.sort((a, b) => a - b).slice(0, Math.max(0, keys.length - SNAPSHOTS_PER_BOARD))) store.delete(k);
    await done(tx);
  });
}

export function listSnapshots(boardId: string): Promise<SnapshotInfo[]> {
  return withDb(async (db) => {
    const store = db.transaction(SNAPSHOTS).objectStore(SNAPSHOTS);
    const out: SnapshotInfo[] = [];
    await new Promise<void>((resolve, reject) => {
      const c = store.index("board").openCursor(IDBKeyRange.only(boardId), "prev");
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve();
        const { id, at, reason, count, rev } = cur.value;
        out.push({ id, boardId, at, reason, count, rev });
        cur.continue();
      };
      c.onerror = () => reject(c.error);
    });
    return out;
  });
}

export function loadSnapshot(id: number): Promise<Doc | null> {
  return withDb(async (db) => normalizeDoc((await req(db.transaction(SNAPSHOTS).objectStore(SNAPSHOTS).get(id)))?.doc));
}

// ---------- backup ----------

export async function exportAllBoards(): Promise<Blob> {
  const metas = (await listBoards()).filter((m) => !m.deletedAt);
  const boards = [];
  for (const m of metas) {
    const doc = await loadBoard(m.id);
    if (doc) boards.push({ id: m.id, createdAt: m.createdAt, doc });
  }
  return new Blob([JSON.stringify({ format: "whiteboard-backup", version: 1, exportedAt: Date.now(), boards })], { type: "application/json" });
}

/** Reads a single-board export or a full backup. Each board is added as a new board; nothing is overwritten. */
export async function importBoards(file: File): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return [];
  }
  const p = parsed as { format?: string; boards?: { doc: unknown }[]; doc?: unknown };
  const docs = p?.format === "whiteboard-backup" && Array.isArray(p.boards)
    ? p.boards.map((b) => normalizeDoc(b?.doc))
    : [normalizeDoc(p?.format === "whiteboard" ? p.doc : parsed)];
  const ids: string[] = [];
  for (const doc of docs) if (doc) ids.push(await createBoard(doc));
  return ids;
}
