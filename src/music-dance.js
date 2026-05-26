// src/music-dance.js — System audio monitoring → pet dance (juggling state)
// Uses pmset -g assertions on macOS to detect when music apps are playing audio.
// Excludes Clawd's own audio context and non-music apps (browsers, video players, etc.).
const { exec, execFileSync } = require("child_process");

const POLL_INTERVAL_MS = 500;
const START_THRESHOLD = 2; // 1s → start dancing
const STOP_THRESHOLD = 3; // 1.5s → stop dancing
const COOLDOWN_MS = 3000; // 3s cooldown
const PPID_MAX_DEPTH = 5;

const isMac = process.platform === "darwin";
const SELF_PID = process.pid;

// Process names that are not the app itself (child/shell processes).
// When we encounter these, we walk up to the parent.
const GENERIC_COMM_PREFIXES = ["Helper", "Renderer", "Plugin", "Worker", "Network", "GPU"];

function isGenericChildComm(comm, commName) {
  if (!commName) return false;
  for (const prefix of GENERIC_COMM_PREFIXES) {
    if (commName.startsWith(prefix)) return true;
  }
  return commName === "bash" || commName === "sh" || commName === "zsh";
}

function createNoop() {
  return {
    start() {},
    stop() {},
    get isDancing() {
      return false;
    },
  };
}

function pidIsSelf(pid) {
  if (pid === SELF_PID) return true;
  try {
    const { execFileSync: efs } = require("child_process");
    const out = efs("ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 2000,
      encoding: "utf8",
    }).trim().toLowerCase();
    return out.includes("electron") || out.includes("clawd");
  } catch {
    return false;
  }
}

// Walk up the process tree from the given PID to see if any ancestor's comm
// matches one of the configured music app names. Handles child processes
// like "QQMusic Helper" → parent "QQMusic".
function isMusicAppPid(pid, appNames) {
  if (!appNames || appNames.size === 0) return false;
  let currentPid = pid;

  for (let depth = 0; depth < PPID_MAX_DEPTH; depth++) {
    let comm, ppid, commName;

    try {
      // Two separate calls avoid ps column-width truncation with multi-byte characters
      comm = execFileSync(
        "ps", ["-p", String(currentPid), "-o", "comm="],
        { encoding: "utf8", timeout: 1000 }
      ).trim();
      const ppidOut = execFileSync(
        "ps", ["-p", String(currentPid), "-o", "ppid="],
        { encoding: "utf8", timeout: 1000 }
      ).trim();
      ppid = parseInt(ppidOut, 10);
      // macOS ps -o comm= returns full path; extract basename for matching
      commName = comm.split("/").pop() || comm;
    } catch {
      break;
    }

    if (!comm) break;

    // Direct match against configured app names (use basename from full path)
    if (appNames.has(commName)) return true;

    // If this is a child/helper process, keep walking up
    if (isGenericChildComm(comm, commName)) {
      if (!ppid || ppid <= 1 || ppid === currentPid) break;
      currentPid = ppid;
      continue;
    }

    // Non-generic, non-matching process: try one more level up in case
    // the audio PID is a sub-process of the main app that doesn't use
    // the standard Helper/Renderer naming
    if (depth === 0) {
      if (!ppid || ppid <= 1 || ppid === currentPid) break;
      currentPid = ppid;
      continue;
    }

    // If we're already past the first parent and still don't match, stop
    break;
  }

  return false;
}

function checkAudioPlaying(appNames) {
  return new Promise((resolve) => {
    exec("pmset -g assertions", { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      const blocks = stdout.split(/\n(?= {3}pid)/);
      for (const block of blocks) {
        if (!block.includes("coreaudiod") || !block.includes("audio-out")) continue;
        const pidMatch = block.match(/Created for PID:\s*(\d+)/);
        if (!pidMatch) continue;
        const audioPid = parseInt(pidMatch[1], 10);
        if (pidIsSelf(audioPid)) continue;
        // Only trigger for configured music apps
        if (!isMusicAppPid(audioPid, appNames)) continue;
        resolve(true);
        return;
      }
      resolve(false);
    });
  });
}

module.exports = function initMusicDance(ctx) {
  if (!isMac) return createNoop();

  let pollTimer = null;
  let isDancing = false;
  let previousState = "idle";
  let runningCount = 0;
  let notRunningCount = 0;
  let cooldownUntil = 0;
  let pollRunning = false;

  async function poll() {
    if (pollRunning) return;
    pollRunning = true;

    try {
      // Check enabled toggle
      if (!ctx.musicDanceEnabled) {
        if (isDancing) {
          try { ctx.setState(previousState); } catch {}
          isDancing = false;
        }
        runningCount = 0;
        notRunningCount = 0;
        pollRunning = false;
        return;
      }

      if (ctx.doNotDisturb) {
        runningCount = 0;
        notRunningCount = 0;
        pollRunning = false;
        return;
      }

      const appNames = new Set(ctx.musicAppNames || []);
      const audioPlaying = await checkAudioPlaying(appNames);
      const current = ctx.currentState;

      // If dancing was interrupted by another action, recover or clean up
      if (isDancing && current !== "juggling") {
        if (audioPlaying) {
          // Audio still playing — re-enter dancing immediately
          previousState = current;
          ctx.setState("juggling");
        } else {
          // Audio stopped while we were interrupted — just clean up
          isDancing = false;
          cooldownUntil = Date.now() + COOLDOWN_MS;
        }
        pollRunning = false;
        return;
      }

      if (audioPlaying) {
        runningCount++;
        notRunningCount = 0;

        if (
          runningCount >= START_THRESHOLD &&
          !isDancing &&
          Date.now() > cooldownUntil
        ) {
          if (current !== "juggling") previousState = current;
          ctx.setState("juggling");
          isDancing = true;
        }
      } else {
        notRunningCount++;
        runningCount = 0;

        if (notRunningCount >= STOP_THRESHOLD && isDancing) {
          ctx.setState(previousState);
          isDancing = false;
          cooldownUntil = Date.now() + COOLDOWN_MS;
        }
      }
    } catch {
      // Silently ignore poll errors
    }

    pollRunning = false;
  }

  return {
    start() {
      if (pollTimer) return;
      // Run first poll immediately
      poll();
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    },

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (isDancing) {
        try {
          ctx.setState(previousState);
        } catch {}
      }
      runningCount = 0;
      notRunningCount = 0;
      isDancing = false;
      cooldownUntil = 0;
    },

    get isDancing() {
      return isDancing;
    },
  };
};
