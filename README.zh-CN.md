# DSH Browser Connector（中文说明）

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 代理控制你**日常使用的 Chrome**——登录态、Cookie、已装扩展全部保留。

形态：DSH 原生插件（MCP 工具）+ Chrome 扩展桥接。**零第三方依赖**：手写 MCP server、纯 Node.js（用 DSH 自带的那个）、Chrome 原生 API。全链路只走 `127.0.0.1`，无云端、无遥测。

> 社区项目，与 DeepSeek 官方无关。

[English README](README.md)

## 代理获得的能力

安装后，每个 DSH 会话的工具箱里原生出现 `mcp__browser__*`：

| 工具 | 功能 |
|---|---|
| `browser_status` | 桥接/扩展连接诊断 |
| `list_tabs` | 列出所有窗口的标签页（id、标题、URL、激活态） |
| `navigate` | 打开 URL（当前页或新开），等待加载完成 |
| `extract_page` | 提取页面或 CSS 选中元素的可见文本 |
| `eval_js` | 页面内执行 JS（async 包裹，`return` JSON 值；走 CDP，不受页面 CSP 限制） |
| `click` | 按选择器 / 可见文本 / 视口坐标点击 |
| `type_text` | 聚焦输入框并键入（触发正规 input 事件，兼容 React 受控组件） |
| `scroll_page` | 按像素滚动 |
| `screenshot` | CDP 截 PNG（后台标签页也可），落盘并以 MCP 图片返回 |
| `close_tab` | 关闭标签页 |

扩展用的是 Chrome `debugger` 权限，**不需要带 `--remote-debugging-port` 重启 Chrome**，也不弹系统自动化授权。

## 架构

```
DSH 代理（mcp__browser__* 工具）
  │ stdio — MCP（JSON-RPC，换行分隔）
mcp-server/server.js            由 DSH 经 @deepseek-ai/dsh-mcp-client 拉起
  │ TCP 127.0.0.1 — NDJSON，随机 token 鉴权
  │ （端口发布于 state/relay-port.json，0600）
bridge/host.js                  由 Chrome 经 Native Messaging 拉起（host.sh 负责找 node）
  │ stdio — Native Messaging 帧
chrome-extension/（MV3）         安装时生成独立密钥 → 扩展 ID 稳定且属于你
  │ chrome.debugger(CDP) · chrome.scripting · chrome.tabs
你的标签页
```

设计要点：

- **Native Messaging 作主通道**：长连接 port 让 MV3 service worker 不掉线（`chrome.alarms` 兜底唤醒），同时解决服务发现——Chrome 拉起的桥进程读 `state/relay-port.json` 找到 MCP server。
- **每安装一份生成独立扩展身份**：`install.sh` 本地生成 RSA 密钥对并注入安装副本的 manifest，扩展 ID 跨重载稳定、但不与任何其他人共享；私钥不出你的机器（也不进仓库）。
- MCP server 容忍被拉起两次（DSH 的 stdio 协商会先起探测进程）：端口文件原子写入、按 pid 清理。

## 环境要求

- **macOS**（v1 仅在 macOS 验证；Linux/Windows 欢迎贡献——只有 Native Messaging 路径和 install.sh 与系统相关）
- **Google Chrome**（或其他 Chromium 系浏览器，手动指定其 NativeMessagingHosts 目录亦可）
- **DeepSeek Harness** 桌面版，且 profile 里带有 `@deepseek-ai/dsh-mcp-client`（默认 bundle 即有）
- Node.js ≥ 18 —— 通常 DSH 自带的就够，安装脚本会自动探测

## 安装

```bash
git clone https://github.com/13283161018-dotcom/dsh-browser-connector.git
cd dsh-browser-connector
./install.sh
```

然后两步手动操作：

1. `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** →
   选择 `~/.dsh/dsh-browser-connector/chrome-extension`
2. 重启 DeepSeek Harness。

新会话里让代理调用 `mcp__browser__browser_status` 验证；扩展工具栏弹窗也能看连接状态（绿色 = 全链路就绪）。

卸载：`./install.sh --uninstall`（扩展本体需你在 chrome://extensions 手动移除）。
多 profile：`./install.sh --profile ~/.dsh/profiles/<名字>`。

## 排障

| 现象 | 处理 |
|---|---|
| 弹窗黄色"等待 DSH" | DSH 没开，或补丁未生效——重启 DSH；确认 cordis.patch.yml 里有 `browser-connector-mcp` 段 |
| 弹窗灰色"未连接"反复重试 | Native host 未注册——重跑 `install.sh`；在 chrome://extensions 看该扩展的 Service Worker 控制台 |
| 工具报"浏览器桥未连接" | Chrome 没开或扩展没加载 |
| 工具报"被其他调试器占用" | 该标签页开着 DevTools，或其他自动化扩展（如 QwenWork 连接器）正在调试它——二选一 |
| 标签页顶部"正在调试此浏览器" | chrome.debugger 正常提示条，闲置 60 秒自动 detach 后消失 |
| chrome:// 内部页操作失败 | 浏览器安全模型禁止脚本化内部页面，属预期 |
| 手动调试 | `DSH_BROWSER_DEBUG=1 node mcp-server/server.js`，然后 `curl 127.0.0.1:<调试端口>/status`、`POST /call` |

## 隐私与安全

- 全链路仅回环地址；relay 每次启动生成随机 token；端口文件 0600 权限。
- 无遥测、无外部端点、无 npm/pip 依赖，代码量小到可以读完。
- 请注意：连接期间 DSH 代理能读到你已登录网站的页面内容。只在信任的任务里用；不用时移除扩展即可。
- 扩展申请了 `debugger`、`tabs`、`scripting`、`<all_urls>` 等宽权限——这正是工具本身的功能所需，欢迎审计源码。

## 开发

```bash
node tools/test-plumbing.js   # MCP+桥 全管线自测，无需 Chrome
node --check mcp-server/server.js bridge/host.js chrome-extension/background.js
```

目录即模块：`mcp-server/`（MCP+relay）、`bridge/`（Native Messaging host）、`chrome-extension/`（MV3 扩展）、`tools/`（测试）。改完重跑 `install.sh`（幂等）、在 chrome://extensions 点扩展卡片的刷新、重启 DSH。

## 路线图

- [ ] Linux / Windows 安装路径
- [ ] 其他 Chromium 系浏览器（Edge/Brave/Arc 的 NativeMessagingHosts 目录）
- [ ] 无障碍树提取、页面操作高亮（content scripts）
- [ ] 打包成标准 DSH bundle（`plugin_manager install_bundle`）
- [ ] 上架 Chrome Web Store（免开发者模式）

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
