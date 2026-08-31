// DeepSeek Harness (dsh) agent configuration
// Perception via a native DSH plugin (Cordis) that subscribes to harness
// session/tool events and forwards them to Clawd over HTTP:
//   - lifecycle + tool events  → POST /state
//   - blocking permission ask  → POST /permission (bubble → decision)
// The plugin ships under hooks/dsh-plugin/ and is registered into DSH's
// plugin composition; dsh-hooks-(deepseek-harness)?-install.js manages that
// registration. The internal PascalCase event vocabulary mirrors Claude Code
// so state.js reuses the existing transition logic.

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
  eventSource: "plugin-event",
  // Clawd-internal event names (PascalCase). The native plugin translates
  // DSH's session-event vocabulary (turn/start, user/message, tool/call,
  // tool/result, turn/end, ...) into these shared names. Reusing the Claude
  // Code vocabulary lets state.js reuse the existing transition/release logic.
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
    // PermissionRequest rides the parallel /permission channel (the plugin
    // POSTs there and holds the connection until the bubble answers), not
    // the /state eventMap — mirroring Claude Code.
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
  pidField: "dsh_pid",
};
