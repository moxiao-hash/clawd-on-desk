#!/usr/bin/env node
// Merge Clawd ZCode hooks into ~/.zcode/cli/config.json.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath, formatNodeHookCommand } = require("./json-utils");

const MARKER = "zcode-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".zcode", "cli");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "config.json");

const ZCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

function buildZCodeHookCommand(nodeBin, hookScript, event, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
  });
}

function resolveTargetConfigPath(options = {}) {
  if (options.configPath) return path.resolve(options.configPath);
  return DEFAULT_CONFIG_PATH;
}

function resolveInstalledHookScript(options = {}) {
  if (options.hookScript) return path.resolve(options.hookScript);
  return asarUnpackedPath(path.join(__dirname, MARKER));
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isClawdHookItem(item) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.command === "string" && item.command.includes(MARKER)) return true;
  if (Array.isArray(item.args) && item.args.some((arg) => typeof arg === "string" && arg.includes(MARKER))) {
    return true;
  }
  return false;
}

function isClawdEventEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(isClawdHookItem);
  }
  return false;
}

function cleanExistingClawdHooks(eventsObj) {
  if (!eventsObj || typeof eventsObj !== "object") return {};
  const cleaned = {};
  for (const [eventName, entries] of Object.entries(eventsObj)) {
    if (!Array.isArray(entries)) continue;
    const filteredEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (Array.isArray(entry.hooks)) {
        const remainingHooks = entry.hooks.filter((h) => !isClawdHookItem(h));
        if (remainingHooks.length > 0) {
          filteredEntries.push({ ...entry, hooks: remainingHooks });
        }
      } else if (!isClawdEventEntry(entry)) {
        filteredEntries.push(entry);
      }
    }
    if (filteredEntries.length > 0) {
      cleaned[eventName] = filteredEntries;
    }
  }
  return cleaned;
}

function installZCodeHooks(options = {}) {
  const configPath = resolveTargetConfigPath(options);
  const hookScript = resolveInstalledHookScript(options);
  const nodeBin = resolveNodeBin(options.nodeBin || process.execPath);

  const existingConfig = readJsonSafe(configPath);
  const existingHooks = existingConfig.hooks && typeof existingConfig.hooks === "object"
    ? existingConfig.hooks
    : {};

  const cleanedEvents = cleanExistingClawdHooks(existingHooks.events || {});

  for (const event of ZCODE_HOOK_EVENTS) {
    if (!Array.isArray(cleanedEvents[event])) {
      cleanedEvents[event] = [];
    }

    const command = buildZCodeHookCommand(nodeBin, hookScript, event, options);
    cleanedEvents[event].push({
      hooks: [
        {
          type: "command",
          command,
          timeout: DEFAULT_HOOK_TIMEOUT_SECONDS,
        },
      ],
    });
  }

  const updatedConfig = {
    ...existingConfig,
    hooks: {
      ...existingHooks,
      enabled: true,
      events: cleanedEvents,
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonAtomic(configPath, updatedConfig);
  return { success: true, configPath };
}

function uninstallZCodeHooks(options = {}) {
  const configPath = resolveTargetConfigPath(options);
  if (!fs.existsSync(configPath)) {
    return { success: true, configPath, uninstalled: false };
  }

  const existingConfig = readJsonSafe(configPath);
  if (!existingConfig.hooks || typeof existingConfig.hooks !== "object") {
    return { success: true, configPath, uninstalled: false };
  }

  const cleanedEvents = cleanExistingClawdHooks(existingConfig.hooks.events || {});
  const updatedConfig = {
    ...existingConfig,
    hooks: {
      ...existingConfig.hooks,
      events: cleanedEvents,
    },
  };

  writeJsonAtomic(configPath, updatedConfig);
  return { success: true, configPath, uninstalled: true };
}

function main() {
  const isUninstall = process.argv.includes("--uninstall");
  if (isUninstall) {
    const result = uninstallZCodeHooks();
    console.log(`[Clawd] Uninstalled ZCode hooks from ${result.configPath}`);
  } else {
    const result = installZCodeHooks();
    console.log(`[Clawd] Installed ZCode hooks to ${result.configPath}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  installZCodeHooks,
  uninstallZCodeHooks,
  buildZCodeHookCommand,
  cleanExistingClawdHooks,
  DEFAULT_CONFIG_PATH,
  ZCODE_HOOK_EVENTS,
};
