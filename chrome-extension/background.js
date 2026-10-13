/**
 * DSH Browser Connector — background service worker (MV3)
 *
 * 架构（参考 QwenWork 连接器的设计）：
 *   MCP server(relay) ←TCP→ bridge host.js ←Native Messaging(stdio)→ 本文件 ←chrome.debugger/scripting→ 标签页
 *
 * 保活策略：
 *   - connectNative 的长连接 port 使 SW 保持存活；
 *   - chrome.alarms 每 30s 兜底唤醒（port 断开后 SW 可能被杀，定时器随之消失）；
 *   - 断开后指数退避重连（1s → 30s 封顶），收到任何消息即重置退避。
 */
"use strict";

const HOST_NAME = "com.dsh_browser_bridge";
const EXT_VERSION = "1.0.0";
const DEBUGGER_PROTOCOL = "1.3";
const DEBUGGER_IDLE_DETACH_MS = 60000;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let port = null; // Native Messaging port
let relayConnected = false; // bridge ↔ relay TCP 已建立（由 bridge 的事件告知）
let lastError = "";
let reconnectDelay = 1000;
let reconnectTimer = null;
const attached = new Map(); // tabId -> { idleTimer }

function log(...args) {
	try {
		console.debug("[dsh-browser-ext]", ...args);
	} catch (e) {}
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Native port 生命周期
// ---------------------------------------------------------------------------

function connect() {
	if (port) return;
	try {
		port = chrome.runtime.connectNative(HOST_NAME);
	} catch (e) {
		port = null;
		lastError = "connectNative 失败: " + (e && e.message ? e.message : e);
		scheduleReconnect();
		return;
	}
	port.onMessage.addListener(onHostMessage);
	port.onDisconnect.addListener(() => {
		const err = chrome.runtime.lastError;
		port = null;
		relayConnected = false;
		lastError = (err && err.message) || "host disconnected";
		log("host disconnected:", lastError);
		scheduleReconnect();
	});
	try {
		port.postMessage({ type: "event", name: "ext_ready", version: EXT_VERSION });
	} catch (e) {}
}

function scheduleReconnect() {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function onHostMessage(msg) {
	if (!msg || typeof msg !== "object") return;
	reconnectDelay = 1000; // 有流量即健康，重置退避
	if (msg.type === "cmd") {
		handleCommand(msg).then(
			(result) => sendRes(msg.id, true, result),
			(e) => sendRes(msg.id, false, (e && e.message) || String(e))
		);
	} else if (msg.type === "event") {
		if (msg.name === "relay_connected") {
			relayConnected = true;
			lastError = "";
		} else if (msg.name === "relay_disconnected" || msg.name === "relay_unavailable") {
			relayConnected = false;
			lastError = msg.detail || msg.name;
		}
	}
}

function sendRes(id, ok, value) {
	if (!port) return;
	try {
		if (ok) port.postMessage({ type: "res", id, ok: true, result: value });
		else port.postMessage({ type: "res", id, ok: false, error: String(value).slice(0, 4000) });
	} catch (e) {
		log("sendRes failed:", e.message);
	}
}

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
	if (a.name === "keepalive" && !port) connect();
});
connect();

// ---------------------------------------------------------------------------
// popup 状态查询
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return false;
	if (msg.type === "popup_status") {
		sendResponse({
			portAlive: !!port,
			relayConnected,
			lastError,
			extVersion: EXT_VERSION,
			extId: chrome.runtime.id,
			debuggerTabs: [...attached.keys()],
		});
	} else if (msg.type === "popup_reconnect") {
		try {
			if (port) port.disconnect();
		} catch (e) {}
		port = null;
		relayConnected = false;
		reconnectDelay = 1000;
		connect();
		sendResponse({ ok: true });
	}
	return false;
});

// ---------------------------------------------------------------------------
// 命令路由
// ---------------------------------------------------------------------------

const commands = {
	status: cmdStatus,
	list_tabs: cmdListTabs,
	navigate: cmdNavigate,
	extract_page: cmdExtractPage,
	eval_js: cmdEvalJs,
	click: cmdClick,
	type_text: cmdTypeText,
	scroll_page: cmdScrollPage,
	screenshot: cmdScreenshot,
	close_tab: cmdCloseTab,
};

async function handleCommand(msg) {
	const fn = commands[msg.cmd];
	if (!fn) throw new Error("unknown command: " + msg.cmd);
	return await fn(msg.params || {});
}

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

async function resolveTab(params) {
	if (params.tabId != null) {
		try {
			return await chrome.tabs.get(params.tabId);
		} catch (e) {
			throw new Error("标签页不存在: " + params.tabId);
		}
	}
	const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (!tab) throw new Error("找不到活动标签页");
	return tab;
}

function isScriptableUrl(url) {
	return (
		typeof url === "string" &&
		!/^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source):/i.test(url) &&
		url !== ""
	);
}

function assertScriptable(tab) {
	if (!isScriptableUrl(tab.url)) {
		throw new Error("浏览器内部页面无法脚本化: " + (tab.url || "(unknown)"));
	}
}

// ---------------------------------------------------------------------------
// debugger（CDP）管理：按需附着，闲置 60s 自动 detach
// ---------------------------------------------------------------------------

async function attachDebugger(tabId) {
	if (attached.has(tabId)) {
		const rec = attached.get(tabId);
		if (rec.idleTimer) {
			clearTimeout(rec.idleTimer);
			rec.idleTimer = null;
		}
		return;
	}
	try {
		await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL);
	} catch (e) {
		const m = String((e && e.message) || e);
		if (/already attached/i.test(m)) {
			// SW 重启后丢失记录的自家残留附着：先 detach 再重试一次
			try {
				await chrome.debugger.detach({ tabId });
			} catch (e2) {}
			try {
				await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL);
			} catch (e3) {
				throw new Error(
					"标签页 " + tabId + " 被其他调试器占用（DevTools 打开着，或 QwenWork 等其他自动化扩展正在调试它）。请关闭后重试。"
				);
			}
		} else {
			throw new Error("debugger 附着失败: " + m);
		}
	}
	attached.set(tabId, { idleTimer: null });
}

function scheduleDetach(tabId) {
	const rec = attached.get(tabId);
	if (!rec) return;
	if (rec.idleTimer) clearTimeout(rec.idleTimer);
	rec.idleTimer = setTimeout(() => {
		detachDebugger(tabId);
	}, DEBUGGER_IDLE_DETACH_MS);
}

async function detachDebugger(tabId) {
	const rec = attached.get(tabId);
	if (!rec) return;
	if (rec.idleTimer) clearTimeout(rec.idleTimer);
	attached.delete(tabId);
	try {
		await chrome.debugger.detach({ tabId });
	} catch (e) {}
}

chrome.debugger.onDetach.addListener((source) => {
	const rec = attached.get(source.tabId);
	if (rec && rec.idleTimer) clearTimeout(rec.idleTimer);
	attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
	const rec = attached.get(tabId);
	if (rec && rec.idleTimer) clearTimeout(rec.idleTimer);
	attached.delete(tabId);
});

async function withDebugger(tabId, fn) {
	await attachDebugger(tabId);
	try {
		return await fn();
	} finally {
		scheduleDetach(tabId);
	}
}

async function cdp(tabId, method, params) {
	return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}

/** 在页面上下文执行表达式（CDP），返回 JSON 值 */
async function evalInTab(tabId, expression) {
	return await withDebugger(tabId, async () => {
		const r = await cdp(tabId, "Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (r && r.exceptionDetails) {
			const d = r.exceptionDetails;
			const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || "exception";
			throw new Error("页面 JS 异常: " + String(msg).slice(0, 1500));
		}
		return r && r.result ? r.result.value : null;
	});
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async function cmdStatus() {
	return {
		extVersion: EXT_VERSION,
		relayConnected,
		debuggerAttachedTabs: [...attached.keys()],
		ts: Date.now(),
	};
}

async function cmdListTabs() {
	const tabs = await chrome.tabs.query({});
	return {
		count: tabs.length,
		tabs: tabs.map((t) => ({
			id: t.id,
			windowId: t.windowId,
			active: !!t.active,
			status: t.status || "",
			title: t.title || "",
			url: t.url || "",
		})),
	};
}

async function cmdNavigate(params) {
	const url = String(params.url || "");
	if (!/^(https?:|about:blank)/i.test(url)) throw new Error("url 必须以 http(s):// 开头（或 about:blank）");
	const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 20000, 1000), 60000);
	let tab;
	if (params.newTab) {
		tab = await chrome.tabs.create({ url, active: true });
	} else {
		tab = await resolveTab(params);
		tab = await chrome.tabs.update(tab.id, { url });
	}
	const tabId = tab.id;
	const deadline = Date.now() + timeoutMs;
	let final = tab;
	while (Date.now() < deadline) {
		await sleep(250);
		try {
			final = await chrome.tabs.get(tabId);
		} catch (e) {
			throw new Error("导航过程中标签页被关闭");
		}
		if (final.status === "complete") break;
	}
	await sleep(400); // 等首屏渲染安定
	try {
		final = await chrome.tabs.get(tabId);
	} catch (e) {}
	return { tabId, status: final.status || "", url: final.url || url, title: final.title || "" };
}

async function cmdExtractPage(params) {
	const tab = await resolveTab(params);
	assertScriptable(tab);
	const maxChars = Math.min(Math.max(Number(params.maxChars) || 50000, 100), 200000);
	const selector = params.selector || null;
	const results = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		args: [selector, maxChars],
		func: (sel, max) => {
			try {
				const root = sel ? document.querySelector(sel) : document.body;
				if (!root) return { error: "selector not found: " + sel };
				let text = root.innerText || root.textContent || "";
				text = text
					.replace(/\u00a0/g, " ")
					.replace(/[ \t]+\n/g, "\n")
					.replace(/\n{3,}/g, "\n\n")
					.trim();
				const truncated = text.length > max;
				if (truncated) text = text.slice(0, max);
				return {
					title: document.title,
					url: location.href,
					length: text.length,
					truncated,
					text: text + (truncated ? "\n…[已截断]" : ""),
				};
			} catch (e) {
				return { error: String((e && e.message) || e) };
			}
		},
	});
	const out = results && results[0] && results[0].result;
	if (!out) throw new Error("提取无结果（页面可能禁止脚本注入）");
	if (out.error) throw new Error(out.error);
	return out;
}

async function cmdEvalJs(params) {
	const tab = await resolveTab(params);
	assertScriptable(tab);
	const code = String(params.code || "");
	if (!code.trim()) throw new Error("code 为空");
	return await withDebugger(tab.id, async () => {
		const r = await cdp(tab.id, "Runtime.evaluate", {
			expression: "(async () => { " + code + " })()",
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (r && r.exceptionDetails) {
			const d = r.exceptionDetails;
			const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || "exception";
			throw new Error("JS 异常: " + String(msg).slice(0, 2000));
		}
		const res = r && r.result;
		return { type: res ? res.type : "undefined", value: res && res.value !== undefined ? res.value : null };
	});
}

async function cmdClick(params) {
	const tab = await resolveTab(params);
	assertScriptable(tab);
	// 坐标点击：走 CDP 真实鼠标事件
	if (typeof params.x === "number" && typeof params.y === "number") {
		return await withDebugger(tab.id, async () => {
			for (const type of ["mousePressed", "mouseReleased"]) {
				await cdp(tab.id, "Input.dispatchMouseEvent", {
					type,
					x: params.x,
					y: params.y,
					button: "left",
					clickCount: 1,
				});
			}
			return { clicked: "coordinates", x: params.x, y: params.y };
		});
	}
	const selector = params.selector || null;
	const text = params.text || null;
	if (!selector && !text) throw new Error("click 需要 selector、text 或 x/y 之一");
	const r = await evalInTab(
		tab.id,
		`(function () {
			const sel = ${JSON.stringify(selector)};
			const txt = ${JSON.stringify(text)};
			let el = null;
			if (sel) {
				el = document.querySelector(sel);
			} else if (txt) {
				const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
				let best = null, bestLen = Infinity;
				while (walker.nextNode()) {
					const n = walker.currentNode;
					const t = (n.innerText || "").trim();
					if (!t) continue;
					if (t === txt || (t.includes(txt) && t.length <= txt.length + 40)) {
						if (t.length < bestLen) { best = n; bestLen = t.length; }
					}
				}
				el = best;
			}
			if (!el) return { found: false };
			el.scrollIntoView({ block: "center", inline: "center" });
			const rect = el.getBoundingClientRect();
			const opts = { bubbles: true, cancelable: true, view: window };
			el.dispatchEvent(new PointerEvent("pointerdown", opts));
			el.dispatchEvent(new MouseEvent("mousedown", opts));
			el.dispatchEvent(new PointerEvent("pointerup", opts));
			el.dispatchEvent(new MouseEvent("mouseup", opts));
			el.dispatchEvent(new MouseEvent("click", opts));
			return {
				found: true,
				tag: el.tagName,
				text: (el.innerText || "").slice(0, 80),
				x: Math.round(rect.x + rect.width / 2),
				y: Math.round(rect.y + rect.height / 2),
			};
		})()`
	);
	if (!r || !r.found) throw new Error("未找到元素: " + (selector || JSON.stringify(text)));
	return Object.assign({ clicked: selector ? "selector" : "text" }, r);
}

async function cmdTypeText(params) {
	const tab = await resolveTab(params);
	assertScriptable(tab);
	const selector = String(params.selector || "");
	const text = String(params.text !== undefined && params.text !== null ? params.text : "");
	if (!selector) throw new Error("type_text 需要 selector");
	const append = !!params.append;
	// 聚焦（并选中旧内容以便替换）
	await evalInTab(
		tab.id,
		`(function () {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) throw new Error("element not found: " + ${JSON.stringify(selector)});
			el.scrollIntoView({ block: "center" });
			el.focus();
			if (!${JSON.stringify(append)}) {
				if (typeof el.select === "function") { try { el.select(); } catch (e) {} }
				else if (el.isContentEditable) {
					const range = document.createRange(); range.selectNodeContents(el);
					const s = getSelection(); s.removeAllRanges(); s.addRange(range);
				}
			}
			return true;
		})()`
	);
	// 用 CDP insertText 键入（触发正确的 input 事件，兼容 React 等受控组件）
	return await withDebugger(tab.id, async () => {
		await cdp(tab.id, "Input.insertText", { text });
		return { typed: text.length, selector, append };
	});
}

async function cmdScrollPage(params) {
	const tab = await resolveTab(params);
	assertScriptable(tab);
	const dx = Number(params.dx) || 0;
	const dy = params.dy != null ? Number(params.dy) : 600;
	return await evalInTab(
		tab.id,
		`(function () { window.scrollBy(${dx}, ${dy}); return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), innerHeight: window.innerHeight }; })()`
	);
}

async function cmdScreenshot(params) {
	const tab = await resolveTab(params);
	let base64 = null;
	try {
		base64 = await withDebugger(tab.id, async () => {
			const r = await cdp(tab.id, "Page.captureScreenshot", {
				format: "png",
				captureBeyondViewport: false,
				fromSurface: true,
			});
			return r && r.data;
		});
	} catch (e) {
		// 兜底：可见标签页 API（要求该 tab 处于激活状态）
		try {
			const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
			base64 = String(dataUrl).split(",")[1];
		} catch (e2) {
			throw new Error(
				"截图失败: " + ((e && e.message) || e) + "（兜底 captureVisibleTab 也失败: " + ((e2 && e2.message) || e2) + "）"
			);
		}
	}
	if (!base64) throw new Error("截图无数据");
	return { format: "png", base64 };
}

async function cmdCloseTab(params) {
	const tab = await resolveTab(params);
	await chrome.tabs.remove(tab.id);
	return { closed: tab.id };
}
