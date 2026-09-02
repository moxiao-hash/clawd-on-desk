# DeepSeek Harness (dsh) 集成指南

Clawd 把 **DeepSeek Harness (`dsh`)** 当作一个受支持的 agent，采用与 Claude Code **完全相同的 hook 机制**：dsh 通过它内置的 `dsh-hooks-claude-code` 桥接**运行 Clawd 的 command hook 脚本**，随工作实时上报状态；权限审批与"询问回答"则经 Clawd 气泡完成。

## 工作原理

```
dsh 进程 (Cordis host)
 ├─ dsh-hooks-claude-code 桥接  → 运行 hooks/clawd-dsh-hook.js (command hook)
 │      SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStart/SubagentStop
 │        └─ POST /state  ← 状态上报（Claude Code 方案）
 └─ hooks/dsh-plugin/index.mjs（native 插件，补差）
        ├─ 工具失败               → POST /state (error)
        ├─ approval/request       → POST /permission → 桌宠气泡 → Allow/Always(会话级)/Deny
        └─ user-questions/request → POST /permission (AskUserQuestion) → Clawd elicitation 气泡
                                       （选项 + "Other" 文本输入）→ 回答回传 dsh
Clawd 服务 (src/server.js) → src/state.js → 渲染动画
```

bridge 覆盖的状态事件走 command hook（与 Claude Code 完全一致）；bridge 不跑的（error、审批、询问）由 native 插件补。两者都在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里挂载。

## 安装

### 1. 注册 Clawd 的 dsh 集成

```bash
npm run install:dsh-bridge
# 等价于 node hooks/dsh-install.js
```

该命令会：
- 生成 Claude Code 格式的 `$DSH_HOME/clawd/dsh-hooks.json`（把 7 个 command hook 事件映射到 `hooks/clawd-dsh-hook.js`）。
- 写入可直接 `dsh web --patch` 的 `$DSH_HOME/clawd-on-desk.cordis.yml`。
- 把补丁合并进 profile 补丁层 `$DSH_HOME/profiles/web/cordis.patch.yml` 与全局层 `$DSH_HOME/cordis.patch.yml`，同时挂载两个插件：
  - `@deepseek-ai/dsh-hooks-claude-code`（`configPath` 指向上面的 `hooks.json`）
  - `clawd-on-desk`（原生插件，`file://` 指向 `hooks/dsh-plugin/index.mjs`）

### 2. 重启 dsh

插件与桥接随进程启动加载，需重启 dsh：

```bash
dsh web --patch "$DSH_HOME/clawd-on-desk.cordis.yml"
```

> 若已合入 profile 补丁层，也可直接 `dsh web`。

## 能力矩阵

| 能力 | 路径 | 覆盖 |
|---|---|---|
| 状态上报 | command hook | `idle / thinking / working / attention / juggling` |
| 工具失败 | native 插件 | `error` |
| 权限审批 | native 插件 → `/permission` | `Allow / Always(会话级记住) / Deny` 气泡 |
| 询问回答 | native 插件 → `/permission` (AskUserQuestion) | Clawd elicitation 气泡：选项 + 文本输入回答 |

## 已知限制 / 说明

- **状态事件边界**：dsh 的 `dsh-hooks-claude-code` 桥接只跑 command hook，不跑 `PostToolUseFailure` / `Notification` / `SessionEnd` / `PreCompact` / `PostCompact` / `Elicitation`。所以 `sleeping`(会话结束) / `notification` / `sweeping`(压缩) 这类状态在 dsh 下不触发；`error` 由 native 插件补报。
- **Always 是会话级**：dsh 的 approval 语义没有持久白名单，`Always` = 本次会话内记住同类工具（native 插件维护会话级集合），跨会话需重新 Allow。
- **elicitation 走 Clawd 原生气泡**：Clawd 的 elicitation 气泡原生支持选项 + "Other" 自由文本输入，答案经 `/permission` 以 `updatedInput.answers` 回传，dsh 插件再映射回 `user-questions` 的 `answers`。
- **进程检测**：dsh 是 Node 进程，按命令行特征识别（见 `agents/deepseek-harness.js` 注释）。

## 卸载

- 从 `$DSH_HOME/profiles/web/cordis.patch.yml`（及全局层）删除含 `id: dsh-hooks-claude-code` 与 `id: clawd-on-desk` 的 `- insert:` 片段，删除 `$DSH_HOME/clawd/` 与 `$DSH_HOME/clawd-on-desk.cordis.yml`。
- Clawd 设置里关闭 DeepSeek Harness。
