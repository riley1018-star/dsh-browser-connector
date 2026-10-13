# DSH Browser Connector

Give [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents control of **the Chrome you actually use** — with your logins, cookies, and extensions intact.

A native DSH plugin (MCP tools) + a Chrome extension bridge. Zero third-party dependencies: hand-rolled MCP server, plain Node.js (the one DSH already bundles), and Chrome's own APIs. Everything stays on `127.0.0.1`.

> Community project — not affiliated with or endorsed by DeepSeek.

[中文 README](README.zh-CN.md)

## What the agent gets

After installation, these tools appear natively in every DSH session as `mcp__browser__*`:

| Tool | What it does |
|---|---|
| `browser_status` | Bridge/extension connection diagnostics |
| `list_tabs` | All tabs across windows (id, title, URL, active) |
| `navigate` | Open a URL (active tab or new tab), waits for load |
| `extract_page` | Visible text of the page or of a CSS-selected element |
| `eval_js` | Run JS in the page (async wrapper, `return` a JSON value; bypasses page CSP via CDP) |
| `click` | Click by CSS selector, visible text, or viewport coordinates |
| `type_text` | Focus an input and type (proper input events; works with React-style controlled inputs) |
| `scroll_page` | Scroll by pixels |
| `screenshot` | PNG capture via CDP (works for background tabs), saved to disk and returned as an MCP image |
| `close_tab` | Close a tab |

Because the extension uses Chrome's `debugger` permission, there is **no need to relaunch Chrome with `--remote-debugging-port`** and no OS-level automation permission prompts.

## Architecture

```
DSH agent (mcp__browser__* tools)
  │ stdio — MCP (JSON-RPC, newline-delimited)
mcp-server/server.js            spawned by DSH via @deepseek-ai/dsh-mcp-client
  │ TCP 127.0.0.1 — NDJSON, random-token auth
  │ (port published in state/relay-port.json, mode 0600)
bridge/host.js                  spawned by CHROME via Native Messaging (host.sh finds node)
  │ stdio — Native Messaging frames
chrome-extension/ (MV3)         fixed per-install key → stable extension ID
  │ chrome.debugger (CDP) · chrome.scripting · chrome.tabs
your tabs
```

Design notes:

- **Native Messaging as the primary channel** keeps the MV3 service worker alive (an open native port prevents idle suspension; `chrome.alarms` is the safety net) and solves relay discovery: the Chrome-spawned bridge reads `state/relay-port.json` to find the MCP server.
- **Per-install extension identity**: `install.sh` generates an RSA keypair locally and injects the public key into the installed manifest, so your extension ID is stable across reloads but never shared with anyone else. The private key never leaves your machine (and is not in this repo).
- The MCP server tolerates being spawned twice (DSH's stdio negotiation runs a probe process first): the state file is written atomically and cleaned up by pid.

## Requirements

- **macOS** (v1 — Linux/Windows contributions welcome; only the Native Messaging host paths and `install.sh` are OS-specific)
- **Google Chrome** (or a Chromium browser whose NativeMessagingHosts directory you point the installer at)
- **DeepSeek Harness** desktop with the bundled `@deepseek-ai/dsh-mcp-client` (ships with the default profile bundles)
- Node.js ≥ 18 — usually the one DSH bundles; the installer finds it automatically

## Install

```bash
git clone https://github.com/13283161018-dotcom/dsh-browser-connector.git
cd dsh-browser-connector
./install.sh
```

Then two manual steps:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   `~/.dsh/dsh-browser-connector/chrome-extension`
2. Restart DeepSeek Harness.

Verify in a new DSH session: ask the agent to call `mcp__browser__browser_status`. The extension's toolbar popup also shows live connection status (green = full chain up).

`./install.sh --uninstall` removes everything (you still delete the extension in `chrome://extensions` yourself). Multiple profiles: `./install.sh --profile ~/.dsh/profiles/<name>`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup: "waiting for DSH" (amber) | DSH isn't running, or the patch didn't load — restart DSH; check `cordis.patch.yml` contains the `browser-connector-mcp` block |
| Popup: "not connected" (grey), keeps retrying | Native host not found/registered — re-run `install.sh`; inspect the extension's Service Worker console via `chrome://extensions` |
| Tool error "浏览器桥未连接 / bridge not connected" | Chrome not running or extension not loaded |
| Tool error "occupied by another debugger" | The target tab has DevTools open, or another automation extension (e.g. QwenWork connector) is debugging it — close one of them |
| "…is debugging this browser" infobar | Normal `chrome.debugger` banner; auto-detaches after 60 s idle |
| Scripts fail on `chrome://` pages | Expected — browser security forbids scripting internal pages |
| Manual debugging | `DSH_BROWSER_DEBUG=1 node mcp-server/server.js`, then `curl 127.0.0.1:<debugPort>/status` and `POST /call` |

## Privacy & security

- All traffic is loopback-only (`127.0.0.1`); the relay requires a per-boot random token; the port file is `0600`.
- No telemetry, no external endpoints, no npm/pip packages.
- Be aware: while connected, the DSH agent can read content of pages you are logged into. Use it for tasks you trust; remove the extension when you don't.
- The extension requests broad permissions (`debugger`, `tabs`, `scripting`, `<all_urls>`) because that is the point of the tool — read the source, it is small.

## Development

```bash
node tools/test-plumbing.js   # full MCP+bridge pipeline test, no Chrome needed
node --check mcp-server/server.js bridge/host.js chrome-extension/background.js
```

Source of truth layout: `mcp-server/` (MCP + relay), `bridge/` (Native Messaging host), `chrome-extension/` (MV3), `tools/` (tests). Edit, re-run `install.sh` (idempotent), reload the extension card in `chrome://extensions`, restart DSH.

## Roadmap

- [ ] Linux & Windows install paths
- [ ] Other Chromium browsers (Edge/Brave/Arc NativeMessagingHosts dirs)
- [ ] Accessibility-tree extraction & on-page action highlighting (content scripts)
- [ ] Packaging as a proper DSH bundle (`plugin_manager install_bundle`) once widely available
- [ ] Chrome Web Store listing (would remove the developer-mode step)

## License

MIT — see [LICENSE](LICENSE).
