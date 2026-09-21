<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk</h1>
<p align="center">
  <a href="README.zh-CN.md">中文版</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
</p>
<p align="center">
  <sub>🌏 Don't see your language? <a href="https://github.com/rullerzhou-afk/clawd-on-desk/pulls">Open a PR</a> to add one — Español, Français, Deutsch, etc. all welcome.</sub>
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd on Desk — a pixel desktop pet that reacts to your AI coding agent in real time.">
</p>

> # 本仓库说明
>
> 🔗 **原开源仓库（跳转）：[rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)**
>
> 本仓库是 **[rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)** 的一个 fork（改动分支）。
> **本仓库大部分源码来自上游开源仓库 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)。**
>
> 本仓库相对上游**新增 / 改动**的内容如下（重点突出）：

> ## 🎵 音乐软件适配（音乐响起时跳舞）
> 检测 macOS 上的音乐软件播放音频，桌宠跟着"跳舞"（切换为杂耍 `juggling` 动画）：
> - `src/music-dance.js`：通过 `pmset -g assertions` 监控系统音频，沿进程树匹配配置的音乐软件；播放时切到 `juggling`（起舞）状态，停止后恢复。
> - `src/prefs.js`：`musicDanceEnabled`（开关）+ `musicAppNames`（音乐软件进程名列表，默认 QQ音乐 / 网易云 Music / Spotify）。
> - `src/main.js`：启动音乐跳舞监控；设置里的「音乐舞动」可配置。

> ## 🆕 DeepSeek Harness (`dsh`) agent 集成
> 让 Clawd 实时感知 **DeepSeek Harness** 的工作状态，采用与 Claude Code **完全一致的 hook 机制**：
> - `hooks/clawd-dsh-hook.js`：由 DSH 内置 `dsh-hooks-claude-code` 桥接运行的 command hook，上报 `idle / thinking / working / attention / juggling`。
> - `hooks/dsh-plugin/`：原生插件，补报 `error`，并实现 **审批（Allow / Always / Deny）** 与 **elicitation 回答**（桌宠气泡）。
> - `hooks/dsh-install.js`：安装器，生成 Claude Code 格式 `hooks.json` 并挂载 dsh profile 补丁层（双插件）。
> - 注册与接线：`agents/deepseek-harness.js`、`agents/registry.js`、`src/integration-sync.js`、`src/prefs.js`、`src/state.js`、doctor 描述符、`assets/icons/agents/deepseek-harness.png`。
> - 详见 [docs/guides/deepseek-harness-integration.md](docs/guides/deepseek-harness-integration.md)。
>
> ## 🆕 ZCode (`zcode`) agent 集成
> 让 Clawd 实时感知 **ZCode** 的工作状态与交互链路，深度对齐 Claude Code 与 Codex 机制：
> - `hooks/zcode-hook.js`：响应 7 大核心事件（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`ExitPlanMode`、`AskUserQuestion`、`PermissionRequest`、`Stop`），上报 `idle / thinking / working / attention / notification / error`。
> - **双向交互气泡与决策闭环**：截获敏感工具权限审批（`PermissionRequest`）、单选/多选/打字交互问答（`AskUserQuestion`）及计划模式富文本 Markdown 预览与批准（`ExitPlanMode`），支持直接在桌宠气泡上点击选择/决策并回传。
> - `hooks/zcode-install.js`：安装器，自动配置 `~/.zcode/cli/config.json` 写入标准事件钩子，支持一键安装与安全卸载。
> - 注册与接线：`agents/zcode.js`、`agents/registry.js`、`src/integration-sync.js`、`src/prefs.js`、`src/dashboard-renderer.js`、doctor 描述符、`assets/icons/agents/zcode.png`（从官方应用提取的高清图标）。
> - 详见 [docs/guides/zcode-integration.md](docs/guides/zcode-integration.md)。
>
> ## 🆕 MiniMax Code / Mavis (`mavis`) agent 集成
> 全面适配 **MiniMax Code (Mavis Agent)** 本地插件规范（`local-plugin-v1`）与生命周期交互：
> - `hooks/mavis-hook.js`：基于本地插件规范挂载的事件钩子，上报 `idle / thinking / working / attention / notification / error / sweeping`；对齐 ZCode 生动体验（多步工具调用持续敲击键盘 `working`、轮次完成挥手致意 `attention`）。
> - **双向交互气泡与决策闭环**：截获命令执行与文件写操作等危险审批（`PermissionRequest`）及 `ask_user` 单选/问询交互气泡，支持直接在桌宠气泡中点击决策并实时回传。
> - `hooks/mavis-install.js`：安装器，一键部署至 `~/.minimax/plugins/clawd-mavis/`，自动生成 `plugin.json` 与 `hooks.json`，支持依赖自愈同步与安全卸载。
> - 注册与接线：`agents/mavis.js`、`agents/registry.js`、`src/integration-sync.js`、`src/prefs.js`、`src/dashboard-renderer.js`、doctor 描述符、`assets/icons/agents/mavis.png`（官方透明高清图标）。
> - 详见 [docs/guides/mavis-integration.md](docs/guides/mavis-integration.md)。

> ## 🆕 `allowHeadlessPermissions`（headless 会话权限气泡）
> `src/main.js` + `src/server-route-permission.js` + `src/prefs.js`：允许 headless 会话触发权限气泡（默认关闭），供远程 / 无头场景使用。
