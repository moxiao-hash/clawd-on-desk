"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const mavisAgent = require("../agents/mavis");
const { getAllAgents, getAgent } = require("../agents/registry");
const { buildStateBody, buildPermissionBody, formatPermissionDecisionOutput } = require("../hooks/mavis-hook");
const { installMavisHooks, uninstallMavisHooks } = require("../hooks/mavis-install");

test("mavis agent configuration is valid and registered", () => {
  assert.equal(mavisAgent.id, "mavis");
  assert.equal(mavisAgent.name, "Mavis (MiniMax Code)");
  assert.equal(mavisAgent.eventSource, "hook");
  assert.equal(mavisAgent.capabilities.httpHook, true);
  assert.equal(mavisAgent.capabilities.permissionApproval, true);
  assert.equal(mavisAgent.capabilities.interactiveBubble, true);
  assert.equal(mavisAgent.capabilities.notificationHook, true);
  assert.equal(mavisAgent.capabilities.sessionEnd, true);
  assert.equal(mavisAgent.capabilities.subagent, true);
  assert.equal(mavisAgent.hookConfig.configFormat, "minimax-plugin-json");
  assert.equal(mavisAgent.pidField, "mavis_pid");

  const registered = getAgent("mavis");
  assert.ok(registered);
  assert.equal(registered.id, "mavis");
  assert.ok(getAllAgents().some((a) => a.id === "mavis"));
});

test("mavis-hook builds state body correctly", () => {
  const payload = {
    session_id: "sess_mavis_123",
    cwd: "/path/to/project",
    tool_name: "bash",
    tool_use_id: "toolu_456",
  };

  const body = buildStateBody("PreToolUse", payload);
  assert.equal(body.agent, "mavis");
  assert.equal(body.agent_id, "mavis");
  assert.equal(body.state, "working");
  assert.equal(body.session_id, "sess_mavis_123");
  assert.equal(body.cwd, "/path/to/project");
  assert.equal(body.tool, "bash");
  assert.equal(body.tool_use_id, "toolu_456");

  const subagentBody = buildStateBody("SubagentStart", payload);
  assert.equal(subagentBody.state, "juggling");

  const endBody = buildStateBody("SessionEnd", payload);
  assert.equal(endBody.state, "sleeping");
});

test("mavis-hook builds permission body correctly", () => {
  const payload = {
    session_id: "sess_mavis_123",
    tool_name: "ask_user",
    tool_input: {
      steps: [{ question: "Do you confirm deployment?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
    tool_use_id: "toolu_789",
  };

  const permBody = buildPermissionBody(payload);
  assert.equal(permBody.agent_id, "mavis");
  assert.equal(permBody.hook_event_name, "PermissionRequest");
  assert.equal(permBody.tool_name, "ask_user");
  assert.equal(permBody.tool_use_id, "toolu_789");
  assert.deepEqual(permBody.tool_input, payload.tool_input);
});

test("mavis-hook formats permission decision output for stdout JSON", () => {
  const allowResponse = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
  const allowResult = formatPermissionDecisionOutput(allowResponse, "PermissionRequest");
  assert.equal(allowResult.exitCode, 0);
  const parsedAllow = JSON.parse(allowResult.output);
  assert.equal(parsedAllow.hookSpecificOutput.decision.behavior, "allow");

  const denyResponse = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "User rejected" },
    },
  });
  const denyResult = formatPermissionDecisionOutput(denyResponse, "PermissionRequest");
  assert.equal(denyResult.exitCode, 2);
  const parsedDeny = JSON.parse(denyResult.output);
  assert.equal(parsedDeny.hookSpecificOutput.decision.behavior, "deny");
  assert.equal(parsedDeny.hookSpecificOutput.decision.message, "User rejected");
});

test("mavis-install generates plugin.json and hooks.json, and uninstalls safely", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-mavis-test-"));
  const pluginDir = path.join(tmpDir, "plugins", "clawd-mavis");

  try {
    const installResult = installMavisHooks({ pluginDir, permissionsEnabled: true });
    assert.equal(installResult.success, true);
    assert.ok(fs.existsSync(path.join(pluginDir, ".minimax-plugin", "plugin.json")));
    assert.ok(fs.existsSync(path.join(pluginDir, "hooks", "hooks.json")));

    const pluginJson = JSON.parse(fs.readFileSync(path.join(pluginDir, ".minimax-plugin", "plugin.json"), "utf8"));
    assert.equal(pluginJson.name, "clawd-mavis");

    const hooksJson = JSON.parse(fs.readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8"));
    assert.ok(Array.isArray(hooksJson.hooks.SessionStart));
    assert.ok(Array.isArray(hooksJson.hooks.PreToolUse));
    assert.ok(Array.isArray(hooksJson.hooks.PermissionRequest));
    assert.ok(Array.isArray(hooksJson.hooks.SubagentStart));
    assert.ok(Array.isArray(hooksJson.hooks.Stop));

    const uninstallResult = uninstallMavisHooks({ pluginDir });
    assert.equal(uninstallResult.success, true);
    assert.equal(fs.existsSync(pluginDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
