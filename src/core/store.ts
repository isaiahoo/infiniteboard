import type { Asset, BoardElement, Doc } from "./model";

/**
 * A history entry: per-element before/after values (null = absent) plus paint order.
 * Elements are immutable, so changes are found by reference comparison.
 */
export interface Change {
  before: Record<string, BoardElement | null>;
  after: Record<string, BoardElement | null>;
  orderBefore: readonly string[];
  orderAfter: readonly string[];
  titleBefore: string;
  titleAfter: string;
}

/** Mutable view of the document used inside `update`. */
export interface Draft {
  get(id: string): BoardElement | undefined;
  set(el: BoardElement): void;
  patch<T extends BoardElement>(id: string, fields: Partial<T>): void;
  remove(id: string): void;
  insert(el: BoardElement, index?: number): void;
  setOrder(order: string[]): void;
  addAsset(asset: Asset): void;
  setTitle(title: string): void;
  readonly doc: Doc;
}

export const HISTORY_LIMIT = 200;

type Listener = (doc: Doc) => void;

export class Store {
  private _doc: Doc;
  private base: Doc | null = null;
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private listeners = new Set<Listener>();

  constructor(doc: Doc) {
    this._doc = doc;
  }

  get doc(): Doc {
    return this._doc;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  get inTransaction() {
    return this.base !== null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this._doc);
  }

  /** Starts a gesture: subsequent `update`s are previewed and folded into one history step on `commit`. */
  begin() {
    if (!this.base) this.base = this._doc;
  }

  update(fn: (d: Draft) => void) {
    let elements: Record<string, BoardElement> | null = null;
    let order: string[] | null = null;
    let assets: Record<string, Asset> | null = null;
    let title = this._doc.title;
    const cur = this._doc;
    const els = () => (elements ??= { ...cur.elements });
    const ord = () => (order ??= cur.order.slice());
    const draft: Draft = {
      get: (id) => (elements ?? cur.elements)[id],
      set: (el) => {
        if (!(el.id in (elements ?? cur.elements))) ord().push(el.id);
        els()[el.id] = el;
      },
      patch: (id, fields) => {
        const prev = (elements ?? cur.elements)[id];
        if (prev) els()[id] = { ...prev, ...fields } as BoardElement;
      },
      remove: (id) => {
        if (!(id in (elements ?? cur.elements))) return;
        delete els()[id];
        const o = ord();
        const i = o.indexOf(id);
        if (i >= 0) o.splice(i, 1);
      },
      insert: (el, index) => {
        els()[el.id] = el;
        const o = ord();
        const i = o.indexOf(el.id);
        if (i >= 0) o.splice(i, 1);
        o.splice(index ?? o.length, 0, el.id);
      },
      setOrder: (o) => {
        order = o;
      },
      addAsset: (a) => {
        assets ??= { ...cur.assets };
        assets[a.id] = a;
      },
      setTitle: (t) => {
        title = t;
      },
      get doc() {
        return { ...cur, elements: elements ?? cur.elements, order: order ?? cur.order, assets: assets ?? cur.assets, title };
      },
    };
    fn(draft);
    if (!elements && !order && !assets && title === cur.title) return;
    this._doc = { ...cur, elements: elements ?? cur.elements, order: order ?? cur.order, assets: assets ?? cur.assets, title };
    this.emit();
  }

  /** Finishes the current gesture, recording one undo step if anything changed. */
  commit() {
    const base = this.base;
    this.base = null;
    if (!base) return;
    const change = diff(base, this._doc);
    if (change) {
      this.undoStack.push(change);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emit();
  }

  /** Abandons the current gesture and restores the document. */
  cancel() {
    if (!this.base) return;
    this._doc = this.base;
    this.base = null;
    this.emit();
  }

  /** One-shot update recorded as its own history step. */
  transact(fn: (d: Draft) => void) {
    const nested = this.inTransaction;
    this.begin();
    try {
      this.update(fn);
    } catch (e) {
      // A failed update leaves the document untouched; don't leave a dangling transaction either.
      if (!nested) this.cancel();
      throw e;
    }
    if (!nested) this.commit();
  }

  undo() {
    if (this.base) this.commit();
    const c = this.undoStack.pop();
    if (!c) return;
    this.apply(c.before, c.orderBefore, c.titleBefore);
    this.redoStack.push(c);
  }

  redo() {
    if (this.base) this.commit();
    const c = this.redoStack.pop();
    if (!c) return;
    this.apply(c.after, c.orderAfter, c.titleAfter);
    this.undoStack.push(c);
  }

  /** Replaces the whole document (load/import) and clears history. */
  reset(doc: Doc) {
    this._doc = doc;
    this.base = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** Changes settings without recording history (view preferences, not content). */
  setSettings(fields: Partial<Doc["settings"]>) {
    this._doc = { ...this._doc, settings: { ...this._doc.settings, ...fields } };
    this.emit();
  }

  private apply(values: Record<string, BoardElement | null>, order: readonly string[], title: string) {
    const elements = { ...this._doc.elements };
    for (const [id, el] of Object.entries(values)) {
      if (el) elements[id] = el;
      else delete elements[id];
    }
    this._doc = { ...this._doc, elements, order, title };
    this.emit();
  }
}

export function diff(a: Doc, b: Doc): Change | null {
  const before: Record<string, BoardElement | null> = {};
  const after: Record<string, BoardElement | null> = {};
  let changed = false;
  if (a.elements !== b.elements) {
    for (const id in a.elements) {
      if (a.elements[id] !== b.elements[id]) {
        before[id] = a.elements[id];
        after[id] = b.elements[id] ?? null;
        changed = true;
      }
    }
    for (const id in b.elements) {
      if (!(id in a.elements)) {
        before[id] = null;
        after[id] = b.elements[id];
        changed = true;
      }
    }
  }
  const orderChanged = a.order !== b.order && (a.order.length !== b.order.length || a.order.some((id, i) => b.order[i] !== id));
  if (!changed && !orderChanged && a.title === b.title) return null;
  return { before, after, orderBefore: a.order, orderAfter: b.order, titleBefore: a.title, titleAfter: b.title };
}
