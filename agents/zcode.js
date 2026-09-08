// ZCode agent configuration
// Hooks via ~/.zcode/cli/config.json (or workspace .zcode/config.json)
// Lifecycle events via stdin JSON to hooks/zcode-hook.js
// Permission approvals and elicitations (AskUserQuestion, ExitPlanMode) via POST /permission

module.exports = {
  id: "zcode",
  name: "ZCode",
  processNames: {
    win: ["zcode.exe", "node.exe"],
    mac: ["zcode", "node"],
    linux: ["zcode", "node"],
  },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    Elicitation: "notification",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    interactiveBubble: true,
    notificationHook: false,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "zcode-hooks-json",
  },
  pidField: "zcode_pid",
};
