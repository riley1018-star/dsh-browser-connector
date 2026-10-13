#!/usr/bin/env node
/**
 * DSH Browser Connector — 桥接进程（Native Messaging Host）
 *
 * 由 Chrome 在扩展调用 connectNative 时拉起（不常驻、不需要用户手动启动）：
 *
 *   扩展 background.js  ←stdio(Native Messaging 帧)→  本进程  ←TCP NDJSON→  MCP server(relay)
 *
 * 职责：
 *  1. 读 state/relay-port.json 发现 relay 端口与 token（找不到/连不上则重试约 25s，
 *     期间扩展靠 native port 保活；最终失败会给扩展发 relay_unavailable 事件并退出，
 *     扩展的 alarms+退避会再次拉起本进程）。
 *  2. 双向透传消息（hello/welcome 握手除外），帧格式转换：
 *     Native Messaging = 4 字节小端长度前缀 + JSON；relay = 换行分隔 JSON。
 *
 * 零第三方依赖。日志走 stderr（stdout 是 NM 协议通道，写坏一个字节流就废了）。
 */
"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");

const STATE_DIRS = [process.env.DSH_BROWSER_STATE_DIR, path.join(__dirname, "..", "state")].filter(Boolean);
const BOOT_RETRY_WINDOW_MS = 25000;
const BOOT_RETRY_INTERVAL_MS = 1500;
const CONNECT_TIMEOUT_MS = 4000;

function log(...args) {
	try {
		process.stderr.write("[dsh-bridge] " + args.join(" ") + "\n");
	} catch (e) {}
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 发现 relay
// ---------------------------------------------------------------------------

function readState() {
	for (const dir of STATE_DIRS) {
		const p = path.join(dir, "relay-port.json");
		try {
			if (!fs.existsSync(p)) continue;
			const j = JSON.parse(fs.readFileSync(p, "utf8"));
			if (j && typeof j.port === "number" && typeof j.token === "string") return j;
		} catch (e) {
			log("bad state file:", p, e.message);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Native Messaging 帧（扩展侧）
// ---------------------------------------------------------------------------

function sendToExt(obj) {
	try {
		const json = Buffer.from(JSON.stringify(obj), "utf8");
		const header = Buffer.alloc(4);
		header.writeUInt32LE(json.length, 0);
		process.stdout.write(Buffer.concat([header, json]));
	} catch (e) {
		log("stdout write failed:", e.message);
		shutdown("stdout broken");
	}
}

let sock = null;
let welcomed = false;

function stdinPump() {
	let buf = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 4) {
			const n = buf.readUInt32LE(0);
			if (buf.length < 4 + n) break;
			const body = buf.subarray(4, 4 + n).toString("utf8");
			buf = buf.subarray(4 + n);
			if (!sock || !welcomed || !sock.writable) continue; // 未连上 relay 时丢弃（扩展只发状态事件）
			try {
				sock.write(body.endsWith("\n") ? body : body + "\n");
			} catch (e) {
				log("relay write failed:", e.message);
			}
		}
	});
	process.stdin.on("end", () => shutdown("stdin closed (extension port gone)"));
	process.stdin.on("error", () => shutdown("stdin error"));
}

// ---------------------------------------------------------------------------
// relay 连接
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	log("shutdown:", reason);
	try {
		if (sock) sock.destroy();
	} catch (e) {}
	process.exit(0);
}

/** 尝试连接并握手；welcomed 后进入透传态，连接断开时进程退出（由扩展负责重连）。 */
function attemptConnect(state) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const s = net.connect(state.port, "127.0.0.1");
		s.setNoDelay(true);
		let netBuf = "";
		const failTimer = setTimeout(() => {
			try { s.destroy(); } catch (e) {}
			finish(false);
		}, CONNECT_TIMEOUT_MS);

		s.on("connect", () => {
			s.write(JSON.stringify({ type: "hello", version: 1, token: state.token }) + "\n");
		});
		s.on("data", (chunk) => {
			netBuf += chunk.toString("utf8");
			let idx;
			while ((idx = netBuf.indexOf("\n")) >= 0) {
				const line = netBuf.slice(0, idx);
				netBuf = netBuf.slice(idx + 1);
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch (e) {
					continue;
				}
				if (!welcomed) {
					if (msg.type === "welcome") {
						welcomed = true;
						sock = s;
						clearTimeout(failTimer);
						sendToExt({ type: "event", name: "relay_connected" });
						log("relay connected (port " + state.port + ")");
						finish(true);
					} else {
						clearTimeout(failTimer);
						sendToExt({ type: "event", name: "relay_unavailable", detail: msg.message || "rejected by relay" });
						try { s.destroy(); } catch (e) {}
						finish(false);
					}
					continue;
				}
				// 透传：relay -> 扩展（cmd 及服务器事件）
				sendToExt(msg);
			}
		});
		s.on("error", (e) => {
			log("relay error:", e.message);
			clearTimeout(failTimer);
		});
		s.on("close", () => {
			clearTimeout(failTimer);
			if (welcomed) {
				sendToExt({ type: "event", name: "relay_disconnected" });
				shutdown("relay closed after welcome");
			}
			finish(false);
		});
	});
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function boot() {
	stdinPump();
	const deadline = Date.now() + BOOT_RETRY_WINDOW_MS;
	let attempt = 0;
	while (Date.now() < deadline && !shuttingDown) {
		const state = readState();
		if (state) {
			attempt++;
			log("relay state found (port " + state.port + ", server pid " + state.pid + "), attempt " + attempt);
			const ok = await attemptConnect(state);
			if (ok) return; // 透传态；断开时 shutdown
			log("connect attempt failed, will retry");
		}
		await sleep(BOOT_RETRY_INTERVAL_MS);
	}
	sendToExt({ type: "event", name: "relay_unavailable", detail: "MCP server 未运行（DSH 未启动或插件未注册？）" });
	shutdown("no relay within boot window");
})();
