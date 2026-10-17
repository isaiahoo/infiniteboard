// Consent page for the hosted connector: an AI app sends the user here to approve access to the
// board stored in this browser.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { boardKey } from "../ai/boardKey";
import { loadDoc } from "../core/persist";
import "../ui/styles.css";
import "./connect.css";

type Info = { clientName: string; redirectHost: string };
type State =
  | { kind: "loading" }
  | { kind: "ask"; info: Info; title: string; count: number }
  | { kind: "working" }
  | { kind: "done"; clientName: string }
  | { kind: "error"; message: string };

const requestId = new URLSearchParams(location.search).get("request");

function Connect() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!requestId) return setState({ kind: "error", message: "This page is opened by your AI app when you connect InfiniteBoard." });
    void (async () => {
      const [res, doc] = await Promise.all([fetch(`/api/oauth/request?id=${encodeURIComponent(requestId)}`), loadDoc()]);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setState({ kind: "error", message: body.error ?? "Something went wrong. Try connecting again." });
      setState({ kind: "ask", info: body as Info, title: doc.title, count: doc.order.length });
    })().catch(() => setState({ kind: "error", message: "Couldn't reach InfiniteBoard. Check your connection and try again." }));
  }, []);

  const decide = async (allow: boolean) => {
    const name = state.kind === "ask" ? state.info.clientName : "";
    setState({ kind: "working" });
    try {
      const res = await fetch("/api/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${boardKey()}` },
        body: JSON.stringify({ id: requestId, allow }),
      });
      const body = await res.json();
      if (!res.ok) return setState({ kind: "error", message: body.error ?? "Something went wrong. Try connecting again." });
      if (allow) {
        // Let the board tab (if open) start listening right away.
        localStorage.setItem("infiniteboard:remote", "on");
        setState({ kind: "done", clientName: name });
      }
      location.assign(body.redirect);
    } catch {
      setState({ kind: "error", message: "Couldn't reach InfiniteBoard. Check your connection and try again." });
    }
  };

  return (
    <main className="connect-card">
      <h1>InfiniteBoard</h1>
      {state.kind === "loading" && <p className="muted">Loading…</p>}
      {state.kind === "working" && <p className="muted">Connecting…</p>}
      {state.kind === "error" && <p className="error">{state.message}</p>}
      {state.kind === "done" && (
        <p>
          <b>{state.clientName}</b> is connected. Returning you to it… Keep your board open in this browser while you work.
        </p>
      )}
      {state.kind === "ask" && (
        <>
          <p className="lead">
            <b>{state.info.clientName}</b> wants to use your board
          </p>
          <div className="board-summary">
            <b>{state.title}</b>
            <span>{state.count ? `${state.count} item${state.count === 1 ? "" : "s"}` : "Empty board"}</span>
          </div>
          <ul>
            <li>It can read, add, change and delete things on this board while the board is open in this browser.</li>
            <li>Every change can be undone, and you can disconnect it at any time from the AI button.</li>
            <li>After approving you'll return to <b>{state.info.redirectHost}</b>.</li>
          </ul>
          {state.count === 0 && (
            <p className="warn">
              This browser has no board content yet. If your board is in a different browser, open this link there
              instead.
            </p>
          )}
          <div className="actions">
            <button onClick={() => void decide(false)}>Cancel</button>
            <button className="primary" autoFocus onClick={() => void decide(true)}>
              Allow access
            </button>
          </div>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Connect />);
