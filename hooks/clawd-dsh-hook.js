#!/usr/bin/env node
// Clawd Desktop Pet — DeepSeek Harness (dsh) command-hook script
//
// Runs as a Claude Code-format COMMAND hook, invoked by dsh's
// `dsh-hooks-claude-code` bridge at the harness interception points. The bridge
// feeds the same PascalCase event vocabulary + Claude Code-shaped stdin payload
// (session_id / cwd / tool_name / tool_input / tool_use_id / hook_event_name /
// source / prompt), so this is the Claude Code mechanism — the pet reacts to
// dsh exactly like it reacts to Claude Code.
//
// Usage: node clawd-dsh-hook.js <event_name>
// Reads stdin JSON for the payload. Fire-and-forget POST /state.
//
// The bridge covers these events; everything else (error / notification /
// sleeping / sweeping / elicitation) is reported by the dsh native bridge
// plugin (hooks/dsh-plugin/index.mjs) because the dsh bridge does not run them.

const { postStateToRunningServer } = require("./server-config");

const AGENT_ID = "deepseek-harness";

// Events the dsh bridge runs. Mirrors agents/deepseek-harness.js eventMap.
const EVENT_TO_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "attention",
  SubagentStart: "juggling",
  SubagentStop: "working",
};

function normalizeString(value) {
  return typeof value === "string" && value ? value : null;
}

function buildStateBody(event, payload) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;
  const sessionId = normalizeString(payload.session_id) || "default";
  const cwd = normalizeString(payload.cwd) || "";
  const body = { state, session_id: sessionId, event, agent_id: AGENT_ID };
  if (cwd) body.cwd = cwd;
  const toolName = normalizeString(payload.tool_name);
  const toolUseId = normalizeString(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  const sessionTitle = normalizeString(payload.session_title);
  if (sessionTitle) body.session_title = sessionTitle;
  if (process.env.CLAWD_REMOTE) {
    const { readHostPrefix } = require("./server-config");
    body.host = readHostPrefix();
  }
  return body;
}

function main() {
  const event = process.argv[2];
  if (!EVENT_TO_STATE[event]) process.exit(0);

  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  process.stdin.on("end", () => {
    let payload = {};
    if (stdin.trim()) {
      try { payload = JSON.parse(stdin); } catch { payload = {}; }
    }
    const body = buildStateBody(event, payload);
    if (!body) process.exit(0);
    postStateToRunningServer(
      JSON.stringify(body),
      { timeoutMs: 1000 },
      () => process.exit(0)
    );
  });
}

if (require.main === module) main();

module.exports = { buildStateBody, EVENT_TO_STATE };
