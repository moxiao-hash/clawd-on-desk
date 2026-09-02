// DeepSeek Harness (dsh) agent configuration
// Perception via the Claude Code hook mechanism: dsh runs a Claude Code-format
// COMMAND hook (hooks/clawd-dsh-hook.js) through its `dsh-hooks-claude-code`
// bridge, so this is exactly how Clawd tracks Claude Code. The command hook
// POSTs /state for the events the bridge supports; a native bridge plugin
// (hooks/dsh-plugin/index.mjs) supplies the events the bridge does not run
// (error / notification / sleeping / sweeping) plus blocking permission bubbles
// (/permission) and elicitation (user-questions) answers.
// The internal PascalCase event vocabulary mirrors Claude Code so state.js
// reuses the existing transition logic.

module.exports = {
  id: "deepseek-harness",
  name: "DeepSeek Harness",
  // DSH runs as a Node process so a bare binary name is unreliable. The
  // process detection pattern in state.js#detectRunningAgentProcesses matches
  // on the command line ("deepseek-harness" / "@deepseek-ai/dsh"), not on a
  // binary basename. Names here only feed the registry's process-name list.
  processNames: {
    win: ["dsh.exe", "node.exe"],
    mac: ["dsh", "node"],
    linux: ["dsh", "node"],
  },
  eventSource: "hook",
  // Clawd-internal event names (PascalCase). The command hook maps the
  // bridge-supported events to these; the native plugin maps the rest.
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    SubagentStart: "juggling",
    SubagentStop: "working",
    PreCompact: "sweeping",
    PostCompact: "attention",
    Notification: "notification",
    // PermissionRequest + elicitation ride the parallel /permission channel
    // (the plugin POSTs there and holds the connection until the bubble
    // answers), not the /state eventMap — mirroring Claude Code.
  },
  capabilities: {
    // The plugin holds a blocking HTTP request to Clawd's /permission for the
    // bubble decision, so this is the same blocking model as Claude Code.
    httpHook: true,
    permissionApproval: true,
    interactiveBubble: true,
    notificationHook: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "dsh-claude-code-hooks-json",
  },
  pidField: "dsh_pid",
};

