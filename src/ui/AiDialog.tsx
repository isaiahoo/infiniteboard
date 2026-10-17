import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_BRIDGE_PORT, type AiBridge } from "../ai/bridge";
import { Icon } from "./icons";

export const MCP_PACKAGE = "infiniteboard-mcp";
const SERVER_NAME = "infiniteboard";

type AppId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "other";

const APPS: { id: AppId; name: string; sub: string }[] = [
  { id: "claude-code", name: "Claude Code", sub: "terminal" },
  { id: "claude-desktop", name: "Claude Desktop", sub: "Mac & Windows app" },
  { id: "cursor", name: "Cursor", sub: "editor" },
  { id: "vscode", name: "VS Code", sub: "Copilot agent mode" },
  { id: "other", name: "Something else", sub: "any MCP app" },
];

const PROMPTS = [
  "Look at my board and summarise what's on it.",
  "Draw a flowchart of a user signing up, with a decision for email verification.",
  "Group the sticky notes by theme into frames and give each frame a title.",
  "Make a retro board: three frames — Went well, To improve, Actions.",
];

/** The command that starts the MCP server, tailored to where this board is running. */
function serverCommand(): { command: string; args: string[] } {
  const args: string[] = [];
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (!local) args.push("--allow-origin", location.origin);
  const port = Number(new URLSearchParams(location.search).get("mcp"));
  if (port && port !== DEFAULT_BRIDGE_PORT) args.push("--port", String(port));
  // Dev server: run the server file from this checkout (works before the npm package is published).
  if (__LOCAL_MCP_SERVER__) return { command: "node", args: [__LOCAL_MCP_SERVER__, ...args] };
  return { command: "npx", args: ["-y", MCP_PACKAGE, ...args] };
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <pre>{text}</pre>
      <button
        className="copy-btn"
        aria-label={label ?? "Copy"}
        onClick={() => {
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

function Steps({ app }: { app: AppId }) {
  const { command, args } = serverCommand();
  const oneLine = [command, ...args].map(shellQuote).join(" ");
  const json = JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2);
  switch (app) {
    case "claude-code":
      return (
        <ol className="steps">
          <li>Run this in your terminal:<CopyBlock text={`claude mcp add ${SERVER_NAME} -- ${oneLine}`} /></li>
          <li>Start <code>claude</code> (or restart it) and ask it to draw on your board.</li>
        </ol>
      );
    case "claude-desktop":
      return (
        <ol className="steps">
          <li>In Claude Desktop open <b>Settings → Developer → Edit Config</b>.</li>
          <li>Paste this into <code>claude_desktop_config.json</code> (merge with any existing <code>mcpServers</code>):<CopyBlock text={json} /></li>
          <li>Quit and reopen Claude Desktop. “{SERVER_NAME}” appears in the tools menu.</li>
        </ol>
      );
    case "cursor":
      return (
        <ol className="steps">
          <li>Open <b>Cursor Settings → MCP → Add new global MCP server</b>.</li>
          <li>Paste this into <code>mcp.json</code> and save:<CopyBlock text={json} /></li>
          <li>Use the agent in chat and ask it to work on your board.</li>
        </ol>
      );
    case "vscode":
      return (
        <ol className="steps">
          <li>Run this in your terminal:<CopyBlock text={`code --add-mcp ${shellQuote(JSON.stringify({ name: SERVER_NAME, command, args }))}`} /></li>
          <li>Open Copilot Chat in <b>Agent</b> mode, check “{SERVER_NAME}” under tools, and ask away.</li>
        </ol>
      );
    default:
      return (
        <ol className="steps">
          <li>Add a <b>stdio</b> MCP server that runs this command:<CopyBlock text={oneLine} /></li>
          <li>Most apps accept this JSON format:<CopyBlock text={json} /></li>
        </ol>
      );
  }
}

export function AiDialog({ bridge, onClose }: { bridge: AiBridge; onClose: () => void }) {
  const status = useSyncExternalStore(bridge.subscribe, () => bridge.status);
  const [app, setApp] = useState<AppId>("claude-code");

  // Opening the dialog is the user's intent to connect.
  useEffect(() => {
    if (bridge.status === "off") bridge.enable();
  }, [bridge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div className="dialog ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-title" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2 id="ai-title"><Icon name="ai" /> AI assistant</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="dialog-body">
          <p className="hero">Connect your AI assistant — and let it draw for you.</p>
          <p className="muted">Claude, Cursor or any MCP app can read this board, add sticky notes, shapes and diagrams, and tidy things up. Every change can be undone with {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Z.</p>

          <div className={`ai-state ${status}`} role="status" aria-live="polite">
            <span className="dot" />
            <div>
              {status === "connected" && <><b>Connected.</b> Your assistant can see and edit this board. Just ask it.</>}
              {status === "connecting" && <><b>Waiting for your assistant…</b> Set it up below once; after that it connects by itself whenever the assistant runs.</>}
              {status === "replaced" && <><b>Connected in another tab.</b> Only one board can be connected at a time.</>}
              {status === "off" && <><b>Off.</b> This board isn’t reachable by any assistant.</>}
            </div>
            {status === "replaced" || status === "off" ? (
              <button className="primary" onClick={() => bridge.enable()}>Use this board</button>
            ) : (
              <button onClick={() => bridge.disable()}>Turn off</button>
            )}
          </div>

          <h3>1 · Pick your app</h3>
          <div className="app-picker" role="tablist">
            {APPS.map((a) => (
              <button key={a.id} role="tab" aria-selected={app === a.id} className={app === a.id ? "app-option active" : "app-option"} onClick={() => setApp(a.id)}>
                <b>{a.name}</b>
                <span>{a.sub}</span>
              </button>
            ))}
          </div>

          <h3>2 · Follow the steps</h3>
          <Steps app={app} />
          <p className="muted small">Needs Node.js 18 or newer. The assistant talks to this tab through your own computer only; nothing is sent to our servers.</p>

          <h3>3 · Try asking</h3>
          <div className="prompts">
            {PROMPTS.map((p) => (
              <CopyBlock key={p} text={p} label={`Copy prompt: ${p}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
