const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerDshBridge,
  resolvePluginFileUrl,
  resolveDshHome,
  buildPatchBody,
  mergeIntoPatchLayer,
  layerHasPlugin,
  DEFAULT_PROFILE,
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

describe("dsh bridge installer", () => {
  it("creates the standalone patch overlay and registers into the patch layer", () => {
    const home = makeTempDir("home");
    const result = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, true);
    assert.ok(fs.existsSync(path.join(home, "clawd-on-desk.cordis.yml")));
    const layer = fs.readFileSync(path.join(home, "cordis.patch.yml"), "utf8");
    // The requested plugin entry's `name` is a file:// URL to the plugin entry.
    const pluginFile = resolvePluginFileUrl(FAKE_BASE);
    assert.ok(layer.includes(`id: clawd-on-desk`), `missing plugin id:\n${layer}`);
    assert.ok(layer.includes(pluginFile), `missing plugin file URL:\n${layer}`);
  });

  it("is idempotent across repeated registration", () => {
    const home = makeTempDir("home");
    registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });
    const second = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    assert.strictEqual(second.added, false);
    assert.strictEqual(second.updated, false);
    const layer = fs.readFileSync(path.join(home, "cordis.patch.yml"), "utf8");
    const count = layer.split("id: clawd-on-desk").length - 1;
    assert.strictEqual(count, 1, `duplicated plugin id:\n${layer}`);
  });

  it("preserves unrelated user patch content", () => {
    const home = makeTempDir("home");
    // Pre-existing user patch layer with an unrelated insert.
    fs.writeFileSync(
      path.join(home, "cordis.patch.yml"),
      "- insert:\n    - id: memory-memorix\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memorix\n",
      "utf8",
    );
    registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    const layer = fs.readFileSync(path.join(home, "cordis.patch.yml"), "utf8");
    assert.ok(layer.includes("memory-memorix"), "clobbered existing patch");
    assert.ok(layer.includes("id: clawd-on-desk"), "missing our plugin id");
  });

  it("appends a new top-level insert slice to an existing patch list", () => {
    const existing = "- insert:\n    - id: a\n      name: '@x/a'\n";
    const merged = mergeIntoPatchLayer(existing, "file:///app/clawd/hooks/dsh-plugin/index.mjs");
    assert.strictEqual(merged.added, true);
    assert.ok(merged.text.includes("- insert:\n    - id: a"));
    assert.ok(merged.text.includes("id: clawd-on-desk"));
  });

  it("builds a standalone patch body that is a valid insert slice", () => {
    const body = buildPatchBody("file:///app/clawd/hooks/dsh-plugin/index.mjs");
    // Leading comment lines are valid YAML; the first directive item is `- insert:`.
    assert.ok(/^- insert:/m.test(body), `missing insert slice:\n${body}`);
    assert.ok(body.includes("id: clawd-on-desk"));
    assert.ok(body.includes("file:///app/clawd/hooks/dsh-plugin/index.mjs"));
    assert.ok(body.includes("events: true"));
    assert.ok(body.includes("approval: true"));
  });

  it("detects an existing plugin id in a patch layer", () => {
    assert.strictEqual(layerHasPlugin("id: clawd-on-desk"), true);
    assert.strictEqual(layerHasPlugin("id: memory-memorix"), false);
    assert.strictEqual(layerHasPlugin(""), false);
  });

  it("replaces an empty `[]` profile patch layer (comment header preserved-agnostic)", () => {
    // A fresh dsh web profile user patch layer is `[]`, often under a comment
    // header. Appending a `- insert:` after `[]` would be invalid YAML; the
    // merge must REPLACE the empty list with our slice.
    const existing = "# Your patch layer for this dsh profile...\n[]\n";
    const merged = mergeIntoPatchLayer(existing, "file:///app/clawd/hooks/dsh-plugin/index.mjs");
    assert.strictEqual(merged.added, true);
    // The `[]` placeholder must be gone (replaced), not left dangling.
    assert.ok(!/\[\]/.test(merged.text), `empty [] left dangling:\n${merged.text}`);
    assert.ok(merged.text.includes("id: clawd-on-desk"));
  });

  it("defaults the profile layer to `web`", () => {
    assert.strictEqual(DEFAULT_PROFILE, "web");
  });

  it("writes the profile-level patch layer alongside the global layer", () => {
    const home = makeTempDir("home");
    // Pre-create the web profile directory + empty `[]` patch layer.
    const webDir = path.join(home, "profiles", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, "cordis.patch.yml"), "# comment\n[]\n", "utf8");

    const result = registerDshBridge({ silent: true, dshHome: home, baseDir: FAKE_BASE });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.profile, "web");
    const profileText = fs.readFileSync(path.join(webDir, "cordis.patch.yml"), "utf8");
    assert.ok(profileText.includes("id: clawd-on-desk"), `profile layer missing plugin:\n${profileText}`);
    // Global layer also written.
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
    assert.strictEqual(
      resolveDshHome({ env: { DSH_HOME: "/env/home" } }),
      "/env/home",
    );
    assert.strictEqual(resolveDshHome({ env: {} }), path.join(os.homedir(), ".dsh"));
  });

  it("resolves the plugin entry to a file:// URL ending in dsh-plugin/index.mjs", () => {
    const url = resolvePluginFileUrl("/app/clawd/hooks");
    assert.ok(url.startsWith("file://"), `not a file url: ${url}`);
    assert.ok(url.endsWith("/dsh-plugin/index.mjs"), `wrong suffix: ${url}`);
  });
});
