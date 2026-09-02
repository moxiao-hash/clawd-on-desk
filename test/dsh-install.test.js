const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerDshBridge,
  resolvePluginFileUrl,
  resolveHookScriptPath,
  resolveDshHome,
  buildPatchBody,
  buildHooksJson,
  writeHooksJson,
  hooksJsonPath,
  mergeIntoPatchLayer,
  layerHasPlugin,
  DEFAULT_PROFILE,
  BRIDGE_PLUGIN_NAME,
} = require("../hooks/dsh-install");

const tempDirs = [];
function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-dsh-${label}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const FAKE_BASE = "/app/clawd/hooks";
const HOOKS = path.join("/app/clawd", "h2.json");
const PLUGIN = "file:///app/clawd/hooks/dsh-plugin/index.mjs";

describe("dsh bridge installer (command hooks + native plugin)", () => {
  it("creates hooks.json + a two-plugin patch and registers into the profile/global layers", () => {
    const home = makeTempDir("home");
    const result = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, true);
    // hooks.json written.
    assert.ok(fs.existsSync(result.hooksPath), "hooks.json missing");
    const hooks = JSON.parse(fs.readFileSync(result.hooksPath, "utf8"));
    assert.ok(hooks.hooks.SessionStart && hooks.hooks.SubagentStop, "hooks.json lacks events");
    // overlay + PROFILE patch layer written with both plugins (default writes profile layer only).
    assert.ok(fs.existsSync(path.join(home, "clawd-on-desk.cordis.yml")));
    const layer = fs.readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
    assert.ok(layer.includes("id: dsh-hooks-claude-code"), `missing bridge plugin:\n${layer}`);
    assert.ok(layer.includes("id: clawd-on-desk"), `missing native plugin:\n${layer}`);
    assert.ok(layer.includes(PLUGIN), `missing plugin file URL:\n${layer}`);
    // default does NOT write the home/global layer (avoids duplicate loader entry id).
    assert.ok(!fs.existsSync(path.join(home, "cordis.patch.yml")), "global layer should not be written by default");
  });

  it("is idempotent across repeated registration", () => {
    const home = makeTempDir("home");
    registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });
    const second = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    assert.strictEqual(second.added, false);
    assert.strictEqual(second.updated, false);
    const layer = fs.readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8");
    const count = layer.split("id: clawd-on-desk").length - 1;
    assert.strictEqual(count, 1, `duplicated plugin id:\n${layer}`);
  });

  it("preserves unrelated user patch content in the profile layer", () => {
    const home = makeTempDir("home");
    const webDir = path.join(home, "profiles", "web");
    fs.mkdirSync(webDir, { recursive: true });
    // Pre-existing PROFILE patch layer with an unrelated insert.
    fs.writeFileSync(
      path.join(webDir, "cordis.patch.yml"),
      "- insert:\n    - id: memory-memorix\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memorix\n",
      "utf8",
    );
    registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    const layer = fs.readFileSync(path.join(webDir, "cordis.patch.yml"), "utf8");
    assert.ok(layer.includes("memory-memorix"), "clobbered existing patch");
    assert.ok(layer.includes("id: clawd-on-desk"), "missing our plugin id");
  });

  it("builds a patch body mounting BOTH the bridge and the native plugin", () => {
    const body = buildPatchBody(HOOKS, PLUGIN);
    assert.ok(/^- insert:/m.test(body), `missing insert slice:\n${body}`);
    assert.ok(body.includes("id: dsh-hooks-claude-code"));
    assert.ok(body.includes(BRIDGE_PLUGIN_NAME));
    assert.ok(body.includes(`configPath: "${HOOKS}"`), `missing configPath:\n${body}`);
    assert.ok(body.includes("id: clawd-on-desk"));
    assert.ok(body.includes(PLUGIN));
    assert.ok(body.includes("approval: true"));
  });

  it("builds a Claude Code hooks.json wiring the bridge-supported events", () => {
    const json = buildHooksJson("/app/clawd/hooks/clawd-dsh-hook.js", "/usr/bin/node");
    const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop"];
    for (const event of events) {
      assert.ok(json.hooks[event], `missing ${event}`);
      const cmd = json.hooks[event][0].hooks[0].command;
      assert.ok(cmd.includes('"/usr/bin/node"'), `bad node: ${cmd}`);
      assert.ok(cmd.includes('"/app/clawd/hooks/clawd-dsh-hook.js"'), `bad script: ${cmd}`);
      assert.ok(cmd.endsWith(` ${event}`), `bad event: ${cmd}`);
    }
  });

  it("writes hooks.json to $DSH_HOME/clawd/dsh-hooks.json", () => {
    const home = makeTempDir("home");
    const hooksPath = writeHooksJson(home, "/app/clawd/hooks/clawd-dsh-hook.js", "/usr/bin/node");
    assert.strictEqual(hooksPath, hooksJsonPath(home));
    assert.ok(fs.existsSync(hooksPath));
    const json = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    assert.ok(json.hooks.PreToolUse);
  });

  it("detects an existing plugin id (either plugin) in a patch layer", () => {
    assert.strictEqual(layerHasPlugin("id: clawd-on-desk"), true);
    assert.strictEqual(layerHasPlugin("id: dsh-hooks-claude-code"), true);
    assert.strictEqual(layerHasPlugin("id: memory-memorix"), false);
    assert.strictEqual(layerHasPlugin(""), false);
  });

  it("merges into an existing list and replaces an empty `[]` profile layer", () => {
    const existing = "- insert:\n    - id: a\n      name: '@x/a'\n";
    const merged = mergeIntoPatchLayer(existing, HOOKS, PLUGIN);
    assert.strictEqual(merged.added, true);
    assert.ok(merged.text.includes("- insert:\n    - id: a"));
    assert.ok(merged.text.includes("id: dsh-hooks-claude-code"));

    const empty = "# comment\n[]\n";
    const replaced = mergeIntoPatchLayer(empty, HOOKS, PLUGIN);
    assert.strictEqual(replaced.added, true);
    assert.ok(!/\[\]/.test(replaced.text), "empty [] left dangling");
  });

    it("defaults the profile layer to `web` and only writes profile (writeGlobal opts in for global)", () => {
      assert.strictEqual(DEFAULT_PROFILE, "web");
      const home = makeTempDir("home");
      const webDir = path.join(home, "profiles", "web");
      fs.mkdirSync(webDir, { recursive: true });
      fs.writeFileSync(path.join(webDir, "cordis.patch.yml"), "# comment\n[]\n", "utf8");
      const result = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });
      assert.strictEqual(result.profile, "web");
      assert.ok(fs.readFileSync(path.join(webDir, "cordis.patch.yml"), "utf8").includes("id: clawd-on-desk"));
      // global layer NOT written by default
      assert.ok(!fs.existsSync(path.join(home, "cordis.patch.yml")), "global not written by default");
      // writeGlobal:true DOES write the global layer
      registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE, writeGlobal: true });
      assert.ok(fs.readFileSync(path.join(home, "cordis.patch.yml"), "utf8").includes("id: clawd-on-desk"));
    });

  it("skips when the dsh home does not exist", () => {
    const home = path.join(os.tmpdir(), `clawd-dsh-absent-${Date.now()}`);
    const result = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "dsh-home-not-found");
    assert.strictEqual(result.added, false);
  });

  it("resolves DSH_HOME env override and falls back to ~/.dsh", () => {
    assert.strictEqual(resolveDshHome({ dshHome: "/custom/home" }), "/custom/home");
    assert.strictEqual(resolveDshHome({ env: { DSH_HOME: "/env/home" } }), "/env/home");
    assert.strictEqual(resolveDshHome({ env: {} }), path.join(os.homedir(), ".dsh"));
  });

  it("resolves the plugin file URL and hook script path", () => {
    const url = resolvePluginFileUrl(FAKE_BASE);
    assert.ok(url.startsWith("file://"));
    assert.ok(url.endsWith("/dsh-plugin/index.mjs"));
    const script = resolveHookScriptPath(FAKE_BASE);
    assert.ok(script.endsWith("/clawd-dsh-hook.js"));
  });
});
