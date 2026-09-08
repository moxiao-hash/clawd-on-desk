"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const zcodeAgent = require("../agents/zcode");
const { getAllAgents, getAgent } = require("../agents/registry");
const { buildStateBody, buildPermissionBody, formatPermissionDecisionOutput } = require("../hooks/zcode-hook");
const { installZCodeHooks, uninstallZCodeHooks } = require("../hooks/zcode-install");

test("zcode agent configuration is valid and registered", () => {
  assert.equal(zcodeAgent.id, "zcode");
  assert.equal(zcodeAgent.name, "ZCode");
  assert.equal(zcodeAgent.eventSource, "hook");
  assert.equal(zcodeAgent.capabilities.httpHook, true);
  assert.equal(zcodeAgent.capabilities.permissionApproval, true);
  assert.equal(zcodeAgent.capabilities.interactiveBubble, true);

  const registered = getAgent("zcode");
  assert.ok(registered);
  assert.equal(registered.id, "zcode");
  assert.ok(getAllAgents().some((a) => a.id === "zcode"));
});

test("zcode-hook builds state body correctly", () => {
  const payload = {
    session_id: "sess_123",
    cwd: "/path/to/project",
    tool_name: "Bash",
    tool_use_id: "toolu_456",
  };

  const body = buildStateBody("PreToolUse", payload);
  assert.equal(body.agent, "zcode");
  assert.equal(body.state, "working");
  assert.equal(body.session_id, "sess_123");
  assert.equal(body.cwd, "/path/to/project");
  assert.equal(body.tool, "Bash");
  assert.equal(body.tool_use_id, "toolu_456");
});

test("zcode-hook builds permission body correctly", () => {
  const payload = {
    session_id: "sess_123",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{ question: "Do you want Coffee or Tea?", options: [{ label: "Coffee" }, { label: "Tea" }] }],
    },
    tool_use_id: "toolu_789",
  };

  const permBody = buildPermissionBody(payload);
  assert.equal(permBody.agent_id, "zcode");
  assert.equal(permBody.hook_event_name, "PermissionRequest");
  assert.equal(permBody.tool_name, "AskUserQuestion");
  assert.equal(permBody.tool_use_id, "toolu_789");
  assert.deepEqual(permBody.tool_input, payload.tool_input);
});

test("zcode-hook formats permission decision output for stdout JSON", () => {
  const allowResponse = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
  const allowResult = formatPermissionDecisionOutput(allowResponse);
  assert.equal(allowResult.exitCode, 0);
  const parsedAllow = JSON.parse(allowResult.output);
  assert.equal(parsedAllow.hookSpecificOutput.decision.behavior, "allow");

  const denyResponse = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "User rejected plan" },
    },
  });
  const denyResult = formatPermissionDecisionOutput(denyResponse);
  assert.equal(denyResult.exitCode, 2);
  const parsedDeny = JSON.parse(denyResult.output);
  assert.equal(parsedDeny.hookSpecificOutput.decision.behavior, "deny");
});

test("zcode-install merges and uninstalls hooks safely in config.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-zcode-test-"));
  const configPath = path.join(tmpDir, "config.json");

  try {
    const installResult = installZCodeHooks({ configPath });
    assert.equal(installResult.success, true);
    assert.ok(fs.existsSync(configPath));

    const installedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(installedConfig.hooks.enabled, true);
    assert.ok(Array.isArray(installedConfig.hooks.events.SessionStart));
    assert.ok(Array.isArray(installedConfig.hooks.events.PreToolUse));
    assert.ok(Array.isArray(installedConfig.hooks.events.PermissionRequest));
    assert.ok(Array.isArray(installedConfig.hooks.events.Stop));

    const uninstallResult = uninstallZCodeHooks({ configPath });
    assert.equal(uninstallResult.success, true);
    const uninstalledConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(uninstalledConfig.hooks.events, {});
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
