// Clawd on Desk — DeepSeek Harness (dsh) native bridge plugin (supplement)
//
// The dsh `dsh-hooks-claude-code` bridge runs our command hook
// (hooks/clawd-dsh-hook.js) for the events it supports (SessionStart /
// UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart /
// SubagentStop). This plugin supplements what the bridge does not run:
//
//   - error          → tools/post-execute with result.error → POST /state (error)
//   - approval       → approval/request answerer → Clawd /permission bubble
//                      (Allow / Always=session-scoped remember / Deny)
//   - user-questions → user-questions/request answerer → Clawd elicitation bubble
//                      (options + free-text answer → answers back to dsh)
//
// It is a "native hook": a plain Cordis plugin subscribing the typed extension
// points. Because dsh dispatches these as agent-scoped waterfalls, every
// answerer is registered `{ global: true, prepend: true }` so it receives all
// agents and runs before dsh's built-in web answerer, and it uses the real
// session id from the request's agent.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
const LOADED_MARKER_PATH = join(CLAWD_DIR, "dsh-plugin.loaded");
const APPROVAL_LOG = join(CLAWD_DIR, "dsh-approval.log");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const STATE_PATH = "/state";
const PERMISSION_PATH = "/permission";
const AGENT_ID = "deepseek-harness";

const STATE_TIMEOUT_MS = 1000;
const PERMISSION_TIMEOUT_MS = 590000; // ~10 min, matches Clawd's default

const HANDLED = new Set(); // tool names the user has "Always" allowed (session-scoped)

// tool call id → { name, arguments } so the approval bubble shows the payload.
const toolCallCache = new Map();

let cachedPort = null;
let scanPromise = null;

function portFromRuntime() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return null;
}

async function scanClawdPort() {
  if (!scanPromise) {
    scanPromise = (async () => {
      for (const port of SERVER_PORTS) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 300);
          const res = await fetch(`http://127.0.0.1:${port}/state`, { signal: ctrl.signal });
          clearTimeout(timer);
          if (res && res.headers && res.headers.get("x-clawd-server") === "clawd-on-desk") return port;
        } catch {}
      }
      return null;
    })();
  }
  return scanPromise;
}

async function discoverClawdPort() {
  if (!cachedPort) {
    const fromRuntime = portFromRuntime();
    cachedPort = fromRuntime ? fromRuntime : await scanClawdPort();
  }
  return cachedPort;
}

function fingerprint(value) {
  if (value === undefined || value === null) return null;
  try {
    return createHash("sha1").update(JSON.stringify(value)).digest("hex");
  } catch {
    return null;
  }
}

async function postState(payload) {
  const port = await discoverClawdPort();
  if (!port) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STATE_TIMEOUT_MS);
  try {
    await fetch(`http://127.0.0.1:${port}${STATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sessionOf(agent) {
  if (!agent || !agent.session) return {};
  const h = agent.session.header || {};
  return { sessionId: h.id || "", cwd: h.cwd || "" };
}

/** Forward one supplementary state event (the bridge does not run these). */
function forward(event, state, opts = {}) {
  const sessionId = opts.sessionId || "default";
  const body = { state, session_id: sessionId, event, agent_id: AGENT_ID };
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.toolName) {
    body.tool_name = opts.toolName;
    if (opts.toolUseId) body.tool_use_id = opts.toolUseId;
  }
  postState(body);
}

/** Blocking /permission hold. Returns Clawd's `{behavior, updatedInput, updatedPermissions}` or null. */
async function postPermission(req, config, signal) {
  const port = await discoverClawdPort();
  if (!port) return null;
  const cached = (req && req.callId) ? toolCallCache.get(req.callId) : null;
  const toolName = (cached && cached.name) || (req && req.toolName) || "unknown";
  const toolInput = (cached && cached.arguments) || {};
  const sessionId = (req && req.agent && req.agent.session && req.agent.session.header && req.agent.session.header.id)
    || (req && req.sessionId) || "default";
  const body = JSON.stringify({
    agent_id: AGENT_ID,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: (req && req.callId) || undefined,
    tool_input_fingerprint: fingerprint(toolInput),
    ...(req && req.reason ? { reason: req.reason } : {}),
  });
  try {
    writeFileSync(APPROVAL_LOG, `postPermission REQUEST session=${sessionId} tool=${toolName} tool_use_id=${req && req.callId}\n`, { flag: "a" });
  } catch {}
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
    try {
      writeFileSync(APPROVAL_LOG, `postPermission -> status=${res.status} session=${sessionId} tool=${toolName} body=${text.slice(0, 160)}\n`, { flag: "a" });
    } catch {}
    if (res.status === 204) return null;
    return parsePermissionResponse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Clawd returns { hookSpecificOutput: { decision } }. */
function parsePermissionResponse(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const decision = data && data.hookSpecificOutput && data.hookSpecificOutput.decision;
    if (!decision) return null;
    return {
      behavior: typeof decision === "string" ? decision : decision.behavior || null,
      updatedPermissions: decision.updatedPermissions,
      updatedInput: decision.updatedInput,
    };
  } catch {
    return null;
  }
}

function toOutcome(behavior) {
  if (behavior === "allow" || behavior === "always") return "allowed-once";
  if (behavior === "deny") return "rejected";
  return null;
}

/** Map a Clawd decision to a dsh ApprovalOutcome, recording an Always grant. */
function decisionToOutcome(req, decision) {
  if (!decision || !decision.behavior) return null;
  const toolName = (req && req.toolName) || "unknown";
  if (decision.behavior === "always" || isAlwaysGrant(decision.updatedPermissions)) {
    HANDLED.add(toolName); // session-scoped remember
  }
  return toOutcome(decision.behavior);
}

function isAlwaysGrant(updatedPermissions) {
  return Array.isArray(updatedPermissions)
    && updatedPermissions.some((p) => p && typeof p === "object"
      && (p.permission === "allowAlways" || p.permission === "always" || p.behavior === "always"));
}

/**
 * Forward a dsh user-questions request to Clawd's elicitation channel so the
 * user can answer (select an option and/or type free text) in the pet bubble.
 * Reuses POST /permission with tool_name "AskUserQuestion"; Clawd's elicitation
 * branch returns the answers in `updatedInput.answers`.
 */
async function requestElicitation(questions, req, config, signal) {
  const port = await discoverClawdPort();
  if (!port) return null;
  const sessionId = (req && req.agent && req.agent.session && req.agent.session.header && req.agent.session.header.id) || "default";
  const body = JSON.stringify({
    agent_id: AGENT_ID,
    session_id: sessionId,
    tool_name: "AskUserQuestion",
    tool_input: { questions },
    tool_use_id: (questions[0] && questions[0].id) || undefined,
  });
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
    if (res.status === 204) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Parse Clawd elicitation answers. Clawd returns updatedInput.answers as
 *  `{ [questionText]: answerText }` (see permission.js buildElicitationUpdatedInput).
 *  We map that back to dsh's `answers` array [{id, selected[], custom}], putting
 *  the answer in `selected` when it matches an offered option label, else `custom`. */
function parseElicitationAnswers(text, originalQuestions) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const decision = data && data.hookSpecificOutput && data.hookSpecificOutput.decision;
    const updatedInput = decision && decision.updatedInput;
    if (!updatedInput) return null;
    const claudeAnswers = updatedInput.answers; // { questionText: answerText }
    if (!claudeAnswers || typeof claudeAnswers !== "object") return null;
    const questions = Array.isArray(updatedInput.questions)
      ? updatedInput.questions
      : (Array.isArray(originalQuestions) ? originalQuestions : []);
    const out = [];
    for (const q of questions) {
      if (!q || typeof q.question !== "string" || !q.question) continue;
      const text = claudeAnswers[q.question];
      if (typeof text !== "string" || !text.trim()) continue;
      const id = q.id || q.question;
      const item = { id, selected: [] };
      const optionLabels = (Array.isArray(q.options) ? q.options : []).map((o) => o && o.label);
      if (optionLabels.includes(text)) item.selected = [text];
      else item.custom = text;
      out.push(item);
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * dsh plugin apply. `config` fields: approval (default on), questions (default on).
 */
export function apply(ctx, config = {}) {
  const approvalEnabled = config.approval !== false;
  const questionsEnabled = config.questions !== false;

  try {
    writeFileSync(LOADED_MARKER_PATH, `loaded ${new Date().toISOString()}\npid=${process.pid}\n`, "utf8");
  } catch {}

  // ── record tool calls (for approval bubble payload), observe for error ──
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec && exec.callId) {
      toolCallCache.set(exec.callId, { name: exec.name, arguments: exec.arguments });
      if (toolCallCache.size > 256) toolCallCache.delete(toolCallCache.keys().next().value);
    }
    return next();
  }, { global: true });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    if (exec && exec.callId) toolCallCache.delete(exec.callId);
    const failed = !!(result && result.error);
    if (failed) {
      const { sessionId, cwd } = sessionOf(exec && exec.agent);
      forward("PostToolUseFailure", "error", { sessionId, cwd, toolName: exec && exec.name, toolUseId: exec && exec.callId });
    }
    return next();
  }, { global: true });

  // ── approval answerer (waterfall), global + first ──
  if (approvalEnabled) {
    ctx.on("approval/request", async (req, next) => {
      const toolName = (req && req.toolName) || "unknown";
      if (HANDLED.has(toolName)) return "allowed-once"; // session-scoped Always
      const signal = req && req.signal;
      const decision = await postPermission(req, config, signal);
      const outcome = decisionToOutcome(req, decision);
      if (!outcome) return next();
      return outcome;
    }, { global: true, prepend: true });
  }

  // ── user-questions answerer (waterfall), global + first ──
  if (questionsEnabled) {
    ctx.on("user-questions/request", async (req, next) => {
      const questions = (req && req.questions) || [];
      if (questions.length === 0) return next();
      const text = await requestElicitation(questions, req, config, req && req.signal);
      const answers = parseElicitationAnswers(text, questions);
      if (!answers) return next();
      return { answers };
    }, { global: true, prepend: true });
  }
}

export const name = "clawd-on-desk";
