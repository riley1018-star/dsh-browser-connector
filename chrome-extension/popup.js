"use strict";

const $ = (id) => document.getElementById(id);

function render(s) {
	if (!s || s.error) {
		$("state").textContent = "无法读取后台状态（SW 可能正在重启，稍后再试）";
		return;
	}
	const dot = $("dot");
	if (s.relayConnected) {
		dot.className = "dot on";
		$("state").textContent = "已连接（DSH ⇄ 桥 ⇄ 扩展 全链路就绪）";
	} else if (s.portAlive) {
		dot.className = "dot half";
		$("state").textContent = "桥进程已拉起，等待 DSH 的 MCP 服务…（DSH 没开？）";
	} else {
		dot.className = "dot";
		$("state").textContent = "未连接（将自动重试）";
	}
	if (s.lastError) {
		$("errRow").style.display = "";
		$("err").textContent = s.lastError;
	} else {
		$("errRow").style.display = "none";
	}
	$("extid").textContent = s.extId || "";
	$("dbgtabs").textContent = (s.debuggerTabs && s.debuggerTabs.length) ? s.debuggerTabs.join(", ") : "无";
}

function refresh() {
	try {
		chrome.runtime.sendMessage({ type: "popup_status" }, (s) => {
			if (chrome.runtime.lastError) render({ error: chrome.runtime.lastError.message });
			else render(s);
		});
	} catch (e) {
		render({ error: String(e) });
	}
}

$("reconnect").addEventListener("click", () => {
	chrome.runtime.sendMessage({ type: "popup_reconnect" }, () => {
		$("state").textContent = "重连中…";
		setTimeout(refresh, 1200);
	});
});

refresh();
setInterval(refresh, 2000);
