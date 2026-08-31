// Clawd on Desk — DeepSeek Harness (dsh) native bridge plugin
//
// Runs INSIDE the dsh process (a Cordis host) and forwards harness lifecycle,
// tool, and approval activity to the Clawd desktop pet over HTTP:
//
//   - session / prompt / tool / subagent events → POST /state
//   - blocking permission asks                 → POST /permission
//
// This is a "native hook": DSH deliberately reserves no hook script format;
// a hook is just a normal Cordis plugin that subscribes to the typed lifecycle
// events. We subscribe to the same interception extension points the shipped
// dsh-hooks-claude-code bridge uses (agent/session-start, agent/pre-step,
// tools/pre-execute, tools/post-execute, agent/turn-stopping, subagent/*),
// so behaviorally the pet sees dsh exactly like it sees Claude Code.
//
// Design invariants (mirrors hooks/opencode-plugin/index.mjs):
//   - fire-and-forget state: never await the /state fetch, so slow/broken
//     Clawd cannot stall the harness
//   - same-state dedup: consecutive identical Clawd states skip the POST
//   - self-healing port discovery: read ~/.clawd/runtime.json, else probe
//     the SERVER_PORTS range
//   - permission is BLOCKING (like Claude Code, unlike opencode): the plugin
//     holds one open HTTP request until the Clawd permission bubble answers,
//     then maps the decision back to an ApprovalOutcome; if Clawd is
//     unreachable it delegates via next() so dsh's own UI can answer.
//
// Plugin surface (dsh convention):
//   export const name = 'clawd-on-desk'
//   export function apply(ctx, config) { ... }
// No `inject`: the bridge only needs builtins + fetch, and reads optional
// services (sessionProjections / agents / shell) through `ctx.get()` so a lean
// deployment that omits them still loads.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
// Diagnostic: written on plugin apply, so we can prove the plugin is loaded.
const LOADED_MARKER_PATH = join(CLAWD_DIR, "dsh-plugin.loaded");
// Diagnostic: appended when the approval answerer is actually reached.
const APPROVAL_LOG = join(CLAWD_DIR, "dsh-approval.log");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const STATE_PATH = "/state";
const PERMISSION_PATH = "/permission";
const AGENT_ID = "deepseek-harness";

// Fire-and-forget /state timeout. Clawd's IPC roundtrip (main → renderer →
// main) can be slow under load; 1000ms is generous and still unblocks fast.
const STATE_TIMEOUT_MS = 1000;
// /permission is a blocking hold — the bubble answers it. If the user never
// answers and the DSH-side signal also never fires, cap the hold so the
// harness is not wedged forever (Clawd keeps its own res timer too).
const PERMISSION_TIMEOUT_MS = 590000; // ~10 min, matches Clawd's default

// dsh session-event vocabulary → Clawd state. Mirrors agents/deepseek-harness.js
// eventMap. The plugin emits the Clawd-internal event name too, so Dashboard /
// session HUD get a meaningful event label.
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
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
};

// States Clawd treats as "actively doing a tool/step" are not annotated here:
// the plugin emits one state per lifecycle event, and Clawd's state machine
// (state.js) owns priority/transition/release semantics.

let lastKey = null; // `${session_id}:${state}:${tool_name}` for dedup

// The approval seam does NOT carry tool arguments (a `callId` links the ask to
// an already-streamed tool/call). We cache callId → { name, arguments } as the
// tool is dispatched, so the permission bubble can show the real payload.
const toolCallCache = new Map();

/** Discover the live Clawd HTTP port. Cache the answer; re-probe only on miss. */
let cachedPort = null;
let scanPromise = null;

/** 1) Prefer the runtime.json Clawd wrote on startup (fast path). */
function portFromRuntime() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return null;
}

/** 2) On miss, scan the SERVER_PORTS range for a Clawd `x-clawd-server` response. */
async function scanClawdPort() {
  if (!scanPromise) {
    scanPromise = (async () => {
      for (const port of SERVER_PORTS) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 300);
          const res = await fetch(`http://127.0.0.1:${port}/state`, { signal: ctrl.signal });
          clearTimeout(timer);
          if (res && res.headers && res.headers.get("x-clawd-server") === "clawd-on-desk") {
            return port;
          }
        } catch {}
      }
      return null;
    })();
  }
  return scanPromise;
}

/** Resolve the Clawd port (runtime.json first, then a bounded port scan). */
async function discoverClawdPort() {
  if (!cachedPort) {
    const fromRuntime = portFromRuntime();
    if (fromRuntime) {
      cachedPort = fromRuntime;
    } else {
      cachedPort = await scanClawdPort();
    }
  }
  return cachedPort;
}

/** A tiny hash so Clawd can correlate permission work with a /state event. */
function fingerprint(value) {
  if (value === undefined || value === null) return null;
  try {
    return createHash("sha1").update(JSON.stringify(value)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget state POST. Returns a boolean "delivered" for logging; the
 * caller never awaits it, so a slow/hung Clawd cannot stall the harness.
 */
async function postState(payload) {
  const port = await discoverClawdPort();
  if (!port) return false;
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STATE_TIMEOUT_MS);
  try {
    await fetch(`http://127.0.0.1:${port}${STATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward one lifecycle/tool event to Clawd. Dedups identical consecutive
 * (session, state, tool) triples; suppresses a thinking regression while an
 * active state is current.
 */
function forward(event, state, opts = {}) {
  if (typeof opts.config === "object" && opts.config !== null && opts.config.events === false) {
    return;
  }
  const sessionId = opts.sessionId || "default";
  const key = `${sessionId}:${state}:${opts.toolName || ""}`;
  if (key === lastKey) return;
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: AGENT_ID,
  };
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.toolName) {
    body.tool_name = opts.toolName;
    if (opts.toolUseId) body.tool_use_id = opts.toolUseId;
    const fp = fingerprint(opts.toolInput);
    if (fp) body.tool_input_fingerprint = fp;
  }
  lastKey = key;
  postState(body).then((ok) => {
    if (!ok) lastKey = null; // allow retry next event
  });
}
/** Blocking /permission hold. Resolves to Clawd's behavior ("allow"/"deny"/null). */
async function postPermission(ctx, req, config, signal) {
  const port = await discoverClawdPort();
  if (!port) return null;
  const cached = (req && req.callId) ? toolCallCache.get(req.callId) : null;
  const toolName = (cached && cached.name) || (req && req.toolName) || "unknown";
  const toolInput = (cached && cached.arguments) || {};
  // The approval request has no `sessionId`; the real session id lives on the
  // request's agent (the same id /state reports), so Clawd can attach the
  // bubble to the ACTIVE session instead of the generic "default" (which Clawd
  // auto-allows because no live session maps to it).
  const sessionId =
    (req && req.agent && req.agent.session && req.agent.session.header && req.agent.session.header.id)
    || (req && req.sessionId)
    || "default";
  const body = JSON.stringify({
    agent_id: AGENT_ID,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: (req && req.callId) || undefined,
    tool_input_fingerprint: fingerprint(toolInput),
    // hint surfaced by Clawd's permission bubble / remote approval
    ...(req && req.reason ? { reason: req.reason } : {}),
  });

  // Diagnostic: log the exact request we send, so we can see why Clawd
  // auto-allows the plugin's request while an equivalent curl blocks.
  try {
    writeFileSync(APPROVAL_LOG,
      `postPermission REQUEST session=${sessionId} tool=${toolName} tool_use_id=${req && req.callId} tool_input=${JSON.stringify(toolInput).slice(0, 160)} fp=${fingerprint(toolInput)}\n`,
      { flag: "a" });
  } catch {}

  // Hold the connection open until the bubble answers. The DSH-side approval
  // AbortSignal cancels the hold when the harness withdraws the question.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), PERMISSION_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${PERMISSION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    // Diagnostic: record Clawd's actual response + which session id we sent.
    try {
      writeFileSync(APPROVAL_LOG,
        `postPermission -> status=${res.status} session=${sessionId} tool=${toolName} body=${text.slice(0, 120)}\n`,
        { flag: "a" });
    } catch {}
    if (res.status === 204) return null; // no-decision path → delegate
    return parsePermissionResponse(text);
  } catch (error) {
    try {
      writeFileSync(APPROVAL_LOG,
        `postPermission FAILED session=${sessionId} tool=${toolName} err=${String(error && error.message || error)}\n`,
        { flag: "a" });
    } catch {}
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Clawd returns { hookSpecificOutput: { decision: { behavior } } }. */
function parsePermissionResponse(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const decision = data && data.hookSpecificOutput && data.hookSpecificOutput.decision;
    if (!decision) return null;
    return typeof decision === "string" ? decision : decision.behavior || null;
  } catch {
    return null;
  }
}

/** Map a Clawd decision to a dsh ApprovalOutcome. */
function toOutcome(behavior) {
  if (behavior === "allow") return "allowed-once";
  if (behavior === "deny") return "rejected";
  return null;
}

/** The agent's session header id/cwd, from any event that carries an agent. */
function sessionOf(ctx, agent) {
  if (!agent || !agent.session) return {};
  const h = agent.session.header || {};
  return { sessionId: h.id || "", cwd: h.cwd || "" };
}

/**
 * dsh plugin register/apply. `config` fields:
 *   - events: false disables state forwarding entirely (default: on)
 *   - approval: false disables the /permission answerer (default: on)
 */
export function apply(ctx, config = {}) {
  const eventsEnabled = config.events !== false;
  const approvalEnabled = config.approval !== false;

  // Diagnostic: prove this plugin is loaded by the harness. Written on every
  // apply; a stale file with an old timestamp means a previous boot loaded it.
  try {
    writeFileSync(LOADED_MARKER_PATH, `loaded ${new Date().toISOString()}\npid=${process.pid}\n`, "utf8");
  } catch {}

  // ── lifecycle: session start → idle ──
  ctx.on("agent/session-start", ({ agent, source }) => {
    const { sessionId, cwd } = sessionOf(ctx, agent);
    forward("SessionStart", "idle", {
      config: eventsEnabled ? config : { events: false },
      sessionId,
      cwd,
    });
  }, { global: true });

  // ── prompt → thinking (must delegate so later listeners can rewrite/reject) ──
  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const { sessionId, cwd } = sessionOf(ctx, agent);
    forward("UserPromptSubmit", "thinking", { config, sessionId, cwd });
    return next();
  }, { global: true });

  // ── tool before → working ──
  ctx.on("tools/pre-execute", async (exec, next) => {
    const { sessionId, cwd } = sessionOf(ctx, exec && exec.agent);
    if (exec && exec.callId) {
      toolCallCache.set(exec.callId, { name: exec.name, arguments: exec.arguments });
      if (toolCallCache.size > 256) {
        const first = toolCallCache.keys().next().value;
        toolCallCache.delete(first);
      }
    }
    forward("PreToolUse", "working", {
      config,
      sessionId,
      cwd,
      toolName: exec && exec.name,
      toolUseId: exec && exec.callId,
      toolInput: exec && exec.arguments,
    });
    // Permission is NOT decided here: when a tool needs approval, the harness
    // asks the ApprovalService, whose answerer chain we join below. We just
    // observe the tool started.
    return next();
  }, { global: true });

  // ── tool after → working (or error on failure) ──
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const { sessionId, cwd } = sessionOf(ctx, exec && exec.agent);
    if (exec && exec.callId) toolCallCache.delete(exec.callId);
    const failed = !!(result && result.error);
    forward(failed ? "PostToolUseFailure" : "PostToolUse", failed ? "error" : "working", {
      config,
      sessionId,
      cwd,
      toolName: exec && exec.name,
      toolUseId: exec && exec.callId,
      toolInput: exec && exec.arguments,
    });
    return next();
  }, { global: true });

  // ── turn stopping → attention ──
  ctx.on("agent/turn-stopping", async ({ agent, signal }) => {
    const { sessionId, cwd } = sessionOf(ctx, agent);
    forward("Stop", "attention", { config, sessionId, cwd });
    void signal;
  }, { global: true });

  // ── subagents → juggling / working ──
  ctx.on("subagent/start", (info) => {
    const child = ctx.get("agents")?.get(info.id);
    const { sessionId, cwd } = sessionOf(ctx, child);
    forward("SubagentStart", "juggling", { config, sessionId, cwd });
  }, { global: true });
  ctx.on("subagent/end", (info) => {
    const child = ctx.get("agents")?.get(info.id);
    const { sessionId, cwd } = sessionOf(ctx, child);
    forward("SubagentStop", "working", { config, sessionId, cwd });
  }, { global: true });

  // ── approval answerer (waterfall): Clawd bubble decides, else delegate ──
  if (approvalEnabled) {
    ctx.on("approval/request", async (req, next) => {
      // Diagnostic: log that this answerer was actually reached, plus whether
      // Clawd answered. Distinguishes "answerer not invoked (web answerer wins)"
      // from "invoked but postPermission did not block".
      try {
        const port = await discoverClawdPort();
        writeFileSync(APPROVAL_LOG,
          `approval/request reached tool=${req && req.toolName} callId=${req && req.callId} clawdPort=${port || "none"}\n`,
          { flag: "a" });
      } catch {}
      const signal = req && req.signal;
      const behavior = await postPermission(ctx, req, config, signal);
      const outcome = toOutcome(behavior);
      // Delegate when Clawd is unavailable / no-decision, so dsh's own
      // approval UI (or another answerer) can answer instead of failing closed.
      if (!outcome) return next();
      return outcome;
    }, { global: true, prepend: true });
  }
}

export const name = "clawd-on-desk";
