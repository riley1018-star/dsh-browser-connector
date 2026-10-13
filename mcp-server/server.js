#!/usr/bin/env node
/**
 * DSH Browser Connector — MCP server
 *
 * 两个角色合一：
 *  1. MCP server（stdio，NDJSON 帧的 JSON-RPC 2.0）——被 DSH 的
 *     @deepseek-ai/dsh-mcp-client 以 stdio 方式拉起，注册 mcp__browser__* 工具。
 *  2. 本地 relay（TCP 127.0.0.1，NDJSON）——桥接进程（由 Chrome 通过
 *     Native Messaging 拉起）连进来，工具调用经它转发给浏览器扩展执行。
 *
 * 端口与 token 写在 <state>/relay-port.json（0600，按 pid 清理），
 * 服务发现方式参考 QwenWork 连接器的 relay-port.json 设计。
 *
 * 零第三方依赖，node >= 18。日志一律走 stderr（stdout 是 MCP 协议通道）。
 */
"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const VERSION = "1.0.0";
// 本 server 实际实现的协议版本；客户端若请求更新版本（如 2026-07-28），
// 按 MCP 规范回复我们支持的最新版，由 SDK 回退。
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-06-18";

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const STATE_DIR = process.env.DSH_BROWSER_STATE_DIR || path.join(PLUGIN_ROOT, "state");
const STATE_FILE = path.join(STATE_DIR, "relay-port.json");
const SCREENSHOT_DIR = path.join(STATE_DIR, "screenshots");
const DEBUG = process.env.DSH_BROWSER_DEBUG === "1";
const DEFAULT_CMD_TIMEOUT_MS = 60000;

function log(...args) {
	process.stderr.write(
		"[dsh-browser-mcp] " + args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n"
	);
}

// ---------------------------------------------------------------------------
// relay：等待桥接进程连接
// ---------------------------------------------------------------------------

const TOKEN = crypto.randomBytes(16).toString("hex");
let bridge = null; // { sock }
const pending = new Map(); // id -> { resolve, reject, timer }
let reqSeq = 0;

function failAllPending(reason) {
	for (const [, p] of pending) {
		clearTimeout(p.timer);
		p.reject(new Error(reason));
	}
	pending.clear();
}

const relay = net.createServer((sock) => {
	sock.setNoDelay(true);
	let buf = "";
	let authed = false;

	sock.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let idx;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch (e) {
				log("relay: bad json line dropped");
				continue;
			}
			if (!authed) {
				if (msg.type === "hello" && typeof msg.token === "string" && msg.token === TOKEN) {
					authed = true;
					// 最新连接顶替旧连接（扩展重连时旧 socket 可能尚未感知断开）
					if (bridge && bridge.sock !== sock) {
						log("relay: replacing previous bridge connection");
						try { bridge.sock.destroy(); } catch (e) {}
						failAllPending("bridge replaced by new connection");
					}
					bridge = { sock };
					sock.write(JSON.stringify({ type: "welcome", version: 1 }) + "\n");
					log("relay: bridge connected & authed");
				} else {
					sock.write(JSON.stringify({ type: "error", message: "bad token" }) + "\n");
					sock.destroy();
				}
				continue;
			}
			handleBridgeMsg(msg);
		}
	});
	sock.on("error", (e) => log("relay sock error:", e.message));
	sock.on("close", () => {
		if (bridge && bridge.sock === sock) {
			bridge = null;
			log("relay: bridge disconnected");
			failAllPending("bridge disconnected");
		}
	});
});

function handleBridgeMsg(msg) {
	if (msg.type === "res" && msg.id) {
		const p = pending.get(msg.id);
		if (!p) return;
		clearTimeout(p.timer);
		pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.result);
		else p.reject(new Error(String(msg.error || "extension reported an error")));
		return;
	}
	if (msg.type === "event") {
		log("ext event:", msg.name, msg.detail || "");
		return;
	}
	log("relay: unknown msg type:", msg.type);
}

function sendCommand(cmd, params, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (!bridge) {
			reject(new Error("浏览器桥未连接（请确认 Chrome 正在运行、DSH Browser Connector 扩展已加载且已连接）"));
			return;
		}
		const id = "c" + ++reqSeq + "_" + crypto.randomBytes(4).toString("hex");
		const t = Math.min(Math.max(timeoutMs || DEFAULT_CMD_TIMEOUT_MS, 1000), 120000);
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("命令超时（" + t + "ms）: " + cmd));
		}, t);
		pending.set(id, { resolve, reject, timer });
		try {
			bridge.sock.write(JSON.stringify({ type: "cmd", id, cmd, params: params || {}, timeoutMs: t }) + "\n");
		} catch (e) {
			clearTimeout(timer);
			pending.delete(id);
			reject(e);
		}
	});
}

// ---------------------------------------------------------------------------
// 端口发现文件（原子写入；仅当 pid 匹配时清理，容忍 DSH 的探测进程先起后灭）
// ---------------------------------------------------------------------------

function writeStateFile(port) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const data = {
		version: 1,
		port,
		token: TOKEN,
		pid: process.pid,
		serverVersion: VERSION,
		startedAt: new Date().toISOString(),
	};
	const tmp = STATE_FILE + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, STATE_FILE);
}

function clearStateFile() {
	try {
		const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		if (j && j.pid === process.pid) fs.unlinkSync(STATE_FILE);
	} catch (e) {
		/* 不存在或不是我们写的，跳过 */
	}
}

relay.listen(0, "127.0.0.1", () => {
	const port = relay.address().port;
	writeStateFile(port);
	log("relay listening on 127.0.0.1:" + port + " (state: " + STATE_FILE + ")");
});
relay.on("error", (e) => {
	log("relay failed to start:", e.message);
	process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		clearStateFile();
		process.exit(0);
	});
}
process.on("exit", () => clearStateFile());

// ---------------------------------------------------------------------------
// 调试端点（仅 DSH_BROWSER_DEBUG=1 时开启；localhost only，用于重启 DSH 前验收）
// ---------------------------------------------------------------------------

if (DEBUG) {
	const dbg = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/status") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ bridge: !!bridge, pending: pending.size, version: VERSION }));
			return;
		}
		if (req.method === "POST" && req.url === "/call") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", async () => {
				try {
					const { tool, args } = JSON.parse(body || "{}");
					const out = await callTool(tool, args || {});
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify(out));
				} catch (e) {
					res.statusCode = 500;
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ error: e.message || String(e) }));
				}
			});
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	dbg.listen(0, "127.0.0.1", () => log("debug endpoint on http://127.0.0.1:" + dbg.address().port + " (/status, POST /call)"));
}

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------

const TAB_ID_PROP = { type: "integer", description: "目标标签页 id（来自 list_tabs）；缺省为当前活动标签页" };

const TOOLS = [
	{
		name: "browser_status",
		description: "检查 DSH Browser Connector 桥接与扩展的连接状态（诊断用）。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "list_tabs",
		description: "列出用户 Chrome 所有窗口的标签页（id、标题、URL、激活状态）。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "navigate",
		description: "在用户的 Chrome 中打开 URL（默认当前活动标签页，可 newTab 新开），等待加载完成后返回最终 URL 与标题。",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "http(s):// 开头的 URL 或 about:blank" },
				tabId: TAB_ID_PROP,
				newTab: { type: "boolean", description: "true 时新开标签页" },
				timeoutMs: { type: "integer", description: "等待加载完成的超时，默认 20000" },
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
	{
		name: "extract_page",
		description: "提取页面可见文本（innerText；自动忽略 script/style），或提取 CSS 选择器命中的元素文本。chrome:// 内部页不可提取。",
		inputSchema: {
			type: "object",
			properties: {
				tabId: TAB_ID_PROP,
				selector: { type: "string", description: "CSS 选择器；缺省提取整个页面正文" },
				maxChars: { type: "integer", description: "截断长度，默认 50000，上限 200000" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "eval_js",
		description: "在页面里执行 JavaScript（代码包在 async 函数中，用 return 返回 JSON 可序列化的值；走 CDP Runtime.evaluate，不受页面 CSP 限制）。优先使用专用工具，本工具用于兜底。",
		inputSchema: {
			type: "object",
			properties: {
				code: { type: "string", description: "要执行的 JS 代码，支持 await 与 return" },
				tabId: TAB_ID_PROP,
			},
			required: ["code"],
			additionalProperties: false,
		},
	},
	{
		name: "click",
		description: "点击元素：按 CSS 选择器、按可见文本（取最深层近似匹配），或按视口坐标 x/y。",
		inputSchema: {
			type: "object",
			properties: {
				tabId: TAB_ID_PROP,
				selector: { type: "string", description: "CSS 选择器" },
				text: { type: "string", description: "元素可见文本（精确或近似）" },
				x: { type: "number", description: "视口 X 坐标（与 y 一起使用）" },
				y: { type: "number", description: "视口 Y 坐标" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "type_text",
		description: "聚焦 CSS 选择器命中的输入框并键入文本（默认清空原内容；append:true 为追加）。",
		inputSchema: {
			type: "object",
			properties: {
				tabId: TAB_ID_PROP,
				selector: { type: "string", description: "CSS 选择器" },
				text: { type: "string", description: "要键入的文本" },
				append: { type: "boolean", description: "true 时不清空原内容" },
			},
			required: ["selector", "text"],
			additionalProperties: false,
		},
	},
	{
		name: "scroll_page",
		description: "按像素滚动页面窗口（dy 默认 600，可为负；dx 默认 0）。",
		inputSchema: {
			type: "object",
			properties: {
				tabId: TAB_ID_PROP,
				dx: { type: "number" },
				dy: { type: "number" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "screenshot",
		description: "对标签页截 PNG 图（经 CDP，支持后台标签页）；返回图片并保存副本到 state/screenshots/。",
		inputSchema: {
			type: "object",
			properties: { tabId: TAB_ID_PROP },
			additionalProperties: false,
		},
	},
	{
		name: "close_tab",
		description: "关闭指定标签页（缺省关闭当前活动标签页，慎用）。",
		inputSchema: {
			type: "object",
			properties: { tabId: TAB_ID_PROP },
			additionalProperties: false,
		},
	},
];

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

function textResult(text, isError) {
	return { content: [{ type: "text", text: String(text) }], isError: !!isError };
}

async function callTool(name, args) {
	args = args || {};
	switch (name) {
		case "browser_status": {
			let ext;
			try {
				ext = await sendCommand("status", {}, 5000);
			} catch (e) {
				return textResult("桥未连接: " + e.message, true);
			}
			return textResult(JSON.stringify({ bridge: "connected", extension: ext }, null, 2));
		}
		case "list_tabs": {
			const r = await sendCommand("list_tabs", {}, 10000);
			return textResult(JSON.stringify(r, null, 2));
		}
		case "navigate": {
			const r = await sendCommand("navigate", args, (args.timeoutMs || 20000) + 8000);
			return textResult(JSON.stringify(r));
		}
		case "extract_page": {
			const r = await sendCommand("extract_page", args, 25000);
			return textResult(
				"# " + r.title + "\nURL: " + r.url + "\n文本长度: " + r.length + (r.truncated ? "（已截断）" : "") + "\n\n" + r.text
			);
		}
		case "eval_js": {
			const r = await sendCommand("eval_js", args, 35000);
			return textResult(JSON.stringify(r && r.value !== undefined ? r.value : null, null, 2));
		}
		case "click": {
			const r = await sendCommand("click", args, 20000);
			return textResult(JSON.stringify(r));
		}
		case "type_text": {
			const r = await sendCommand("type_text", args, 20000);
			return textResult(JSON.stringify(r));
		}
		case "scroll_page": {
			const r = await sendCommand("scroll_page", args, 10000);
			return textResult(JSON.stringify(r));
		}
		case "screenshot": {
			const r = await sendCommand("screenshot", args, 30000);
			if (!r || !r.base64) throw new Error("扩展未返回图片数据");
			fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
			const file = path.join(SCREENSHOT_DIR, "shot-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png");
			fs.writeFileSync(file, Buffer.from(r.base64, "base64"));
			return {
				content: [
					{ type: "text", text: "截图已保存: " + file },
					{ type: "image", data: r.base64, mimeType: "image/png" },
				],
			};
		}
		case "close_tab": {
			const r = await sendCommand("close_tab", args, 10000);
			return textResult(JSON.stringify(r));
		}
		default: {
			const err = new Error("unknown tool: " + name);
			err.code = -32602;
			throw err;
		}
	}
}

// ---------------------------------------------------------------------------
// MCP stdio（NDJSON 帧）
// ---------------------------------------------------------------------------

function sendJson(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

async function dispatchRequest(msg) {
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params && msg.params.protocolVersion;
			const proto = PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL;
			return {
				protocolVersion: proto,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "dsh-browser-connector", version: VERSION },
				instructions:
					"通过 DSH Browser Connector 扩展控制用户本人的 Chrome（保留登录态）。" +
					"流程建议：browser_status 确认桥接 → list_tabs 找标签页 id → navigate/extract_page/click/type_text/screenshot。" +
					"多数工具缺省操作当前活动标签页。eval_js 的代码运行在 async 函数内，用 return 返回值；有专用工具时优先用专用工具。" +
					"chrome:// 等内部页面无法脚本化。扩展若被 DevTools 或其他调试扩展（如 QwenWork）占用同一标签页，debugger 类操作会报错。",
			};
		}
		case "ping":
			return {};
		case "tools/list":
			return { tools: TOOLS };
		case "tools/call": {
			const { name, arguments: args } = msg.params || {};
			try {
				return await callTool(name, args);
			} catch (e) {
				return textResult("ERROR: " + (e && e.message ? e.message : String(e)), true);
			}
		}
		default: {
			const err = new Error("method not found: " + msg.method);
			err.code = -32601;
			throw err;
		}
	}
}

async function handleMessage(msg) {
	const isRequest = msg.method !== undefined && msg.id !== undefined && msg.id !== null;
	if (isRequest) {
		try {
			const result = await dispatchRequest(msg);
			sendJson({ jsonrpc: "2.0", id: msg.id, result });
		} catch (e) {
			sendJson({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: (e && e.message) || String(e) } });
		}
		return;
	}
	if (msg.method !== undefined) {
		// 通知（notifications/initialized、notifications/cancelled 等）：无需响应
		return;
	}
	log("stdin: unexpected message shape ignored");
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	stdinBuf += chunk;
	let idx;
	while ((idx = stdinBuf.indexOf("\n")) >= 0) {
		const line = stdinBuf.slice(0, idx);
		stdinBuf = stdinBuf.slice(idx + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			log("stdin: bad json line dropped");
			continue;
		}
		handleMessage(msg).catch((e) => log("handler error:", e.message));
	}
});
process.stdin.on("end", () => {
	clearStateFile();
	process.exit(0);
});

log("server boot v" + VERSION + " pid=" + process.pid + " debug=" + DEBUG);
