import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_BRIDGE_PORT, type AiBridge } from "../ai/bridge";
import type { RemoteLink } from "../ai/remote";
import { Icon } from "./icons";

export const MCP_PACKAGE = "infiniteboard-mcp";
export const SERVER_NAME = "infiniteboard";

type AppId = "claude" | "claude-code" | "cursor" | "vscode" | "other";

const APPS: { id: AppId; name: string; sub: string }[] = [
  { id: "claude", name: "Claude", sub: "claude.ai & desktop app" },
  { id: "claude-code", name: "Claude Code", sub: "terminal" },
  { id: "cursor", name: "Cursor", sub: "editor" },
  { id: "vscode", name: "VS Code", sub: "Copilot agent mode" },
  { id: "other", name: "Something else", sub: "remote MCP apps" },
];

export const PROMPTS = [
  "Look at my InfiniteBoard and summarise what's on it.",
  "Plan a habit-tracking app on my InfiniteBoard: users, key features, architecture and a roadmap.",
  "Draw a flowchart of a user signing up, with a decision for email verification.",
  "Make a mind map of ideas for growing a newsletter.",
];

const isLocalHost = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function CopyBlock({ text, label, onCopy }: { text: string; label?: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <pre>{text}</pre>
      <button
        className="copy-btn"
        aria-label={label ?? "Copy"}
        onClick={() => {
          onCopy?.();
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function RemoteSteps({ app, url }: { app: AppId; url: string }) {
  switch (app) {
    case "claude":
      return (
        <ol className="steps">
          <li>In Claude open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</li>
          <li>Name it <b>InfiniteBoard</b>, paste the address above and click <b>Add</b>.</li>
          <li>Click <b>Connect</b>. In the window that opens, choose <b>Allow access</b>. Open that window in the browser where your board is.</li>
          <li>In a chat, turn on InfiniteBoard in the tools menu and ask away.</li>
          <li className="muted">On a Team or Enterprise plan only an Owner can add connectors (<b>Admin settings → Connectors</b>). Ask them, or use Claude Code.</li>
        </ol>
      );
    case "claude-code":
      return (
        <ol className="steps">
          <li>Run this in your terminal:<CopyBlock text={`claude mcp add --transport http --scope user ${SERVER_NAME} ${url}`} /></li>
          <li>Start a new Claude Code session (it loads new servers only at startup), type <code>/mcp</code>, pick <b>{SERVER_NAME}</b> and choose <b>Authenticate</b>, then allow access in the browser.</li>
        </ol>
      );
    case "cursor":
      return (
        <ol className="steps">
          <li>Open <b>Cursor Settings → MCP → Add new global MCP server</b> and add:<CopyBlock text={JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2)} /></li>
          <li>Click <b>Connect</b> (or “Needs login”) next to {SERVER_NAME} and allow access in the browser.</li>
        </ol>
      );
    case "vscode":
      return (
        <ol className="steps">
          <li>Run this in your terminal:<CopyBlock text={`code --add-mcp ${shellQuote(JSON.stringify({ name: SERVER_NAME, type: "http", url }))}`} /></li>
          <li>Start the server from the MCP list, sign in when asked, and use Copilot Chat in <b>Agent</b> mode.</li>
        </ol>
      );
    default:
      return (
        <p className="muted">
          Add a remote MCP server with the address above. It uses the Streamable HTTP transport and OAuth sign-in (with
          dynamic client registration), which most apps that support remote MCP servers handle automatically.
        </p>
      );
  }
}

/** The command that starts the local MCP server, tailored to where this board is running. */
function localCommand(): { command: string; args: string[] } {
  const args: string[] = [];
  if (!isLocalHost()) args.push("--allow-origin", location.origin);
  const port = Number(new URLSearchParams(location.search).get("mcp"));
  if (port && port !== DEFAULT_BRIDGE_PORT) args.push("--port", String(port));
  if (__LOCAL_MCP_SERVER__) return { command: "node", args: [__LOCAL_MCP_SERVER__, ...args] };
  return { command: "npx", args: ["-y", MCP_PACKAGE, ...args] };
}

function LocalSection({ bridge }: { bridge: AiBridge }) {
  const status = useSyncExternalStore(bridge.subscribe, () => bridge.status);
  const { command, args } = localCommand();
  const oneLine = [command, ...args].map(shellQuote).join(" ");
  const json = JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2);
  useEffect(() => {
    if (bridge.status === "off") bridge.enable();
  }, [bridge]);
  return (
    <div className="local-section">
      <p className="muted">
        Runs a small server on your computer (needs Node.js 18+); your assistant starts it. Works with any MCP app that can
        launch local servers.
      </p>
      <p className={`local-status ${status}`}>
        <span className="dot" />
        {status === "connected" ? "Local server connected" : status === "replaced" ? "Connected in another tab" : "Waiting for the local server…"}
      </p>
      <ol className="steps">
        <li>Claude Code:<CopyBlock text={`claude mcp add ${SERVER_NAME} -- ${oneLine}`} /></li>
        <li>Claude Desktop, Cursor and others: add to the app's MCP config, then restart it:<CopyBlock text={json} /></li>
      </ol>
      <button onClick={() => bridge.disable()}>Turn off local connection</button>
    </div>
  );
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function AiDialog({ bridge, remote, onClose }: { bridge: AiBridge; remote: RemoteLink; onClose: () => void }) {
  useSyncExternalStore(remote.subscribe, remote.getSnapshot);
  const [app, setApp] = useState<AppId>("claude");
  const [showLocal, setShowLocal] = useState(() => bridge.status !== "off");
  const url = `${location.origin}/api/mcp`;
  const { status, apps } = remote;

  // Opening the dialog makes this tab the one assistants talk to, and keeps the app list live.
  useEffect(() => {
    remote.start(true);
    const timer = setInterval(() => void remote.refreshApps(), 5000);
    return () => clearInterval(timer);
  }, [remote]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const connected = apps.length > 0;
  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div className="dialog ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-title" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2 id="ai-title"><Icon name="ai" /> AI assistant</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="dialog-body">
          <p className="hero">Connect your AI assistant — and let it draw for you.</p>
          <p className="muted">
            Claude and other MCP apps can read this board, add sticky notes, shapes and diagrams, and tidy things up. Every
            change can be undone with {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Z.
          </p>

          <div className={`ai-state ${status === "ready" && connected ? "connected" : status}`} role="status" aria-live="polite">
            <span className="dot" />
            <div>
              {status === "ready" && connected && (
                <><b>Ready.</b> {apps.length === 1 ? apps[0].clientName : `${apps.length} apps`} can use this board{remote.lastUsed ? ` · last used ${ago(remote.lastUsed)}` : ""}.</>
              )}
              {status === "ready" && !connected && <><b>Ready to connect.</b> Add InfiniteBoard to your AI app with the steps below.</>}
              {status === "connecting" && <><b>Connecting…</b></>}
              {status === "replaced" && <><b>Open in another tab.</b> Assistants are working with your board in another tab.</>}
              {status === "paused" && <><b>Paused</b> while the tab was in the background.</>}
              {status === "error" && <><b>Can't reach InfiniteBoard.</b> Retrying… check your internet connection.</>}
              {status === "off" && <><b>Off.</b> Assistants can't reach this board.</>}
            </div>
            {status === "replaced" || status === "off" || status === "paused" ? (
              <button className="primary" onClick={() => remote.start(true)}>Use this tab</button>
            ) : (
              <button onClick={() => remote.stop()}>Turn off</button>
            )}
          </div>

          {connected && (
            <ul className="app-list">
              {apps.map((a) => (
                <li key={a.id}>
                  <span><b>{a.clientName}</b> <span className="muted">connected {ago(a.created)}</span></span>
                  <button onClick={() => void remote.disconnect(a.id)}>Disconnect</button>
                </li>
              ))}
            </ul>
          )}

          <h3>1 · Copy the connector address</h3>
          <CopyBlock text={url} label="Copy connector address" />
          {isLocalHost() && (
            <p className="muted small">This is a local development server, which Claude.ai can't reach. Use your deployed site's address.</p>
          )}

          <h3>2 · Add it to your app</h3>
          <div className="app-picker" role="tablist">
            {APPS.map((a) => (
              <button key={a.id} role="tab" aria-selected={app === a.id} className={app === a.id ? "app-option active" : "app-option"} onClick={() => setApp(a.id)}>
                <b>{a.name}</b>
                <span>{a.sub}</span>
              </button>
            ))}
          </div>
          <RemoteSteps app={app} url={url} />
          <p className="muted small">
            No key to copy: your app opens an InfiniteBoard sign-in where you approve access. Your board stays in this
            browser; keep it open while the assistant works.
          </p>

          <h3>3 · Try asking</h3>
          <div className="prompts">
            {PROMPTS.map((p) => (
              <CopyBlock key={p} text={p} label={`Copy prompt: ${p}`} />
            ))}
          </div>

          <details className="local" open={showLocal} onToggle={(e) => setShowLocal((e.target as HTMLDetailsElement).open)}>
            <summary>Run it locally instead</summary>
            {showLocal && <LocalSection bridge={bridge} />}
          </details>
        </div>
      </div>
    </div>
  );
}
