/**
 * [INPUT]: core.mjs、插件指令文件与本地文件变更。
 * [OUTPUT]: 后台监听器、去重后的指令执行及页面状态同步。
 * [POS]: Magpie 插件的独立后台进程；按源码签名热重载。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PATHS,
  PLUGIN_NAME,
  executeCommandPayload,
  syncStateFile
} from "./core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORE_PATH = path.join(__dirname, "core.mjs");

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

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  try {
    if (!fs.existsSync(PATHS.daemonLock)) return null;
    return JSON.parse(fs.readFileSync(PATHS.daemonLock, "utf8"));
  } catch {
    return null;
  }
}

function writeLock(pid) {
  fs.mkdirSync(path.dirname(PATHS.daemonLock), { recursive: true });
  fs.writeFileSync(
    PATHS.daemonLock,
    JSON.stringify(
      {
        pid,
        signature: INITIAL_SIGNATURE,
        startedAt: new Date().toISOString(),
        script: __filename
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
}

export function ensureBackgroundWatcher() {
  const existing = readLock();
  const currentSig = getCodeSignature();
  if (existing && isPidAlive(existing.pid)) {
    if (existing.signature === currentSig) {
      return { started: false, pid: existing.pid };
    }
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  const child = spawn(process.execPath, [__filename, "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MAGPIE_AGY_SWITCH_DAEMON: "1" }
  });
  child.unref();
  return { started: true, pid: child.pid };
}

export function startInProcessWatcher() {
  let lastCmdId = null;
  let debounceTimer = null;

  const checkPluginsCommand = () => {
    try {
      if (!fs.existsSync(PATHS.pluginsJson)) return;
      const raw = JSON.parse(fs.readFileSync(PATHS.pluginsJson, "utf8"));
      const items = Array.isArray(raw?.plugins)
        ? raw.plugins
        : Array.isArray(raw?.items)
          ? raw.items
          : [];
      const entry = items.find(
        (it) =>
          it?.name === PLUGIN_NAME ||
          it?.spec?.includes?.(PLUGIN_NAME)
      );
      const cmd = entry?.options?.cmd || entry?.options?.pendingCommand || raw?.[PLUGIN_NAME]?.cmd || raw?.[PLUGIN_NAME]?.pendingCommand;
      if (cmd && cmd.id && cmd.id !== lastCmdId) {
        lastCmdId = cmd.id;
        executeCommandPayload(cmd);
      }
    } catch {
      // ignore transient read errors
    }
  };

  const scheduleSync = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        checkPluginsCommand();
        syncStateFile();
      } catch {
        // ignore
      }
    }, 60);
  };

  syncStateFile();
  checkPluginsCommand();

  const watchedDirs = [
    PATHS.magpieDir,
    path.dirname(PATHS.cliToken),
    path.dirname(PATHS.appStorage)
  ];

  const watchers = [];
  for (const dir of watchedDirs) {
    try {
      if (fs.existsSync(dir)) {
        const watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
          if (!filename || filename.includes(".tmp-")) return;
          if (
            filename === "plugins.json" ||
            filename === "logins.json" ||
            filename === "quotas.json" ||
            filename === "antigravity-oauth-token" ||
            filename === "app_storage.json"
          ) {
            scheduleSync();
          }
        });
        watchers.push(watcher);
      }
    } catch {
      // ignore missing directory
    }
  }

  const interval = setInterval(() => {
    if (process.argv.includes("--daemon") && getCodeSignature() !== INITIAL_SIGNATURE) {
      try {
        const child = spawn(process.execPath, [__filename, "--daemon"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, MAGPIE_AGY_SWITCH_DAEMON: "1" }
        });
        child.unref();
      } catch {
        // ignore
      }
      process.exit(0);
    }
    checkPluginsCommand();
    try {
      syncStateFile();
    } catch {
      // A transient state-file write failure must not stop future recovery.
    }
  }, 4000);

  return () => {
    clearInterval(interval);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
  };
}

if (process.argv.includes("--once")) {
  syncStateFile();
  ensureBackgroundWatcher();
} else if (process.argv.includes("--daemon")) {
  const existing = readLock();
  if (
    existing &&
    existing.pid !== process.pid &&
    isPidAlive(existing.pid) &&
    existing.signature === INITIAL_SIGNATURE
  ) {
    process.exit(0);
  }
  writeLock(process.pid);
  startInProcessWatcher();
}
