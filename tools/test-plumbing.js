#!/usr/bin/env node
/**
 * 管线自测：不需要 Chrome。
 * 同时扮演两个角色：
 *  - DSH 侧：对 MCP server 的 stdio 说 JSON-RPC（initialize/tools/list/tools/call）
 *  - 扩展侧：对 bridge host.js 的 Native Messaging stdio 收发帧，回复罐头结果
 * 验证：握手、token、命令往返、桥断开后的错误路径、state 文件清理。
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state-test");
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
	if (cond) { pass++; console.log("  PASS  " + name + (extra ? "  " + extra : "")); }
	else { fail++; console.log("  FAIL  " + name + (extra ? "  " + extra : "")); }
}

// NDJSON reader（MCP server stdio）
function ndjsonReader(stream, onMsg) {
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (c) => {
		buf += c;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const l = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (l.trim()) { try { onMsg(JSON.parse(l)); } catch (e) {} }
		}
	});
}

// Native Messaging 帧
function nmWrite(stream, obj) {
	const j = Buffer.from(JSON.stringify(obj));
	const h = Buffer.alloc(4);
	h.writeUInt32LE(j.length, 0);
	stream.write(Buffer.concat([h, j]));
}
function nmReader(stream, onMsg) {
	let buf = Buffer.alloc(0);
	stream.on("data", (c) => {
		buf = Buffer.concat([buf, c]);
		while (buf.length >= 4) {
			const n = buf.readUInt32LE(0);
			if (buf.length < 4 + n) break;
			const body = buf.subarray(4, 4 + n).toString("utf8");
			buf = buf.subarray(4 + n);
			try { onMsg(JSON.parse(body)); } catch (e) {}
		}
	});
}

async function main() {
	fs.rmSync(STATE, { recursive: true, force: true });
	const env = Object.assign({}, process.env, { DSH_BROWSER_STATE_DIR: STATE });

	console.log("== 1. 启动 MCP server ==");
	const server = spawn(NODE, [path.join(ROOT, "mcp-server", "server.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
	server.stderr.on("data", (d) => process.stderr.write("  [server] " + d));

	const waiters = [];
	ndjsonReader(server.stdout, (msg) => { const w = waiters.shift(); if (w) w(msg); });
	let idc = 0;
	function rpc(method, params) {
		return new Promise((resolve, reject) => {
			const to = setTimeout(() => reject(new Error("rpc timeout: " + method)), 15000);
			waiters.push((m) => { clearTimeout(to); resolve(m); });
			server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }) + "\n");
		});
	}

	// state 文件
	let state = null;
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try { state = JSON.parse(fs.readFileSync(path.join(STATE, "relay-port.json"), "utf8")); break; } catch (e) {}
	}
	check("state 文件生成", state && state.port && state.token, state ? "port=" + state.port : "");

	// MCP 握手（故意请求一个更新的协议版本，验证回退）
	const init = await rpc("initialize", {
		protocolVersion: "2026-07-28",
		capabilities: {},
		clientInfo: { name: "plumbing-test", version: "0" },
	});
	check("initialize 协议回退", init.result && init.result.protocolVersion === "2025-06-18", init.result && init.result.protocolVersion);
	check("serverInfo", init.result && init.result.serverInfo.name === "dsh-browser-connector");
	check("instructions 非空", init.result && (init.result.instructions || "").length > 20);
	server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

	const list = await rpc("tools/list", {});
	const toolNames = (list.result && list.result.tools || []).map((t) => t.name);
	check("tools/list 共 10 个工具", toolNames.length === 10, toolNames.join(","));
	for (const t of list.result.tools) {
		if (t.inputSchema && t.inputSchema.type !== "object") check("schema 合法: " + t.name, false);
	}

	console.log("== 2. 桥未连接时的错误路径 ==");
	const noBridge = await rpc("tools/call", { name: "browser_status", arguments: {} });
	check("无桥时报错清晰", noBridge.result && noBridge.result.isError === true && /未连接/.test(noBridge.result.content[0].text));

	console.log("== 3. 启动 bridge（模拟 Chrome 拉起）+ 扮演扩展 ==");
	const bridge = spawn(NODE, [path.join(ROOT, "bridge", "host.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
	bridge.stderr.on("data", (d) => process.stderr.write("  [bridge] " + d));
	const extLog = [];
	nmReader(bridge.stdout, (msg) => {
		extLog.push(msg);
		if (msg.type === "cmd") {
			// 罐头扩展：按命令回结果
			if (msg.cmd === "status")
				nmWrite(bridge.stdin, { type: "res", id: msg.id, ok: true, result: { extVersion: "test", relayConnected: true, debuggerAttachedTabs: [], ts: Date.now() } });
			else if (msg.cmd === "list_tabs")
				nmWrite(bridge.stdin, { type: "res", id: msg.id, ok: true, result: { count: 2, tabs: [
					{ id: 1, windowId: 1, active: true, status: "complete", title: "Tab A", url: "https://a.example/" },
					{ id: 2, windowId: 1, active: false, status: "complete", title: "Tab B", url: "https://b.example/" },
				] } });
			else if (msg.cmd === "navigate")
				nmWrite(bridge.stdin, { type: "res", id: msg.id, ok: true, result: { tabId: 1, status: "complete", url: msg.params.url, title: "Nav Test" } });
			else if (msg.cmd === "extract_page")
				nmWrite(bridge.stdin, { type: "res", id: msg.id, ok: true, result: { title: "T", url: "https://a.example/", length: 11, truncated: false, text: "hello world" } });
			else if (msg.cmd === "boom")
				nmWrite(bridge.stdin, { type: "res", id: msg.id, ok: false, error: "扩展侧故意报错" });
			else
				nmWrite(bridge.stdin, { type: "res", id: msg.id, ok: false, error: "unhandled test cmd: " + msg.cmd });
		}
	});
	nmWrite(bridge.stdin, { type: "event", name: "ext_ready", version: "test" });
	await sleep(1200); // 等握手
	check("扩展收到 relay_connected 事件", extLog.some((m) => m.type === "event" && m.name === "relay_connected"));

	console.log("== 4. 工具调用往返 ==");
	const st = await rpc("tools/call", { name: "browser_status", arguments: {} });
	check("browser_status 已连接", st.result && !st.result.isError && /connected/.test(st.result.content[0].text));

	const lt = await rpc("tools/call", { name: "list_tabs", arguments: {} });
	check("list_tabs 返回 2 个假标签", lt.result && /Tab A/.test(lt.result.content[0].text) && /b\.example/.test(lt.result.content[0].text));

	const nv = await rpc("tools/call", { name: "navigate", arguments: { url: "https://example.test/x" } });
	check("navigate 参数透传", nv.result && /example\.test\/x/.test(nv.result.content[0].text));

	const ex = await rpc("tools/call", { name: "extract_page", arguments: {} });
	check("extract_page 文本格式化", ex.result && /hello world/.test(ex.result.content[0].text) && /URL:/.test(ex.result.content[0].text));

	console.log("== 5. 扩展侧报错透传 ==");
	// 直接构造一个会让扩展报错的调用：借用未知命令路径 → 用 click 缺参在真扩展才报；这里用罐头 boom 不可达，
	// 改为验证 isError：让罐头对 screenshot 回 error
	const shot = await rpc("tools/call", { name: "screenshot", arguments: {} });
	check("扩展错误→isError:true", shot.result && shot.result.isError === true && /unhandled test cmd: screenshot/.test(shot.result.content[0].text));

	console.log("== 6. 桥断开后的清理 ==");
	bridge.kill("SIGKILL");
	await sleep(600);
	const dead = await rpc("tools/call", { name: "list_tabs", arguments: {} });
	check("桥断开→清晰报错", dead.result && dead.result.isError === true && /未连接/.test(dead.result.content[0].text));

	console.log("== 7. server 退出清理 state ==");
	server.kill("SIGTERM");
	await sleep(500);
	check("state 文件已删除", !fs.existsSync(path.join(STATE, "relay-port.json")));

	console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
	process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
