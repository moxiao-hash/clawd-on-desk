const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { formatPermissionDecisionOutput } = require("../hooks/mavis-hook");

test("Mavis hook executable resolves process and posts state on SessionStart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-runtime-"));
  try {
    const output = path.join(dir, "state.json");
    const preload = path.join(dir, "preload.cjs");
    const config = require.resolve("../hooks/server-config");
    fs.writeFileSync(
      preload,
      `const config = require(${JSON.stringify(
        config
      )}); config.postStateToRunningServer = (body, opts, cb) => { require('fs').writeFileSync(${JSON.stringify(
        output
      )}, body); if (typeof cb === 'function') cb(true); };`
    );
    const env = { ...process.env };
    delete env.CLAWD_REMOTE;
    const result = spawnSync(
      process.execPath,
      ["--require", preload, require.resolve("../hooks/mavis-hook"), "SessionStart"],
      {
        input: JSON.stringify({ sessionId: "sess-mavis-live", cwd: dir }),
        encoding: "utf8",
        env,
        timeout: 15000,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(body.session_id, "sess-mavis-live");
    assert.equal(body.state, "idle");
    assert.equal(body.agent_id, "mavis");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Mavis hook executable blocks and formats permission denial correctly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-perm-"));
  try {
    const preload = path.join(dir, "preload.cjs");
    const config = require.resolve("../hooks/server-config");
    fs.writeFileSync(
      preload,
      `const config = require(${JSON.stringify(
        config
      )}); config.postPermissionToRunningServer = (body, opts, cb) => {
        if (typeof cb === 'function') {
          cb(true, 8888, JSON.stringify({
            hookSpecificOutput: {
              decision: { behavior: 'deny', message: 'User denied bash command' }
            }
          }));
        }
      };`
    );
    const env = { ...process.env };
    delete env.CLAWD_REMOTE;
    const result = spawnSync(
      process.execPath,
      ["--require", preload, require.resolve("../hooks/mavis-hook"), "PermissionRequest"],
      {
        input: JSON.stringify({
          sessionId: "sess-mavis-perm",
          toolName: "bash",
          toolInput: { command: "rm -rf /" },
          toolCallId: "call-unsafe-1",
        }),
        encoding: "utf8",
        env,
        timeout: 15000,
      }
    );
    assert.equal(result.status, 2);
    const stdoutJson = JSON.parse(result.stdout);
    assert.equal(
      stdoutJson.hookSpecificOutput.decision.behavior,
      "deny"
    );
    assert.equal(
      stdoutJson.hookSpecificOutput.decision.message,
      "User denied bash command"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty bubble decision defers and outputs empty object", () => {
  assert.equal(formatPermissionDecisionOutput("{}").output, "{}");
  assert.equal(formatPermissionDecisionOutput("").output, "{}");
  assert.equal(formatPermissionDecisionOutput(null).output, "{}");
});

test("Mavis capability flags advertise full lifecycle and subagent support", () => {
  const agent = require("../agents/mavis");
  assert.equal(agent.capabilities.sessionEnd, true);
  assert.equal(agent.capabilities.subagent, true);
  assert.equal(agent.capabilities.notificationHook, true);
});
