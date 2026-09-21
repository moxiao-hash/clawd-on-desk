#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath, formatNodeHookCommand } = require("./json-utils");

const PLUGIN_DIR_NAME = "clawd-mavis";
const DEFAULT_MINIMAX_DIR = path.join(os.homedir(), ".minimax");
const HOOK_SCRIPT_NAME = "mavis-hook.js";

const MAVIS_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];

function resolveMinimaxHome(options = {}) {
  const env = options.env || process.env;
  return options.minimaxDir || env.MINIMAX_HOME || DEFAULT_MINIMAX_DIR;
}

function resolvePluginDir(options = {}) {
  if (options.pluginDir) return path.resolve(options.pluginDir);
  return path.join(resolveMinimaxHome(options), "plugins", PLUGIN_DIR_NAME);
}

function resolveHookScriptSource(options = {}) {
  if (options.hookScript) return path.resolve(options.hookScript);
  return asarUnpackedPath(path.join(__dirname, HOOK_SCRIPT_NAME));
}

function buildHookCommand(nodeBin, hookScript, event, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
  });
}

function generatePluginManifest() {
  return {
    $schema: "https://api.minimax.chat/schemas/plugin-v1.json",
    schemaVersion: 1,
    name: "clawd-mavis",
    displayName: "Clawd Desktop Pet for Mavis",
    version: "1.0.0",
    description: "Clawd on Desk integration plugin for Mavis / MiniMax Code",
    author: "Clawd on Desk",
    icon: "icon.png",
    category: "Other",
    exampleQueries: [
      "启动桌宠状态同步",
      "检查桌宠连接状态",
      "同步当前 Agent 状态到桌宠"
    ],
    apps: [],
    mcpServers: [],
    skills: [],
    hooks: ["hooks/hooks.json"],
  };
}

function generateHooksConfig(nodeBin, hookScriptPath, options = {}) {
  const permissionsEnabled = options.permissionsEnabled !== false;
  const timeoutSeconds = Math.min(Math.max(Number(options.timeoutSeconds) || 10, 1), 10);
  const permissionTimeout = Math.min(Math.max(Number(options.permissionTimeout) || 10, 1), 10);

  const hooks = {};
  for (const event of MAVIS_HOOK_EVENTS) {
    if (event === "PermissionRequest" && !permissionsEnabled) {
      continue;
    }
    const timeout = event === "PermissionRequest" ? permissionTimeout : timeoutSeconds;
    const cmd = buildHookCommand(nodeBin, hookScriptPath, event, options);
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: cmd,
            timeout,
          },
        ],
      },
    ];
  }

  return { hooks };
}

function installMavisHooks(options = {}) {
  const pluginDir = resolvePluginDir(options);
  const hookScriptSource = resolveHookScriptSource(options);
  const nodeBin = resolveNodeBin(options.nodeBin || process.execPath);

  const manifestDir = path.join(pluginDir, ".minimax-plugin");
  const manifestPath = path.join(manifestDir, "plugin.json");
  const hooksDir = path.join(pluginDir, "hooks");
  const hooksPath = path.join(hooksDir, "hooks.json");
  const targetScriptPath = path.join(pluginDir, HOOK_SCRIPT_NAME);

  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  // 1. Copy hook script and required helper modules into plugin directory
  const helperFiles = [
    HOOK_SCRIPT_NAME,
    "server-config.js",
    "shared-process.js",
  ];

  for (const fileName of helperFiles) {
    const src = path.join(__dirname, fileName);
    const dest = path.join(pluginDir, fileName);
    if (fs.existsSync(src)) {
      try {
        const content = fs.readFileSync(src, "utf8");
        fs.writeFileSync(dest, content, { mode: 0o755 });
      } catch (_) {}
    }
  }

  const effectiveScriptPath = fs.existsSync(targetScriptPath) ? targetScriptPath : hookScriptSource;

  // Copy icon.png to plugin directory if available
  const iconSource = path.join(__dirname, "..", "assets", "icon.png");
  const targetIconPath = path.join(pluginDir, "icon.png");
  if (fs.existsSync(iconSource)) {
    try {
      fs.copyFileSync(iconSource, targetIconPath);
    } catch (_) {}
  }

  // 2. Write .minimax-plugin/plugin.json
  const manifest = generatePluginManifest();
  writeJsonAtomic(manifestPath, manifest);

  // 3. Write hooks/hooks.json
  const hooksConfig = generateHooksConfig(nodeBin, effectiveScriptPath, options);
  writeJsonAtomic(hooksPath, hooksConfig);

  return {
    success: true,
    pluginDir,
    manifestPath,
    hooksPath,
    installed: true,
  };
}

function uninstallMavisHooks(options = {}) {
  const pluginDir = resolvePluginDir(options);
  if (!fs.existsSync(pluginDir)) {
    return { success: true, removed: false };
  }

  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    return { success: true, removed: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function hasMavisHooksInstalled(options = {}) {
  const pluginDir = resolvePluginDir(options);
  const manifestPath = path.join(pluginDir, ".minimax-plugin", "plugin.json");
  const hooksPath = path.join(pluginDir, "hooks", "hooks.json");

  if (!fs.existsSync(manifestPath) || !fs.existsSync(hooksPath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(hooksPath, "utf8");
    const parsed = JSON.parse(raw);
    return Boolean(
      parsed &&
      parsed.hooks &&
      typeof parsed.hooks === "object" &&
      Object.keys(parsed.hooks).length > 0
    );
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--uninstall")) {
    const res = uninstallMavisHooks();
    console.log("Uninstall Mavis hooks:", res);
    return;
  }
  if (args.includes("--status")) {
    const status = hasMavisHooksInstalled();
    console.log("Mavis hooks installed:", status);
    return;
  }

  const res = installMavisHooks();
  console.log("Installed Mavis hooks:", res);
}

if (require.main === module) {
  main();
}

module.exports = {
  PLUGIN_DIR_NAME,
  MAVIS_HOOK_EVENTS,
  resolveMinimaxHome,
  resolvePluginDir,
  resolveHookScriptSource,
  buildHookCommand,
  generatePluginManifest,
  generateHooksConfig,
  installMavisHooks,
  uninstallMavisHooks,
  hasMavisHooksInstalled,
};
