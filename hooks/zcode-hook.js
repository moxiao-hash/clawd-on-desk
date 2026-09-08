#!/usr/bin/env node
// Clawd Desktop Pet — ZCode Hook Script
// Handles state reporting (fire-and-forget to /state)
// and blocking permission / elicitation requests (to /permission).
//
// Usage: node zcode-hook.js <event_name>
// Reads stdin JSON from ZCode.

const crypto = require("crypto");
const {
  postStateToRunningServer,
  postPermissionToRunningServer,
  readHostPrefix,
} = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const AGENT_ID = "zcode";
const PERMISSION_TIMEOUT_MS = 590000;

const EVENT_TO_STATE = {
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
  Notification: "notification",
  Elicitation: "notification",
};

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function normalizeString(value) {
  return typeof value === "string" && value ? value.trim() : null;
}

function extractFirstString(payload, keys) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of keys) {
    const val = normalizeString(payload[key]);
    if (val) return val;
  }
  return null;
}

function buildStateBody(event, payload, resolvePid) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  const sessionId = extractFirstString(payload, ["sessionId", "session_id"]) || "default";
  const body = {
    agent: AGENT_ID,
    agent_id: AGENT_ID,
    event,
    state,
    session_id: sessionId,
  };

  const cwd = extractFirstString(payload, ["cwd", "projectDir", "project_dir"]);
  if (cwd) body.cwd = cwd;

  const toolName = extractFirstString(payload, ["toolName", "tool_name", "tool"]);
  if (toolName) {
    body.tool = toolName;
    body.tool_name = toolName;
  }

  const toolUseId = extractFirstString(payload, ["toolCallId", "toolUseId", "tool_use_id", "toolUseID"]);
  if (toolUseId) body.tool_use_id = toolUseId;

  const sessionTitle = extractFirstString(payload, ["sessionTitle", "session_title", "title"]);
  if (sessionTitle) body.session_title = sessionTitle;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else if (resolvePid) {
    const { stablePid, agentPid, detectedEditor } = resolvePid();
    if (stablePid) body.source_pid = stablePid;
    if (agentPid) body.agent_pid = agentPid;
    if (detectedEditor) body.editor = detectedEditor;
  }

  return body;
}

function buildPermissionBody(payload, resolvePid) {
  const toolName = extractFirstString(payload, ["toolName", "tool_name", "tool"]) || "Unknown";
  const rawToolInput = (payload.toolInput && typeof payload.toolInput === "object")
    ? payload.toolInput
    : ((payload.tool_input && typeof payload.tool_input === "object") ? payload.tool_input : {});
  const sessionId = extractFirstString(payload, ["sessionId", "session_id"]) || "default";

  const body = {
    agent_id: AGENT_ID,
    hook_source: "zcode-hook",
    session_id: sessionId,
    tool_name: toolName,
    tool_input: rawToolInput,
    hook_event_name: "PermissionRequest",
  };

  const cwd = extractFirstString(payload, ["cwd", "projectDir", "project_dir"]);
  if (cwd) body.cwd = cwd;

  const toolUseId = extractFirstString(payload, ["toolCallId", "toolUseId", "tool_use_id", "toolUseID"]);
  if (toolUseId) body.tool_use_id = toolUseId;

  const toolInputFingerprint = buildToolInputFingerprint(rawToolInput);
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else if (resolvePid) {
    const { stablePid, agentPid, detectedEditor } = resolvePid();
    if (stablePid) body.source_pid = stablePid;
    if (agentPid) body.agent_pid = agentPid;
    if (detectedEditor) body.editor = detectedEditor;
  }

  return body;
}

function formatPermissionDecisionOutput(rawBody, event = "PermissionRequest") {
  if (!rawBody || typeof rawBody !== "string") {
    return { exitCode: 0, output: "{}" };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { exitCode: 0, output: "{}" };
  }

  const decision =
    (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.decision) ||
    (parsed && parsed.decision) ||
    parsed;

  if (!decision || typeof decision !== "object") {
    return { exitCode: 0, output: "{}" };
  }

  const behavior = decision.behavior;
  if (behavior !== "allow" && behavior !== "deny") return { exitCode: 0, output: "{}" };

  if (event === "PreToolUse") {
    const output = { hookEventName: event, permissionDecision: behavior };
    if (behavior === "deny") output.permissionDecisionReason = decision.message || "Action rejected in desktop pet bubble";
    if (behavior === "allow" && decision.updatedInput) output.updatedInput = decision.updatedInput;
    return { exitCode: 0, output: JSON.stringify({ hookSpecificOutput: output }) };
  }

  // If user denied the tool in the bubble:
  if (behavior === "deny") {
    const message = decision.message || "Action rejected in desktop pet bubble";
    return {
      exitCode: 2,
      output: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message },
        },
      }),
    };
  }

  // Allow or AskUserQuestion answers:
  const outputDecision = { behavior: "allow" };
  if (decision.updatedInput) {
    outputDecision.updatedInput = decision.updatedInput;
  }

  return {
    exitCode: 0,
    output: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: outputDecision,
      },
    }),
  };
}

function main() {
  const event = process.argv[2] || "";
  const platform = getPlatformConfig();
  const resolvePid = createPidResolver({
    platformConfig: platform,
    agentNames: {
      win: new Set(["zcode.exe", "zcode-cli.exe"]),
      mac: new Set(["zcode", "zcode-cli"]),
      linux: new Set(["zcode", "zcode-cli"]),
    },
  });

  readStdinJson().then((payload) => {
    payload = payload || {};

    const toolName = extractFirstString(payload, ["toolName", "tool_name", "tool"]);
    const requiresPermission = payload.requires_permission || payload.requiresPermission;

    const isPermissionEvent =
      event === "PermissionRequest" ||
      (event === "PreToolUse" && (requiresPermission || toolName === "AskUserQuestion" || toolName === "ExitPlanMode"));

    if (isPermissionEvent) {
      // 1. Send state working/elicitation first so pet reflects current action
      const stateBody = buildStateBody(
        toolName === "AskUserQuestion" ? "Elicitation" : "PreToolUse",
        payload,
        resolvePid
      );
      if (stateBody) {
        postStateToRunningServer(JSON.stringify(stateBody), { timeoutMs: 300 }, () => {});
      }

      // 2. Blocking call to /permission
      const permBody = buildPermissionBody(payload, resolvePid);
      postPermissionToRunningServer(
        JSON.stringify(permBody),
        { timeoutMs: PERMISSION_TIMEOUT_MS },
        (ok, port, responseBody) => {
          if (!ok) {
            // No decision: let ZCode retain its native approval behavior
            process.exit(0);
          }
          const { exitCode, output } = formatPermissionDecisionOutput(responseBody, event);
          if (output && output !== "{}") {
            process.stdout.write(output);
          }
          process.exit(exitCode);
        }
      );
      return;
    }

    // Normal state event: fire-and-forget
    const stateBody = buildStateBody(event, payload, resolvePid);
    if (!stateBody) {
      process.exit(0);
    }

    postStateToRunningServer(
      JSON.stringify(stateBody),
      { timeoutMs: 1000 },
      () => process.exit(0)
    );
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildStateBody,
  buildPermissionBody,
  formatPermissionDecisionOutput,
  EVENT_TO_STATE,
};
