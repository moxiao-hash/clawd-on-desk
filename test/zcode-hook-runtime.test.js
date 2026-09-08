const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatPermissionDecisionOutput } = require('../hooks/zcode-hook');

test('ZCode hook executable resolves real process ancestry and posts a state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-runtime-'));
  try {
    const output = path.join(dir, 'state.json');
    const preload = path.join(dir, 'preload.cjs');
    const config = require.resolve('../hooks/server-config');
    fs.writeFileSync(preload, `const config = require(${JSON.stringify(config)}); config.postStateToRunningServer = (body, opts, cb) => { require('fs').writeFileSync(${JSON.stringify(output)}, body); cb(true); };`);
    const env = { ...process.env }; delete env.CLAWD_REMOTE;
    const result = spawnSync(process.execPath, ['--require', preload, require.resolve('../hooks/zcode-hook'), 'UserPromptSubmit'], {
      input: JSON.stringify({ sessionId: 'runtime-test', cwd: dir }), encoding: 'utf8', env, timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(body.session_id, 'runtime-test');
    assert.equal(body.state, 'thinking');
    assert.equal(body.agent_id, 'zcode');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empty bubble decision must defer to ZCode, not authorize a tool', () => {
  assert.equal(formatPermissionDecisionOutput('{}').output, '{}');
});

test('PreToolUse answers use the PreToolUse output schema', () => {
  const updatedInput = { questions: [{ question: 'Tea?' }], answers: { 'Tea?': 'Yes' } };
  const result = formatPermissionDecisionOutput(JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow', updatedInput } } }), 'PreToolUse');
  assert.deepEqual(JSON.parse(result.output), { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput,
  } });
});

test('ZCode capability flags advertise only supported lifecycle events', () => {
  const agent = require('../agents/zcode');
  assert.equal(agent.capabilities.sessionEnd, false);
  assert.equal(agent.capabilities.subagent, false);
  assert.equal(agent.capabilities.notificationHook, false);
});

test('PreToolUse denial stays a denial and unknown responses defer', () => {
  const result = formatPermissionDecisionOutput(JSON.stringify({ decision: { behavior: 'deny', message: 'No' } }), 'PreToolUse');
  assert.deepEqual(JSON.parse(result.output), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No' } });
  for (const raw of ['', 'invalid', '{}', '{"decision":{"behavior":"ask"}}', 'null']) {
    assert.equal(formatPermissionDecisionOutput(raw, 'PreToolUse').output, '{}');
  }
});

test('camelCase ZCode tool call fields retain question identity', () => {
  const { buildPermissionBody } = require('../hooks/zcode-hook');
  const body = buildPermissionBody({ sessionId: 's', toolName: 'AskUserQuestion', toolInput: { questions: [] }, toolCallId: 'call-1' });
  assert.equal(body.tool_use_id, 'call-1');
});
