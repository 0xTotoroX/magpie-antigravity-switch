/**
 * [INPUT]: core.mjs、插件指令文件与本地文件变更。
 * [OUTPUT]: 两种分发包名的指令解析、后台监听器与页面状态同步。
 * [POS]: Magpie 插件的独立后台进程；使用系统文件锁保持单实例，空闲时热重载。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PATHS,
  PLUGIN_DIR,
  PLUGIN_NAME,
  executeCommandAsync,
  refreshCliAccounts,
  syncStateFile
} from "./core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORE_PATH = path.join(__dirname, "core.mjs");
const MUTEX_PATH = `${PATHS.daemonLock}.lock`;
const HANDOFF_PATH = `${PATHS.daemonLock}.next`;
const HANDOFF_SECONDS = 90;
const DAEMON_FD = 3;
const DAEMON_FLAG = "--daemon";
const WAIT_FOR_LOCK_FLAG = "--daemon-wait";
const INHERITED_LOCK_FLAG = "--daemon-with-lock";

function getCodeSignature() {
  try {
    const s1 = fs.statSync(__filename);
    const s2 = fs.statSync(CORE_PATH);
    return `${Math.trunc(s1.mtimeMs)}-${s1.size}:${Math.trunc(s2.mtimeMs)}-${s2.size}`;
  } catch {
    return "unknown";
  }
}

const INITIAL_SIGNATURE = getCodeSignature();

// lockf locks the open file description. Passing the descriptor to the child
// keeps the lock held across startup and reload, and the OS releases it on exit.
function lockDescriptor(fd, waitSeconds = 0) {
  try {
    execFileSync("/usr/bin/lockf", ["-s", "-t", String(waitSeconds), String(DAEMON_FD)], {
      stdio: ["ignore", "ignore", "ignore", fd]
    });
    return true;
  } catch (err) {
    if (err.status === 75) return false;
    throw new Error("无法锁定 Antigravity Switch 后台监听");
  }
}

function openDaemonLock(waitSeconds) {
  fs.mkdirSync(PATHS.magpieDir, { recursive: true });
  const fd = fs.openSync(MUTEX_PATH, "a", 0o600);
  try {
    if (lockDescriptor(fd, waitSeconds)) return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  fs.closeSync(fd);
  return null;
}

function inheritedDaemonLock() {
  const inherited = fs.fstatSync(DAEMON_FD);
  const mutex = fs.statSync(MUTEX_PATH);
  if (inherited.dev !== mutex.dev || inherited.ino !== mutex.ino || !lockDescriptor(DAEMON_FD)) {
    throw new Error("Antigravity Switch 后台监听未继承有效的锁");
  }
  return DAEMON_FD;
}

function readWatcherInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(PATHS.daemonLock, "utf8"));
    return info.version === 2 ? info : null;
  } catch {
    return null;
  }
}

function writeDaemonRecord(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function requestedScript() {
  try {
    const { script, requestedAt } = JSON.parse(fs.readFileSync(HANDOFF_PATH, "utf8"));
    const age = Date.now() - requestedAt;
    return typeof script === "string" && age >= 0 && age < HANDOFF_SECONDS * 1000 ? script : null;
  } catch {
    return null;
  }
}

function spawnWatcher(mode, fd) {
  const child = spawn(process.execPath, [__filename, mode], {
    detached: true,
    stdio: fd === undefined ? "ignore" : ["ignore", "ignore", "ignore", fd]
  });
  child.on("error", () => {});
  if (!child.pid) throw new Error("无法启动 Antigravity Switch 后台监听");
  child.unref();
  return child.pid;
}

export function ensureBackgroundWatcher({ forPage = false } = {}) {
  const fd = openDaemonLock();
  if (fd === null) {
    const current = readWatcherInfo();
    // A Magpie installation can move to a different directory. The old
    // watcher yields while the new one waits for the same kernel lock.
    if (forPage && current?.script && current.script !== __filename && requestedScript() !== __filename) {
      writeDaemonRecord(HANDOFF_PATH, { script: __filename, requestedAt: Date.now() });
      spawnWatcher(WAIT_FOR_LOCK_FLAG);
    }
    return { started: false, pid: current?.pid || null };
  }
  try {
    return { started: true, pid: spawnWatcher(INHERITED_LOCK_FLAG, fd) };
  } finally {
    fs.closeSync(fd);
  }
}

// Both distribution names use the same existing vault and command format.
export function readPendingCommand(raw) {
  const names = [PLUGIN_NAME, "@magpie-community/page-antigravity-switch"];
  const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw?.items) ? raw.items : [];
  for (const entry of items) {
    const spec = typeof entry?.spec === "string" ? entry.spec : "";
    const localPath = spec.startsWith("file:") ? spec.slice(5) : spec;
    const fromThisDirectory = (path.isAbsolute(localPath) || localPath.startsWith(".")) && path.resolve(localPath) === PLUGIN_DIR;
    if (!fromThisDirectory && !names.some((name) => entry?.name === name || spec.includes(name))) continue;
    const cmd = entry?.options?.cmd || entry?.options?.pendingCommand;
    if (cmd) return cmd;
  }
  for (const name of names) {
    const cmd = raw?.[name]?.cmd || raw?.[name]?.pendingCommand;
    if (cmd) return cmd;
  }
  return null;
}

function startInProcessWatcher(reloadIfChanged) {
  let lastCmdId = null;
  let debounceTimer = null;
  let queue = Promise.resolve();
  let pendingJobs = 0;
  let lastCliRefreshAt = 0;

  const enqueue = (task) => {
    pendingJobs++;
    queue = queue.then(task).catch(() => {
      // Command and cache errors must not stop the watcher.
    }).finally(() => {
      pendingJobs--;
    });
  };

  const triggerBackgroundRefresh = () => {
    if (pendingJobs || Date.now() - lastCliRefreshAt < 60_000) return;
    lastCliRefreshAt = Date.now();
    enqueue(() => refreshCliAccounts({ force: false }));
  };

  const syncFromDisk = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(PATHS.pluginsJson, "utf8"));
      const cmd = readPendingCommand(raw);
      if (cmd?.id && cmd.id !== lastCmdId) {
        lastCmdId = cmd.id;
        const receivedAt = Date.now();
        enqueue(() => executeCommandAsync(cmd, { receivedAt }));
      }
    } catch {
      // Retried after the next file event or periodic sync.
    }
    try {
      syncStateFile();
    } catch {
      // A transient state-file write failure must not stop future recovery.
    }
  };

  const scheduleSync = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(syncFromDisk, 60);
  };

  syncFromDisk();
  const watchedDirs = [
    PATHS.magpieDir,
    path.dirname(PATHS.cliToken),
    path.dirname(PATHS.appStorage)
  ];
  const watchedFiles = new Set([
    "plugins.json", "logins.json", "plugin-auth.json",
    "antigravity-switch-cli-cache.json", "quotas.json",
    "antigravity-oauth-token", "jetski-standalone-oauth-token", "app_storage.json"
  ]);
  const watchers = [];
  for (const dir of new Set(watchedDirs)) {
    try {
      watchers.push(fs.watch(dir, { persistent: true }, (_eventType, filename) => {
        if (watchedFiles.has(filename)) scheduleSync();
      }));
      watchers.at(-1).on("error", () => {
        // The periodic sync also covers removed or unavailable directories.
      });
    } catch {
      // The periodic sync covers directories that do not exist yet.
    }
  }

  const initialRefreshTimer = setTimeout(triggerBackgroundRefresh, 300);
  const interval = setInterval(() => {
    if (!pendingJobs && reloadIfChanged()) return;
    syncFromDisk();
    triggerBackgroundRefresh();
  }, 4000);

  return () => {
    clearTimeout(debounceTimer);
    clearTimeout(initialRefreshTimer);
    clearInterval(interval);
    for (const watcher of watchers) watcher.close();
  };
}

function runDaemon(fd) {
  if (fd === null) return;
  if (requestedScript() === __filename) fs.rmSync(HANDOFF_PATH, { force: true });
  writeDaemonRecord(PATHS.daemonLock, {
    version: 2,
    pid: process.pid,
    signature: INITIAL_SIGNATURE,
    startedAt: new Date().toISOString(),
    script: __filename
  });
  const stop = startInProcessWatcher(() => {
    const next = requestedScript();
    const handoff = next && next !== __filename;
    const signature = getCodeSignature();
    if (!handoff && signature === INITIAL_SIGNATURE) return false;
    if (!handoff && signature !== "unknown") {
      try {
        spawnWatcher(INHERITED_LOCK_FLAG, fd);
      } catch {
        return false;
      }
    }
    stop();
    fs.closeSync(fd);
    return true;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const mode = process.argv[2];
  if (mode === "--once") {
    syncStateFile();
    ensureBackgroundWatcher();
  } else if (mode === DAEMON_FLAG || mode === WAIT_FOR_LOCK_FLAG) {
    runDaemon(openDaemonLock(mode === WAIT_FOR_LOCK_FLAG ? HANDOFF_SECONDS : 0));
  } else if (mode === INHERITED_LOCK_FLAG) {
    runDaemon(inheritedDaemonLock());
  }
}
