// End-to-end test of saving: reload, closing right after an edit, two tabs on one board, clear and
// restore from version history, multiple boards and the trash. Needs the dev server (uses window.__editor).
// Usage: node scripts/boards-e2e.mjs <cdpPort> <baseUrl> <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [port = "9333", baseArg = "http://127.0.0.1:5173", outDir = "e2e-output"] = process.argv.slice(2);
const BASE = baseArg.replace(/\/+$/, "");
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---------- minimal CDP over the browser endpoint (supports isolated profiles) ----------
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

async function openTab(url, browserContextId) {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => cdp(m, p, sessionId);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  return {
    targetId, send, evaluate,
    waitFor: async (expr, ms = 20000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await evaluate(expr).catch(() => false)) return true;
      return false;
    },
    navigate: (u) => send("Page.navigate", { url: u }),
    close: () => cdp("Target.closeTarget", { targetId }),
  };
}

let failedHard = null;
const count = (tab) => tab.evaluate("window.__editor?.doc.order.length ?? -1");
const ready = (tab) => tab.waitFor("!!window.__editor");
const addNote = (tab, text) => tab.evaluate(`(async () => {
  const { makeSticky } = await import("/src/core/ops.ts");
  const el = { ...makeSticky({ x: Math.random() * 800, y: Math.random() * 400 }), text: ${JSON.stringify(text)} };
  window.__editor.store.transact((d) => d.set(el));
  return el.id;
})()`);
const texts = (tab) => tab.evaluate("Object.values(window.__editor.doc.elements).map((e) => e.text).sort()");
const status = (tab) => tab.evaluate("document.querySelector('.save-status')?.textContent");
const clickText = (tab, sel, label) => tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(label)}))?.click() ?? "missing"`);

try {
  const { browserContextId: ctx } = await cdp("Target.createBrowserContext");
  const a = await openTab(`${BASE}/`, ctx);
  await ready(a);
  const url = await a.evaluate("location.href");
  check("the board gets its own address", /[?&]board=/.test(url), url);

  await addNote(a, "first");
  check("shows Saving… then Saved", (await status(a)) === "Saving…" && (await a.waitFor("document.querySelector('.save-status')?.textContent === 'Saved'", 5000)));
  await a.navigate(url);
  await ready(a);
  check("content survives a reload", (await count(a)) === 1);

  // Close the tab immediately after an edit: the pagehide flush must still save it.
  await addNote(a, "right before closing");
  await a.close();
  const a2 = await openTab(url, ctx);
  await ready(a2);
  check("an edit made just before closing the tab is saved", (await count(a2)) === 2, `${await count(a2)} elements`);

  // Two tabs, same board.
  const b = await openTab(url, ctx);
  await ready(b);
  await addNote(a2, "from tab A");
  check("a change in one tab shows up in the other", await b.waitFor("window.__editor.doc.order.length === 3", 5000));
  await Promise.all([addNote(a2, "A at the same time"), addNote(b, "B at the same time")]);
  await sleep(2500);
  const ta = await texts(a2), tb = await texts(b);
  check("simultaneous edits in two tabs are merged, not overwritten", ta.length === 5 && JSON.stringify(ta) === JSON.stringify(tb), ta.join(" | "));
  await b.close();
  await a2.navigate(url);
  await ready(a2);
  check("and the merged result is what's stored", (await count(a2)) === 5);

  // Clear board: undoable, plus a restore point.
  await a2.evaluate("document.querySelector('[aria-label=Menu]').click()");
  await clickText(a2, ".menu button", "Clear board");
  await a2.waitFor("window.__editor.doc.order.length === 0", 5000);
  check("Clear board can be undone", await a2.evaluate("(window.__editor.store.undo(), window.__editor.doc.order.length)") === 5);
  await a2.evaluate("window.__editor.store.redo()");
  await a2.evaluate("document.querySelector('[aria-label=Menu]').click()");
  await clickText(a2, ".menu button", "Version history");
  await a2.waitFor("!!document.querySelector('.history-list button')", 5000);
  const first = await a2.evaluate("document.querySelector('.history-list button').textContent");
  check("version history has a restore point from before clearing", first.includes("Before clearing") && first.includes("5 items"), first);
  await sleep(500);
  const { data } = await a2.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "boards-history.png"), Buffer.from(data, "base64"));
  await clickText(a2, ".history-side button", "Restore this version");
  check("restoring brings everything back", await a2.waitFor("window.__editor.doc.order.length === 5", 5000));
  check("and the restore itself can be undone", await a2.evaluate("(window.__editor.store.undo(), window.__editor.doc.order.length)") === 0);
  await a2.evaluate("window.__editor.store.redo()");
  await sleep(800);

  // Several boards.
  await a2.evaluate("document.querySelector('[aria-label=Menu]').click()");
  await clickText(a2, ".menu button", "New board");
  await a2.waitFor("!!window.__editor && !location.href.includes(" + JSON.stringify(new URL(url).searchParams.get("board")) + ")", 8000);
  await ready(a2);
  check("New board opens an empty board at a new address", (await count(a2)) === 0);
  await addNote(a2, "second board");
  await a2.evaluate("document.querySelector('[aria-label=Menu]').click()");
  await clickText(a2, ".menu button", "All boards");
  await a2.waitFor("document.querySelectorAll('.board-list li').length === 2", 5000);
  const listed = await a2.evaluate("[...document.querySelectorAll('.board-list li')].map((li) => li.textContent).join(' / ')");
  check("All boards lists both, newest first", listed.includes("Open now") && listed.includes("5 items"), listed);
  const { data: d2 } = await a2.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "boards-list.png"), Buffer.from(d2, "base64"));
  // Delete the other board, then restore it from the trash.
  await a2.evaluate("[...document.querySelectorAll('.board-list li')].find((li) => !li.classList.contains('current')).querySelector('button[title=\"Move to trash\"]').click()");
  await a2.waitFor("!!document.querySelector('.trash')", 5000);
  check("deleting moves a board to Recently deleted", (await a2.evaluate("document.querySelectorAll('.board-list li').length")) === 2 && (await a2.evaluate("document.querySelector('.trash summary').textContent")).includes("(1)"));
  await a2.evaluate("document.querySelector('.trash').open = true");
  await clickText(a2, ".trash button", "Restore");
  check("and it can be restored", await a2.waitFor("!document.querySelector('.trash')", 5000));
  await clickText(a2, ".board-open", "5 items");
  await a2.waitFor("window.__editor?.doc.order.length === 5", 8000);
  check("opening it from the list shows its content", (await count(a2)) === 5);
  await cdp("Target.disposeBrowserContext", { browserContextId: ctx });
} catch (e) {
  failedHard = e;
  check("script completed", false, e instanceof Error ? e.message : String(e));
}

writeFileSync(join(outDir, "boards-results.json"), JSON.stringify(results, null, 2));
ws.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || failedHard ? 1 : 0);
