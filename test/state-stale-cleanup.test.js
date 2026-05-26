"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  SESSION_STALE_MS,
  WORKING_STALE_MS,
  DETACHED_IDLE_STALE_MS,
  isWorkingLikeState,
  getStaleSessionDecision,
} = require("../src/state-stale-cleanup");

function session(overrides = {}) {
  return {
    state: "idle",
    updatedAt: 1000000,
    pidReachable: true,
    sourcePid: null,
    agentPid: null,
    ...overrides,
  };
}

function decision(target, overrides = {}) {
  const calls = [];
  const alivePids = overrides.alivePids || new Set();
  const result = getStaleSessionDecision(target, {
    now: overrides.now || 1000000,
    isProcessAlive(pid) {
      calls.push(pid);
      return alivePids.has(pid);
    },
    deriveSessionBadge: overrides.deriveSessionBadge || (() => "idle"),
    shouldAutoClearDetachedSession: overrides.shouldAutoClearDetachedSession || (() => false),
  });
  return { result, calls };
}

describe("state stale cleanup decisions", () => {
  it("deletes immediately when a reachable agent pid is dead before badge checks", () => {
    let badgeCalls = 0;
    const { result, calls } = decision(session({ agentPid: 10, sourcePid: 20 }), {
      alivePids: new Set([20]),
      deriveSessionBadge: () => { badgeCalls += 1; return "done"; },
      shouldAutoClearDetachedSession: () => true,
    });

    assert.deepStrictEqual(result, { action: "delete", reason: "agent-exit" });
    assert.deepStrictEqual(calls, [10]);
    assert.strictEqual(badgeCalls, 0);
  });

  it("marks a detached ended session for HUD refresh before fast deletion threshold", () => {
    const { result, calls } = decision(session({
      updatedAt: 1000000 - DETACHED_IDLE_STALE_MS + 1,
      sourcePid: 20,
    }), {
      shouldAutoClearDetachedSession: (target, badge) => {
        assert.strictEqual(badge, "done");
        return true;
      },
      deriveSessionBadge: () => "done",
    });

    assert.deepStrictEqual(result, { action: null, snapshotRefreshNeeded: true });
    assert.deepStrictEqual(calls, []);
  });

  it("deletes a detached ended session after the fast deletion threshold", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - DETACHED_IDLE_STALE_MS - 1,
      sourcePid: 20,
    }), {
      deriveSessionBadge: () => "interrupted",
      shouldAutoClearDetachedSession: () => true,
    });

    assert.deepStrictEqual(result, { action: "delete", reason: "detached-ended", badge: "interrupted" });
  });

  it("handles full stale timeout source and reachability branches", () => {
    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      sourcePid: 20,
    })).result, { action: "delete", reason: "source-exit" });

    assert.deepStrictEqual(decision(session({
      state: "working",
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      sourcePid: 20,
    }), {
      alivePids: new Set([20]),
    }).result, { action: "idle", reason: "session-timeout", updateTimestamp: false });

    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      pidReachable: false,
    })).result, { action: "delete", reason: "unreachable" });

    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      pidReachable: true,
      sourcePid: null,
    })).result, { action: "delete", reason: "no-source" });
  });

  it("handles working stale timeout source exit and idle downgrade", () => {
    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: 20,
    })).result, { action: "delete", reason: "working-source-exit" });

    assert.deepStrictEqual(decision(session({
      state: "thinking",
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: null,
    })).result, { action: "idle", reason: "working-timeout", updateTimestamp: true });

    assert.deepStrictEqual(decision(session({
      state: "idle",
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: null,
    })).result, { action: null });
  });

  it("keeps working-like state set explicit", () => {
    assert.strictEqual(isWorkingLikeState("working"), true);
    assert.strictEqual(isWorkingLikeState("thinking"), true);
    assert.strictEqual(isWorkingLikeState("juggling"), true);
    assert.strictEqual(isWorkingLikeState("idle"), false);
  });
});
