import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RemoteLink } from "../ai/remote";
import { CopyBlock, PROMPTS, SERVER_NAME } from "./AiDialog";
import { Icon } from "./icons";

// Shown on an empty board: connects an assistant one step at a time. The sign-in and "try it"
// steps follow the real connection, so the guide moves on by itself when something happens.

type GuideApp = "claude-code" | "claude" | "cursor" | "vscode";
type Step = "app" | "add" | "auth";

const APPS: { id: GuideApp; name: string; sub: string }[] = [
  { id: "claude-code", name: "Claude Code", sub: "Terminal" },
  { id: "claude", name: "Claude", sub: "claude.ai or desktop app" },
  { id: "cursor", name: "Cursor", sub: "Editor" },
  { id: "vscode", name: "VS Code", sub: "Copilot agent mode" },
];
const LABELS = ["Choose your app", "Add InfiniteBoard", "Allow access", "Try it"];

const HIDE_KEY = "infiniteboard:guide";
const STATE_KEY = "infiniteboard:guide-state";
// While you're signing in we look for the new connection every few seconds; otherwise only on tab focus.
const WATCH_MS = 10 * 60 * 1000;
const WATCH_EVERY_MS = 4000;

function readPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readState(): { step: Step; app: GuideApp } {
  try {
    const s = JSON.parse(readPref(STATE_KEY) ?? "{}");
    if (APPS.some((a) => a.id === s.app) && ["app", "add", "auth"].includes(s.step)) return s;
  } catch {
    /* fall through */
  }
  return { step: "app", app: "claude-code" };
}

function AddStep({ app, url, onDone, onSwitch }: { app: GuideApp; url: string; onDone: () => void; onSwitch: (a: GuideApp) => void }) {
  switch (app) {
    case "claude-code":
      return (
        <>
          <p>Paste this into your terminal and press Enter:</p>
          <CopyBlock text={`claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`} label="Copy Claude Code command" />
          <button className="primary guide-next" onClick={onDone}>I've run it</button>
        </>
      );
    case "claude":
      return (
        <>
          <p>In Claude, open <b>Settings → Connectors → Add custom connector</b>. Name it <b>InfiniteBoard</b> and paste this address:</p>
          <CopyBlock text={url} label="Copy connector address" />
          <button className="primary guide-next" onClick={onDone}>I've added it</button>
          <p className="guide-aside">
            Claude says to ask your organization's Owner? On Team and Enterprise plans only Owners can add connectors.{" "}
            <button className="link" onClick={() => onSwitch("claude-code")}>Use Claude Code instead</button>
          </p>
        </>
      );
    case "cursor":
    case "vscode": {
      const href = app === "cursor"
        ? `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${btoa(JSON.stringify({ url }))}`
        : `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "http", url }))}`;
      return (
        <>
          <p>Click to open {app === "cursor" ? "Cursor" : "VS Code"} with InfiniteBoard ready to add, then confirm there.</p>
          <a className="guide-install" href={href} onClick={() => setTimeout(onDone, 600)}>
            Add to {app === "cursor" ? "Cursor" : "VS Code"}
          </a>
          <button className="link guide-skip" onClick={onDone}>Already added it</button>
        </>
      );
    }
  }
}

function authSteps(app: GuideApp): ReactNode[] {
  switch (app) {
    case "claude-code":
      return [
        <>Restart Claude Code: type <code>/exit</code>, then run <code>claude</code> again. New servers only load when a session starts.</>,
        <>Type <code>/mcp</code>, choose <b>{SERVER_NAME}</b>, press Enter and pick <b>Authenticate</b>.</>,
        <>Click <b>Allow access</b> on the InfiniteBoard page that opens.</>,
      ];
    case "claude":
      return [
        <>Click <b>Connect</b> next to InfiniteBoard in Settings → Connectors.</>,
        <>Click <b>Allow access</b> on the InfiniteBoard page that opens.</>,
      ];
    case "cursor":
      return [
        <>In <b>Cursor Settings → MCP</b>, click <b>Connect</b> next to {SERVER_NAME}.</>,
        <>Click <b>Allow access</b> on the InfiniteBoard page that opens.</>,
      ];
    case "vscode":
      return [
        <>Start {SERVER_NAME} from the MCP servers list and sign in when asked.</>,
        <>Click <b>Allow access</b> on the InfiniteBoard page that opens.</>,
      ];
  }
}

export function StartGuide({ remote, onOpenAi }: { remote: RemoteLink; onOpenAi: () => void }) {
  useSyncExternalStore(remote.subscribe, remote.getSnapshot);
  const [hidden, setHidden] = useState(() => readPref(HIDE_KEY) === "off");
  const [{ step: savedStep, app }, setState] = useState(readState);
  const [usedSince] = useState(() => remote.lastUsed ?? 0);
  const url = `${location.origin}/api/mcp`;
  const connected = remote.apps.length > 0;
  const step: Step | "try" = connected ? "try" : savedStep;
  const index = step === "app" ? 0 : step === "add" ? 1 : step === "auth" ? 2 : 3;

  const go = (next: Partial<{ step: Step; app: GuideApp }>) => {
    const s = { step: savedStep, app, ...next };
    setState(s);
    writePref(STATE_KEY, JSON.stringify(s));
  };

  // One look on open (you may already be connected), and another whenever you come back to the tab.
  useEffect(() => {
    if (hidden) return;
    void remote.refreshApps();
    const onFocus = () => void remote.refreshApps();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [remote, hidden]);

  useEffect(() => {
    if (hidden || step !== "auth") return;
    const until = Date.now() + WATCH_MS;
    const timer = setInterval(() => {
      if (Date.now() > until) clearInterval(timer);
      else if (!document.hidden) void remote.refreshApps();
    }, WATCH_EVERY_MS);
    return () => clearInterval(timer);
  }, [remote, hidden, step]);

  if (hidden) return null;

  const dismiss = () => {
    setHidden(true);
    writePref(HIDE_KEY, "off");
  };
  const appName = APPS.find((a) => a.id === app)!.name;
  const names = remote.apps.map((a) => a.clientName);
  const who = names.length === 1 ? names[0] : `${names.length} apps`;
  const listening = remote.status === "ready" || remote.status === "connecting";
  const hasRead = (remote.lastUsed ?? 0) > usedSince;

  return (
    <section className="start-guide" aria-labelledby="guide-title" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="guide-head">
        <h2 id="guide-title"><Icon name="ai" size={18} /> Connect an AI assistant</h2>
        <button onClick={dismiss} aria-label="Hide this guide" title="Hide this guide">✕</button>
      </div>
      <div className="guide-progress" aria-label={`Step ${index + 1} of 4: ${LABELS[index]}`}>
        {LABELS.map((l, i) => <span key={l} className={i < index ? "done" : i === index ? "current" : ""} />)}
      </div>
      <div className="guide-title-row">
        <span className="guide-count">Step {index + 1} of 4</span>
        <h3>{LABELS[index]}</h3>
      </div>

      <div className="guide-step" aria-live="polite">
        {step === "app" && (
          <>
            <div className="guide-choices">
              {APPS.map((a) => (
                <button key={a.id} className={a.id === app ? "guide-choice recent" : "guide-choice"} onClick={() => go({ app: a.id, step: "add" })}>
                  <b>{a.name}</b>
                  <span>{a.sub}</span>
                </button>
              ))}
            </div>
            <button className="link guide-skip" onClick={onOpenAi}>Something else</button>
          </>
        )}

        {step === "add" && <AddStep app={app} url={url} onDone={() => go({ step: "auth" })} onSwitch={(a) => go({ app: a })} />}

        {step === "auth" && (
          <>
            <ol className="guide-list">
              {authSteps(app).map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            <p className="guide-status" role="status"><span className="dot waiting" /><span>Waiting for you to allow access…</span></p>
            <p className="guide-aside">Open that page in this browser, where your board is.</p>
          </>
        )}

        {step === "try" && (
          <>
            {listening ? (
              <p className="guide-status connected" role="status">
                <span className="dot" /><span><b>{who} {names.length === 1 ? "is" : "are"} connected.</b> {hasRead ? "It just read your board." : ""}</span>
              </p>
            ) : (
              <p className="guide-status" role="status">
                <span className="dot" /><span><b>{who} connected</b>, but {remote.status === "replaced" ? "another tab has the board" : "this tab isn't listening"}.</span>
                <button className="primary" onClick={() => remote.start(true)}>Use this tab</button>
              </p>
            )}
            <p>
              {hasRead ? "Now ask it to draw something:" : app === "claude" ? <>In a chat, turn on InfiniteBoard in the tools menu and ask:</> : "Ask it something, for example:"}
            </p>
            <div className="prompts">
              {(hasRead ? [PROMPTS[1], PROMPTS[3]] : PROMPTS.slice(0, 2)).map((p) => <CopyBlock key={p} text={p} label={`Copy prompt: ${p}`} />)}
            </div>
            <p className="guide-aside">Keep this tab open while it works. You can undo anything it does.</p>
          </>
        )}
      </div>

      {(step === "add" || step === "auth") && (
        <div className="guide-nav">
          <button className="link" onClick={() => go({ step: step === "auth" ? "add" : "app" })}>← Back</button>
          <span className="guide-aside">{appName}</span>
        </div>
      )}

      <p className="guide-foot">Or draw yourself: <kbd>N</kbd> note · <kbd>S</kbd> shape · <kbd>T</kbd> text · <kbd>?</kbd> shortcuts</p>
    </section>
  );
}
