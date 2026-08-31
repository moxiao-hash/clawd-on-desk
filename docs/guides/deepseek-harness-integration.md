# DeepSeek Harness (dsh) 集成指南

Clawd 可以把 **DeepSeek Harness (`dsh`)** 当作一个受支持的 agent：当 dsh 在运行时，桌宠会像对 Claude Code / Codex 一样实时反馈它的状态；涉及权限审批时，也能通过桌宠的权限气泡完成 Allow / Deny。

> 支持状态：session 开始（idle）、收到 prompt（thinking）、工具执行（working）、工具失败（error）、turn 结束（attention）、子代理启动（juggling）、子代理结束（working）等。权限审批走 **阻塞式** `/permission`，与 Claude Code 同模型。

## 工作原理

```
dsh 进程 (Cordis host)
  └── hooks/dsh-plugin/index.mjs   (Clawd 自带、零依赖 ESM 插件)
         │ 订阅 dsh 的生命周期/工具/审批事件
         ├── 会话/工具/子代理事件      → POST http://127.0.0.1:23333-23337/state
         └── 权限审批（阻塞）          → POST /permission → 桌宠气泡 → 返回 allow/deny
Clawd 服务 (src/server.js)  →  src/state.js  →  渲染动画
```

DSH 本身不要求任何 hook 脚本格式：DSH 的「原生 hook」就是一个订阅类型化生命周期事件的 Cordis 插件（见 DSH 文档 *interception extension points*）。Clawd 的这个插件直接订阅这些事件并转发到 Clawd 的 HTTP 服务，因此行为上与 Claude Code 一致。

## 安装

### 1. 注册 Clawd 的 DSH 桥接插件

在 Clawd 里执行（等同其它 agent 的集成安装）：

```bash
npm run install:dsh-bridge
# 等价于 node hooks/dsh-install.js
```

该命令会：
- 在 `$DSH_HOME`（默认 `~/.dsh`）下写一个可直接用的 patch 覆盖文件：
  `$DSH_HOME/clawd-on-desk.cordis.yml`
- 尽力把它合入用户 patch 层 `$DSH_HOME/cordis.patch.yml`（幂等，不会覆盖已有 patch）

### 2. 在 dsh 中启用插件

dsh 用 Cordis patch overlay 加载用户插件。启用 Clawd 桥接有两种方式：

**方式 A（推荐，临时/立即生效）：** 用 `--patch` 指向 Clawd 生成的覆盖文件

```bash
dsh web --patch "$DSH_HOME/clawd-on-desk.cordis.yml"
```

**方式 B（持久，随每次启动）：** 依赖第 1 步已经合入的 `$DSH_HOME/cordis.patch.yml`（每次启动自动加载）。可手动确认其中包含类似片段：

```yaml
- insert:
    - id: clawd-on-desk
      name: 'file:///…/hooks/dsh-plugin/index.mjs'
      config:
        events: true
        approval: true
```

> `name` 指向 Clawd 自带的零依赖插件入口（`hooks/dsh-plugin/index.mjs`），dsh 的 loader 用 `import()` 加载它，因此无需把它安装进 `node_modules`。若 Clawd 以 asar 打包运行，`hooks/**` 会被解包到 `app.asar.unpacked/`，`dsh-install.js` 已自动写入解包后的路径。

### 3. 重启 dsh

插件随进程启动加载。由于当前会话 dsh 已运行，需要**重启 dsh** 让插件生效（这也是为什么 dsh 侧改动无法在运行中的会话里即时验证）。

## 配置（插件 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `events` | `true` | 是否转发会话/工具/子代理状态事件。设为 `false` 只保留审批能力 |
| `approval` | `true` | 是否作为审批 answerer，把权限请求转发到 Clawd 气泡。Clawd 不可用时自动 `next()` 交回 dsh 自己的审批 UI |

## 在 Clawd 设置里启用 / 关闭

设置 → Agents → DeepSeek Harness 默认为启用。可关闭 `enabled`（暂停状态与审批）或单独关闭 `Permissions`（只保留状态反馈，不接管审批）。关闭后 Clawd 不会卸载已写入的 dsh patch，只是不再处理对应 agent 的事件。

## 关键文件

| 文件 | 职责 |
|---|---|
| `agents/deepseek-harness.js` | agent 注册表：ID、名称、进程名、事件映射、能力 |
| `hooks/dsh-plugin/` | 零依赖 DSH 原生桥接插件（`index.mjs` + `package.json`） |
| `hooks/dsh-install.js` | 把插件注册进 dsh 的 patch 层 / 生成 `--patch` 覆盖文件 |
| `src/integration-sync.js` | 启动时自动同步该 agent 的集成（`syncDeepSeekHarnessBridge`） |
| `src/prefs.js` | agent 默认启用/权限开关 |

## 已知限制 / 说明

- **实时验证需重启 dsh**：插件在 dsh 进程内加载，改动不会热生效。
- **审批 `callId` 关联**：DSH 的 `approval/request` 若携带 `tool/call` 的 `callId`，Clawd 气泡可把审批挂在对应工具调用上；否则按 `tool_name` 展示。
- **会话结束**：DSH 是常驻会话模型，没有独立的 `SessionEnd` 信号；dsh 进程退出或 Clawd 的 stale-cleanup 会恢复 idle/sleeping，而不是由插件主动触发。
- **进程检测**：DSH 以 Node 进程运行，无法用单一二进制名精确匹配；进程名按命令行特征处理（见 `agents/deepseek-harness.js` 注释）。

## 卸载

- 从 `$DSH_HOME/cordis.patch.yml` 中删除包含 `id: clawd-on-desk` 的 `- insert:` 片段，并删除 `$DSH_HOME/clawd-on-desk.cordis.yml`。
- 在 Clawd 设置里关闭 DeepSeek Harness。
