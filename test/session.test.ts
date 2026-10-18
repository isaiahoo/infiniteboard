import { describe, expect, it } from "vitest";
import { emptyDoc, type Doc } from "../src/core/model";
import { makeSticky } from "../src/core/ops";
import { rebase, Store } from "../src/core/store";

const withNote = (doc: Doc, text: string, x = 0) => {
  const s = new Store(doc);
  const el = { ...makeSticky({ x, y: 0 }), text };
  s.transact((d) => d.set(el));
  return { doc: s.doc, id: el.id };
};

describe("rebase (merging another tab's save with unsaved local edits)", () => {
  it("keeps both sides' new elements", () => {
    const base = emptyDoc();
    const local = withNote(base, "mine");
    const remote = withNote(base, "theirs", 400);
    const merged = rebase(base, local.doc, remote.doc);
    expect(Object.keys(merged.elements).sort()).toEqual([local.id, remote.id].sort());
    expect(merged.order).toHaveLength(2);
  });

  it("local edits win for the elements they touched; remote changes elsewhere survive", () => {
    const a = withNote(emptyDoc(), "A");
    const b = withNote(a.doc, "B", 300);
    const base = b.doc;
    const local = new Store(base);
    local.transact((d) => d.patch(a.id, { text: "A edited here" }));
    const remote = new Store(base);
    remote.transact((d) => {
      d.patch(b.id, { text: "B edited there" });
      d.setTitle("Renamed there");
    });
    const merged = rebase(base, local.doc, remote.doc);
    expect((merged.elements[a.id] as { text: string }).text).toBe("A edited here");
    expect((merged.elements[b.id] as { text: string }).text).toBe("B edited there");
    expect(merged.title).toBe("Renamed there");
  });

  it("local deletions stay deleted, and nothing to merge returns the remote doc itself", () => {
    const a = withNote(emptyDoc(), "A");
    const local = new Store(a.doc);
    local.transact((d) => d.remove(a.id));
    const remote = withNote(a.doc, "new there", 500);
    const merged = rebase(a.doc, local.doc, remote.doc);
    expect(merged.elements[a.id]).toBeUndefined();
    expect(merged.order).toEqual([remote.id]);
    // Same object back means "no local changes", so the tab doesn't save again (no ping-pong between tabs).
    expect(rebase(a.doc, a.doc, remote.doc)).toBe(remote.doc);
  });

  it("undo after an external change never loses elements from the paint order", () => {
    const store = new Store(emptyDoc());
    const mine = { ...makeSticky({ x: 0, y: 0 }), text: "mine" };
    store.transact((d) => d.set(mine));
    const theirs = withNote(store.doc, "theirs", 300);
    store.replaceExternal(theirs.doc);
    store.undo();
    expect(store.doc.elements[mine.id]).toBeUndefined();
    expect(store.doc.order).toEqual([theirs.id]);
  });
});
