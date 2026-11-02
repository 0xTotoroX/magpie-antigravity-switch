/**
 * [INPUT]: 本地凭据、Magpie JSON、macOS security 与 language_server 状态。
 * [OUTPUT]: 账号状态、校验备份、账号操作与无凭据的 page/state.js。
 * [POS]: CLI 与守护进程共用核心；运行身份与待生效凭据分别返回。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PLUGIN_NAME = "magpie-antigravity-switch";
export const PLUGIN_DIR = path.resolve(__dirname, "..");
export const PAGE_DIR = path.join(PLUGIN_DIR, "page");
export const STATE_JS_PATH = path.join(PAGE_DIR, "state.js");

const HOME = os.homedir();
export const PATHS = {
  magpieDir: path.join(HOME, ".config", "magpie"),
  loginsJson: path.join(HOME, ".config", "magpie", "logins.json"),
  quotasJson: path.join(HOME, ".config", "magpie", "quotas.json"),
  pluginsJson: path.join(HOME, ".config", "magpie", "plugins.json"),
  vaultJson: path.join(HOME, ".config", "magpie", "antigravity-switch-vault.json"),
  cliToken: path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  standaloneToken: path.join(HOME, ".gemini", "jetski-standalone-oauth-token"),
  appStorage: path.join(HOME, "Library", "Application Support", "Antigravity", "app_storage.json"),
  devToolsActivePort: path.join(HOME, "Library", "Application Support", "Antigravity", "DevToolsActivePort"),
  mainLog: path.join(HOME, "Library", "Logs", "Antigravity", "main.log"),
  backupRoot: path.join(HOME, "Documents", "Backups-archive", "antigravity"),
  daemonLock: path.join(HOME, ".config", "magpie", "antigravity-switch-daemon.json")
};

const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYCHAIN_PREFIX = "go-keyring-base64:";
const LANGUAGE_SERVER_PATTERN = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";
const RELOAD_WINDOW_MS = 65_000;
const MAX_RELOADS_PER_WINDOW = 2;

function sanitizeErrorMessage(err) {
  const raw = String(err?.message || err || "操作失败");
  const cleaned = raw
    .replace(/go-keyring-base64:[A-Za-z0-9+/=_-]+/g, "[REDACTED]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/1\/\/[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/Command failed:\s*security\s+[^\n]+/gi, "写入 macOS 钥匙串失败");
  const firstLine = cleaned.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "操作失败";
  return firstLine.slice(0, 160);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// 写回前只允许“文件不存在”使用默认值；权限、空文件和损坏内容都必须保留。
function readJsonForUpdate(filePath, fallback, validate) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`无法读取 ${path.basename(filePath)}，已停止写入`);
  }
  try {
    const value = JSON.parse(raw);
    if (!validate(value)) throw new Error("invalid shape");
    return value;
  } catch {
    throw new Error(`${path.basename(filePath)} 格式无效，已保留原文件`);
  }
}

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const readLogins = () => readJsonForUpdate(PATHS.loginsJson, [], Array.isArray);

function writeJsonAtomic(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch {
    // ignore chmod errors
  }
  fs.renameSync(tmpPath, filePath);
}

function writeTextAtomic(filePath, content, mode = 0o644) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch {
    // ignore
  }
  fs.renameSync(tmpPath, filePath);
}

export function readKeychainRaw({ strict = false } = {}) {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.trim();
  } catch (err) {
    // errSecItemNotFound (-25300) is returned by security as exit status 44.
    if (strict && err.status !== 44) {
      throw new Error("无法读取 macOS 钥匙串，已停止备份和凭据替换，请检查访问权限");
    }
    return null;
  }
}

export function parseKeychainSecret(rawSecret) {
  if (!rawSecret || typeof rawSecret !== "string") return null;
  const trimmed = rawSecret.trim();
  const payloadStr = trimmed.startsWith(KEYCHAIN_PREFIX)
    ? Buffer.from(trimmed.slice(KEYCHAIN_PREFIX.length), "base64").toString("utf8")
    : trimmed;
  try {
    const parsed = JSON.parse(payloadStr);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // ignore malformed secret
  }
  return null;
}

export function readKeychainAuth() {
  const raw = readKeychainRaw();
  if (!raw) return null;
  return parseKeychainSecret(raw);
}

export function writeKeychainAuth(payloadObj) {
  const jsonStr = JSON.stringify(payloadObj);
  const encoded = `${KEYCHAIN_PREFIX}${Buffer.from(jsonStr, "utf8").toString("base64")}`;

  const previous = readKeychainRaw({ strict: true });
  // -T "" removes implicit trust for new items. security merges this explicit
  // desktop allowlist with any applications already trusted on existing items.
  const trustedArgs = ["-T", ""];
  if (fs.existsSync(LANGUAGE_SERVER_PATTERN)) trustedArgs.push("-T", LANGUAGE_SERVER_PATTERN);
  const baseArgs = ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT];
  try {
    execFileSync(
      "security",
      [...baseArgs, ...trustedArgs, "-w", encoded],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
  } catch {
    // security can update the data before an ACL update fails. Restore the
    // previous data without widening or replacing the item's existing ACL.
    if (previous !== null) {
      try {
        if (readKeychainRaw() !== previous) {
          execFileSync("security", [...baseArgs, "-w", previous], { stdio: ["ignore", "ignore", "ignore"] });
        }
      } catch {
        throw new Error("钥匙串更新及旧凭据恢复失败，请从本地备份恢复后再切换账号");
      }
    }
    throw new Error(previous === null
      ? "写入 macOS 钥匙串失败，请检查访问权限后重试"
      : "写入 macOS 钥匙串失败，旧凭据已保留，请检查访问权限后重试");
  }
}

function parseExpiryMs(authOrClient) {
  if (!authOrClient) return 0;
  if (typeof authOrClient.expiry_date === "number" && Number.isFinite(authOrClient.expiry_date)) {
    return authOrClient.expiry_date;
  }
  const expiryStr = authOrClient?.token?.expiry || authOrClient?.expiry;
  if (typeof expiryStr === "string") {
    const parsed = Date.parse(expiryStr);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toClientOAuthPayload(email, authRecord, existingClientPayload = null) {
  const accessToken =
    authRecord?.access_token ||
    authRecord?.token?.access_token ||
    existingClientPayload?.token?.access_token ||
    "";
  const refreshToken =
    authRecord?.refresh_token ||
    authRecord?.token?.refresh_token ||
    existingClientPayload?.token?.refresh_token ||
    "";
  const expiryMs =
    parseExpiryMs(authRecord) ||
    parseExpiryMs(existingClientPayload) ||
    Date.now() + 3599 * 1000;
  const expiryIso = new Date(expiryMs).toISOString();
  const expiresIn = Math.max(60, Math.round((expiryMs - Date.now()) / 1000));

  return {
    token: {
      access_token: accessToken,
      token_type: existingClientPayload?.token?.token_type || "Bearer",
      refresh_token: refreshToken,
      expiry: expiryIso,
      expires_in: expiresIn
    },
    auth_method: existingClientPayload?.auth_method || "consumer",
    id_token_email: email
  };
}

function readVault() {
  const defaultVault = {
    version: 1,
    initialBackupPath: null,
    reloadHistory: [],
    lastSwitch: null,
    preferences: {
      onlyPro: true,
      hideIneligible: true
    },
    accounts: {}
  };
  const data = readJsonForUpdate(PATHS.vaultJson, defaultVault, (value) =>
    isRecord(value) && (value.accounts === undefined || isRecord(value.accounts)) &&
    (value.preferences === undefined || isRecord(value.preferences)));
  return {
    ...defaultVault,
    ...data,
    preferences: {
      ...defaultVault.preferences,
      ...(data.preferences && typeof data.preferences === "object" ? data.preferences : {})
    },
    reloadHistory: Array.isArray(data.reloadHistory) ? data.reloadHistory : [],
    accounts: data.accounts && typeof data.accounts === "object" ? data.accounts : {}
  };
}

function saveVault(vault) {
  writeJsonAtomic(PATHS.vaultJson, vault, 0o600);
}

export function ensureInitialBackup() {
  const vault = readVault();
  if (isBackupComplete(vault.initialBackupPath)) {
    return vault.initialBackupPath;
  }

  // Read before recording completion. A denied read is not a missing item.
  const keychainRaw = readKeychainRaw({ strict: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  const backupDir = path.join(PATHS.backupRoot, `initial-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(backupDir, 0o700);
  } catch {
    // ignore
  }

  const files = {};
  if (keychainRaw) {
    writeTextAtomic(path.join(backupDir, "keychain-gemini-antigravity.txt"), `${keychainRaw}\n`, 0o600);
    const parsed = parseKeychainSecret(keychainRaw);
    if (parsed) {
      writeJsonAtomic(path.join(backupDir, "keychain-gemini-antigravity.decoded.json"), parsed, 0o600);
    }
    files["keychain-gemini-antigravity.txt"] = { sha256: fileHash(path.join(backupDir, "keychain-gemini-antigravity.txt")) };
  } else {
    files["keychain-gemini-antigravity.txt"] = { absent: true };
  }

  const filesToCopy = [
    ["antigravity-oauth-token.json", PATHS.cliToken],
    ["jetski-standalone-oauth-token.json", PATHS.standaloneToken],
    ["app_storage.json", PATHS.appStorage],
    ["magpie-logins.json", PATHS.loginsJson]
  ];

  for (const [destName, srcPath] of filesToCopy) {
    let content;
    try {
      content = fs.readFileSync(srcPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`无法备份 ${path.basename(srcPath)}，已停止凭据替换`);
      files[destName] = { absent: true };
      continue;
    }
    const destPath = path.join(backupDir, destName);
    fs.writeFileSync(destPath, content, { mode: 0o600 });
    fs.chmodSync(destPath, 0o600);
    files[destName] = { sha256: fileHash(destPath) };
  }

  writeJsonAtomic(path.join(backupDir, "manifest.json"), {
    version: 1, complete: true, files,
    previousBackupPath: vault.initialBackupPath || null
  });
  vault.initialBackupPath = backupDir;
  saveVault(vault);
  return backupDir;
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isBackupComplete(backupDir) {
  if (!backupDir) return false;
  const manifest = readJsonSafe(path.join(backupDir, "manifest.json"));
  const names = ["keychain-gemini-antigravity.txt", "antigravity-oauth-token.json",
    "jetski-standalone-oauth-token.json", "app_storage.json", "magpie-logins.json"];
  if (manifest?.version !== 1 || manifest.complete !== true) return false;
  return names.every((name) => {
    const entry = manifest.files?.[name];
    if (entry?.absent === true) return true;
    try { return Boolean(entry?.sha256) && fileHash(path.join(backupDir, name)) === entry.sha256; }
    catch { return false; }
  });
}

function getRunningLanguageServerInfo() {
  try {
    const psOut = execFileSync("ps", ["aux"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const line = psOut
      .split("\n")
      .find((l) => l.includes(LANGUAGE_SERVER_PATTERN) && !l.includes("grep"));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const pid = parts[1];
    const csrfMatch = /--csrf_token\s+([a-f0-9-]+)/i.exec(line);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    if (!pid) return null;

    let port = null;
    try {
      const lsofOut = execFileSync(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const portMatch = /:(\d+)\s+\(LISTEN\)/.exec(lsofOut);
      if (portMatch) {
        port = Number(portMatch[1]);
      }
    } catch {
      // ignore
    }
    return { pid: Number(pid), csrf, port };
  } catch {
    return null;
  }
}

function queryLiveLanguageServerQuota() {
  const lsInfo = getRunningLanguageServerInfo();
  if (!lsInfo || !lsInfo.port || !lsInfo.csrf) return null;

  try {
    const out = execFileSync(
      "curl",
      [
        "--noproxy",
        "127.0.0.1,localhost",
        "-ks",
        "--max-time",
        "2",
        "-X",
        "POST",
        `https://127.0.0.1:${lsInfo.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
        "-H",
        "Content-Type: application/json",
        "-H",
        "Connect-Protocol-Version: 1",
        "-H",
        `x-codeium-csrf-token: ${lsInfo.csrf}`,
        "-d",
        "{}"
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const parsed = JSON.parse(out);
    const status = parsed?.userStatus;
    const email = status?.email?.trim?.();
    if (!email) return null;

    const tierName =
      status?.userTier?.name ||
      status?.planStatus?.planInfo?.planName || null;

    const configs = Array.isArray(status?.cascadeModelConfigData?.clientModelConfigs)
      ? status.cascadeModelConfigData.clientModelConfigs
      : [];

    const findModelQuota = (regex) => {
      const found = configs.find((m) => regex.test(m?.label || ""));
      if (!found || !found.quotaInfo) return null;
      const frac =
        typeof found.quotaInfo.remainingFraction === "number"
          ? found.quotaInfo.remainingFraction
          : 0;
      const remaining = Math.max(0, Math.min(100, Math.round(frac * 1000) / 10));
      const used = Math.max(0, Math.min(100, Math.round((100 - remaining) * 10) / 10));
      return {
        used,
        remaining,
        resetsAt: found.quotaInfo.resetTime || null
      };
    };

    const claudeQ = findModelQuota(/claude|sonnet|opus/i);
    const argonQ = findModelQuota(/argon/i);
    const geminiQ = findModelQuota(/gemini\s+3\.8|flash/i);

    const pools = [];
    if (claudeQ) {
      pools.push({
        pool: "Claude & GPT",
        window: "5 hours",
        label: "Claude 5h",
        used: claudeQ.used,
        remaining: claudeQ.remaining,
        resetsAt: claudeQ.resetsAt
      });
    }
    if (argonQ) {
      pools.push({
        pool: "Gemini 4 Argon",
        window: "7 days",
        label: "Argon",
        used: argonQ.used,
        remaining: argonQ.remaining,
        resetsAt: argonQ.resetsAt
      });
    }
    if (geminiQ) {
      pools.push({
        pool: "Gemini",
        window: "5 hours",
        label: "Gemini",
        used: geminiQ.used,
        remaining: geminiQ.remaining,
        resetsAt: geminiQ.resetsAt
      });
    }

    return {
      email,
      plan: tierName,
      quota: {
        plan: tierName,
        updatedAt: Date.now(),
        error: null,
        pools
      }
    };
  } catch {
    return null;
  }
}

export function captureLiveClientAccounts() {
  ensureInitialBackup();
  const vault = readVault();
  let changed = false;

  const upsertFromClient = (payload, sourceName) => {
    const email = payload?.id_token_email?.trim?.();
    const refreshToken = payload?.token?.refresh_token?.trim?.();
    const accessToken = payload?.token?.access_token?.trim?.();
    if (!email || !refreshToken) return;

    const existing = vault.accounts[email] || {};
    const existingExpiry = parseExpiryMs(existing.auth || existing.clientPayload);
    const incomingExpiry = parseExpiryMs(payload);

    const shouldUpdateToken =
      !existing.auth?.refresh_token ||
      incomingExpiry >= existingExpiry ||
      existing.auth?.access_token !== accessToken;

    if (shouldUpdateToken) {
      vault.accounts[email] = {
        ...existing,
        email,
        project: existing.project || "aicode-consumers",
        plan: existing.plan || null,
        capturedFrom: sourceName,
        capturedAt: new Date().toISOString(),
        auth: {
          access_token: accessToken || existing.auth?.access_token || "",
          refresh_token: refreshToken,
          expiry_date: incomingExpiry || existingExpiry || Date.now() + 3600_000,
          project: existing.project || "aicode-consumers"
        },
        clientPayload: toClientOAuthPayload(email, payload, payload)
      };
      changed = true;
    }
  };

  const keychainPayload = readKeychainAuth();
  if (keychainPayload) {
    upsertFromClient(keychainPayload, "desktop-keychain");
  }

  const cliPayload = readJsonSafe(PATHS.cliToken, null);
  if (cliPayload) {
    upsertFromClient(cliPayload, "cli-token");
  }

  const standalonePayload = readJsonSafe(PATHS.standaloneToken, null);
  if (standalonePayload) {
    upsertFromClient(standalonePayload, "standalone-token");
  }

  // Also capture live tier & model quota directly from the running language_server
  const liveLs = queryLiveLanguageServerQuota();
  if (liveLs && liveLs.email) {
    const existing = vault.accounts[liveLs.email] || { email: liveLs.email };
    // 相同额度也要更新时间，才能与其他来源的缓存比较新旧。
    vault.accounts[liveLs.email] = {
      ...existing,
      email: liveLs.email,
      plan: liveLs.plan,
      liveQuota: liveLs.quota
    };
    changed = true;
  }

  if (changed) {
    saveVault(vault);
  }
  return { vault, keychainPayload, cliPayload, standalonePayload, liveLs };
}

function summarizeQuotaEntry(entry) {
  if (!entry || !entry.quota) return null;
  const windows = Array.isArray(entry.quota.windows) ? entry.quota.windows : [];
  const pools = [];
  const desired = [
    { pool: "Claude & GPT", name: "5 hours", label: "Claude 5h" },
    { pool: "Claude & GPT", name: "7 days", label: "Claude 7d" },
    { pool: "Gemini 4 Argon", name: "7 days", label: "Argon" },
    { pool: "Gemini", name: "5 hours", label: "Gemini" }
  ];

  const nowMs = Date.now();
  for (const spec of desired) {
    const win = windows.find((w) => w.pool === spec.pool && w.name === spec.name);
    if (win) {
      const resetMs = win.resetsAt ? Date.parse(win.resetsAt) : 0;
      const isExpired = resetMs > 0 && resetMs <= nowMs;
      if (!Number.isFinite(win.used)) continue;
      const rawUsed = Math.max(0, Math.min(100, win.used));
      const used = Math.round(rawUsed * 10) / 10;
      const remaining = Math.max(0, Math.round((100 - rawUsed) * 10) / 10);
      pools.push({
        pool: spec.pool,
        window: spec.name,
        label: spec.label,
        used,
        remaining,
        stale: isExpired,
        resetsAt: win.resetsAt || null,
        resetSecs: typeof win.resetSecs === "number" ? win.resetSecs : null
      });
    }
  }

  return {
    plan: entry.quota.plan || null,
    updatedAt: entry.at || null,
    error: entry.error || null,
    pools
  };
}

function quotaTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeQuotaSummaries(...summaries) {
  const sources = summaries.filter(Boolean).sort((a, b) => quotaTimestamp(a.updatedAt) - quotaTimestamp(b.updatedAt));
  if (!sources.length) return null;
  const pools = new Map();
  let plan = null;
  for (const source of sources) {
    if (source.error) continue;
    if (source.plan) plan = source.plan;
    for (const pool of source.pools || []) {
      if (!Number.isFinite(pool.remaining)) continue;
      const resetMs = Date.parse(pool.resetsAt);
      pools.set(`${pool.pool}/${pool.window}`, {
        ...pool,
        stale: Boolean(pool.stale || (resetMs > 0 && resetMs <= Date.now())),
        updatedAt: source.updatedAt || null
      });
    }
  }
  return {
    plan, pools: [...pools.values()],
    updatedAt: sources.at(-1).updatedAt || null,
    error: sources.every((s) => s.error) ? sources.at(-1).error : null
  };
}

function getLoginEmail(item) {
  if (!item || typeof item !== "object") return null;
  const raw = item.user || item.email || item.name;
  return typeof raw === "string" && raw.includes("@") ? raw.trim() : null;
}

function isProPlanName(plan) {
  if (!plan || typeof plan !== "string") return false;
  return /pro|ultra|enterprise/i.test(plan);
}

function computeRecommendationScore(account) {
  if (!account.hasCredentials || !account.isEligible) return -1;
  const pools = (account.quota?.pools || []).filter((p) => !p.stale);
  const findRemaining = (labelOrPool) => {
    const windows = pools.filter((p) => p.pool === labelOrPool || p.label === labelOrPool);
    return windows.length ? Math.min(...windows.map((p) => p.remaining)) : null;
  };

  const claudeRem = findRemaining("Claude & GPT") ?? findRemaining("Claude");
  const argonRem = findRemaining("Gemini 4 Argon") ?? findRemaining("Argon");
  const geminiRem = findRemaining("Gemini");

  const proBonus = account.isPro ? 25 : 0;

  if (pools.length > 0) {
    const c = claudeRem ?? 0;
    const a = argonRem ?? 0;
    const g = geminiRem ?? 0;
    const base = c * 0.55 + a * 0.3 + g * 0.15;
    return Math.round((base + proBonus) * 10) / 10;
  }

  return proBonus;
}

function isLanguageServerRunning() {
  return Boolean(getRunningLanguageServerInfo());
}

function inspectElectronRestartState() {
  try {
    if (!fs.existsSync(PATHS.mainLog)) {
      return { restartCount: 0, lastRestartMs: 0, gaveUp: false };
    }
    const raw = fs.readFileSync(PATHS.mainLog, "utf8");
    const lines = raw.trim().split("\n").slice(-120);
    let restartCount = 0;
    let lastRestartMs = 0;
    let gaveUp = false;

    for (const line of lines) {
      const tsMatch = /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\]/.exec(line);
      const tsMs = tsMatch ? Date.parse(tsMatch[1].replace(" ", "T")) : 0;

      if (line.includes("Starting app (") && line.includes("with dynamic port")) {
        restartCount = 0;
        lastRestartMs = 0;
        gaveUp = false;
      } else if (line.includes("Attempting restart ")) {
        const m = /Attempting restart (\d+)\/(\d+)/.exec(line);
        if (m) {
          restartCount = Number(m[1]);
          lastRestartMs = tsMs || Date.now();
          gaveUp = false;
        }
      } else if (line.includes("Language server crashed 3 times in a row. Giving up.")) {
        gaveUp = true;
        lastRestartMs = tsMs || Date.now();
      }
    }

    if (lastRestartMs > 0 && Date.now() - lastRestartMs > 62_000 && !gaveUp) {
      restartCount = 0;
    }

    return { restartCount, lastRestartMs, gaveUp };
  } catch {
    return { restartCount: 0, lastRestartMs: 0, gaveUp: false };
  }
}

export function getFullState() {
  const { vault, keychainPayload, cliPayload, liveLs } = captureLiveClientAccounts();
  const logins = readLogins();
  const quotas = readJsonSafe(PATHS.quotasJson, {});
  const appStorage = readJsonSafe(PATHS.appStorage, {});

  const desktopKeychainEmail = keychainPayload?.id_token_email || null;
  const desktopUiEmail = appStorage?.["jetski.onboarding.lastLoginUsername"] || null;
  const desktopSavedEmail = desktopKeychainEmail || desktopUiEmail || null;
  const lsRunning = Boolean(liveLs) || isLanguageServerRunning();
  const desktopRuntimeEmail = lsRunning ? liveLs?.email || null : null;
  const desktopEmail = lsRunning ? desktopRuntimeEmail : desktopSavedEmail;
  const desktopPending = Boolean(lsRunning && desktopSavedEmail && desktopRuntimeEmail !== desktopSavedEmail);
  const desktopStatus = !lsRunning ? "stopped" : !desktopRuntimeEmail ? "unknown" : desktopPending ? "pending" : "running";
  const cliEmail = cliPayload?.id_token_email || null;

  const antigravityLogins = Array.isArray(logins)
    ? logins.filter((item) => item && item.agent === "antigravity" && getLoginEmail(item))
    : [];

  const magpieFirst = antigravityLogins.find((item) => item.first) || antigravityLogins.find((item) => item.on) || null;
  const magpieFirstEmail = getLoginEmail(magpieFirst);

  const allEmails = new Set();
  for (const item of antigravityLogins) {
    allEmails.add(getLoginEmail(item));
  }
  for (const email of Object.keys(vault.accounts || {})) {
    allEmails.add(email);
  }
  if (desktopEmail) allEmails.add(desktopEmail);
  if (desktopSavedEmail) allEmails.add(desktopSavedEmail);
  if (cliEmail) allEmails.add(cliEmail);

  const accounts = [];
  for (const email of allEmails) {
    const loginEntry = antigravityLogins.find((item) => getLoginEmail(item) === email) || null;
    const vaultEntry = vault.accounts?.[email] || null;
    const quotaEntry = quotas?.[`antigravity/${email}`] || null;
    const magpieQuota = summarizeQuotaEntry(quotaEntry);
    const quotaSummary = mergeQuotaSummaries(magpieQuota, vaultEntry?.liveQuota);

    const hasMagpieAuth = Boolean(loginEntry?.auth?.refresh_token || loginEntry?.auth?.access_token);
    const hasVaultAuth = Boolean(vaultEntry?.auth?.refresh_token || vaultEntry?.clientPayload?.token?.refresh_token);
    const isEligible = Boolean(
      loginEntry?.project ||
      loginEntry?.auth?.project ||
      quotaSummary?.plan ||
      vaultEntry?.plan ||
      !loginEntry
    );

    const rawPlan =
      quotaSummary?.plan ||
      vaultEntry?.plan ||
      loginEntry?.plan ||
      null;

    const isPro = isProPlanName(rawPlan);
    const tierLabel = !isEligible ? "不可用" : isPro ? "Pro 会员" : rawPlan ? "免费版" : "套餐未知";

    const accountObj = {
      email,
      name: getLoginEmail(loginEntry) || email,
      plan: rawPlan,
      tierLabel,
      isPro,
      planKnown: Boolean(rawPlan),
      isEligible,
      hasProject: isEligible,
      project: loginEntry?.project || loginEntry?.auth?.project || vaultEntry?.project || "aicode-consumers",
      inMagpie: Boolean(loginEntry),
      inVault: Boolean(vaultEntry),
      hasCredentials: hasMagpieAuth || hasVaultAuth,
      magpieOn: Boolean(loginEntry?.on),
      magpieFirst: Boolean(loginEntry?.first),
      activeDesktop: lsRunning && desktopRuntimeEmail === email,
      savedDesktop: desktopSavedEmail === email,
      pendingDesktop: desktopPending && desktopSavedEmail === email,
      activeDesktopKeychain: desktopKeychainEmail === email,
      activeDesktopUi: desktopUiEmail === email,
      activeCli: cliEmail === email,
      activeMagpieFirst: magpieFirstEmail === email,
      capturedFrom: vaultEntry?.capturedFrom || null,
      updatedAt: loginEntry?.seen || loginEntry?.updatedAt || vaultEntry?.capturedAt || null,
      quota: quotaSummary,
      score: 0
    };
    accountObj.score = computeRecommendationScore(accountObj);
    accounts.push(accountObj);
  }

  accounts.sort((a, b) => {
    if (a.isPro !== b.isPro) return a.isPro ? -1 : 1;
    if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
    if (a.activeDesktop !== b.activeDesktop) return a.activeDesktop ? -1 : 1;
    if (a.activeCli !== b.activeCli) return a.activeCli ? -1 : 1;
    return b.score - a.score;
  });

  const onlyProPref = Boolean(vault.preferences?.onlyPro);
  const recommended =
    [...accounts]
      .filter((a) => a.hasCredentials && a.isEligible && (!onlyProPref || a.isPro))
      .sort((a, b) => b.score - a.score)[0] ||
    [...accounts]
      .filter((a) => a.hasCredentials && a.isEligible)
      .sort((a, b) => b.score - a.score)[0] ||
    null;

  const lsState = inspectElectronRestartState();

  return {
    generatedAt: new Date().toISOString(),
    preferences: {
      onlyPro: Boolean(vault.preferences?.onlyPro),
      hideIneligible: vault.preferences?.hideIneligible !== false
    },
    counts: {
      total: accounts.length,
      pro: accounts.filter((a) => a.isPro && a.isEligible).length,
      free: accounts.filter((a) => a.planKnown && !a.isPro && a.isEligible).length,
      unknown: accounts.filter((a) => !a.planKnown && a.isEligible).length,
      ineligible: accounts.filter((a) => !a.isEligible).length
    },
    current: {
      desktopEmail,
      desktopRuntimeEmail,
      desktopSavedEmail,
      desktopPending,
      desktopStatus,
      desktopKeychainEmail,
      desktopUiEmail,
      desktopConsistent: (!desktopKeychainEmail || !desktopUiEmail || desktopKeychainEmail === desktopUiEmail) &&
        (!lsRunning || Boolean(desktopRuntimeEmail && desktopRuntimeEmail === desktopSavedEmail)),
      cliEmail,
      magpieFirstEmail,
      desktopRunning: lsRunning
    },
    recommendedEmail: recommended?.email || null,
    backupPath: vault.initialBackupPath || null,
    lastSwitch: vault.lastSwitch || null,
    reloadGuard: {
      recentCount: lsState.restartCount,
      maxPerMinute: MAX_RELOADS_PER_WINDOW,
      canReloadNow: lsState.restartCount < MAX_RELOADS_PER_WINDOW || lsState.gaveUp
    },
    accounts
  };
}

function escapeHtmlAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildStaticIndexHtml(state) {
  const cur = state?.current || {};
  const counts = state?.counts || { pro: 0, free: 0, ineligible: 0 };
  const onlyPro = Boolean(state?.preferences?.onlyPro);
  const subtitle = `Pro 会员 ${counts.pro} 个 · 免费版 ${counts.free} 个${onlyPro ? "（当前仅显示 Pro 会员）" : ""}`;

  const allAccounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const visibleAccounts = allAccounts.filter((acc) => {
    if (acc.activeDesktop) return true;
    if (!acc.isEligible) return false;
    if (onlyPro && !acc.isPro) return false;
    return true;
  });
  const hiddenCount = allAccounts.length - visibleAccounts.length;

  const renderRow = (account) => {
    const isCurrentAll = account.activeDesktop && account.activeCli;
    const isRecommended = account.email === state?.recommendedEmail && !account.activeDesktop;
    const tierClass = !account.isEligible ? "tag-bad" : account.isPro ? "tag-pro" : "tag-free";
    const tags = [
      `<span class="tag ${tierClass}">${escapeHtmlAttr(account.tierLabel || (account.isPro ? "Pro 会员" : "免费版"))}</span>`
    ];
    if (isCurrentAll) {
      tags.push(`<span class="tag tag-active">当前使用中</span>`);
    } else {
      if (account.activeDesktop) tags.push(`<span class="tag tag-active">桌面端</span>`);
      if (account.activeCli) tags.push(`<span class="tag tag-active">CLI</span>`);
    }
    if (isRecommended) {
      tags.push(`<span class="tag tag-pro">推荐</span>`);
    }

    const pools = account.quota?.pools || [];
    const quotaHtml =
      pools.length > 0
        ? pools
            .slice(0, 4)
            .map((p) => {
              const rem = Math.round(p.remaining);
              const cls = rem <= 12 ? "is-low" : rem <= 35 ? "is-warn" : "";
              return `<span class="quota-pill"><span>${escapeHtmlAttr(p.label)}</span><span class="quota-mini-bar"><span class="quota-mini-fill ${cls}" style="width:${Math.max(4, rem)}%"></span></span><strong>${rem}%</strong></span>`;
            })
            .join("")
        : `<span class="quota-pill">${account.isEligible ? "配额正常" : "账号需验证或地区受限"}</span>`;

    const actionsHtml =
      account.hasCredentials && account.isEligible
        ? isCurrentAll
          ? `<button type="button" class="btn btn-ghost" data-action="reload-desktop">刷新窗口</button>`
          : `<button type="button" class="btn btn-primary" data-action="switch-all" data-email="${escapeHtmlAttr(account.email)}">切换</button><button type="button" class="btn btn-ghost" data-action="switch-cli" data-email="${escapeHtmlAttr(account.email)}" title="仅切换 CLI，不打断桌面端窗口">仅 CLI</button>`
        : `<span class="subtitle">不可用</span>`;

    return `
      <div class="account-row ${account.activeDesktop ? "is-current" : ""}">
        <div class="account-main">
          <div class="account-title-line">
            <span class="account-email">${escapeHtmlAttr(account.email)}</span>
            ${tags.join("")}
          </div>
          <div class="quota-line">${quotaHtml}</div>
        </div>
        <div class="account-actions">${actionsHtml}</div>
      </div>`;
  };

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Antigravity 切号</title>
    <link rel="stylesheet" href="style.css" />
    <script src="_magpie/bridge.js"></script>
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div class="title-block">
          <h1>Antigravity 账号切换</h1>
          <p class="subtitle" id="subtitleText">${escapeHtmlAttr(subtitle)}</p>
        </div>
        <div class="toolbar">
          <button type="button" class="btn btn-filter ${onlyPro ? "is-active" : ""}" id="btnTogglePro" title="一键隐藏或显示非 Pro 会员账号">
            ${onlyPro ? "已隐藏非会员" : "隐藏非会员"}
          </button>
          <button type="button" class="btn" id="btnOrganize" title="自动纳管本地 Pro 账号、停用异常账号并置顶会员">
            整理账号
          </button>
          <button type="button" class="btn btn-ghost" id="btnRefresh" title="刷新最新状态">
            刷新
          </button>
        </div>
      </header>

      <div class="toast hidden" id="toastBanner"></div>

      <section class="status-strip" id="statusStrip">
        <div class="status-cell">
          <span class="status-label">桌面端</span>
          <span class="status-email" id="curDesktopEmail">${escapeHtmlAttr(cur.desktopEmail || "未登录")}</span>
          <span class="status-dot ${cur.desktopRunning ? "is-online" : ""}" id="curDesktopDot"></span>
        </div>
        <div class="status-divider"></div>
        <div class="status-cell">
          <span class="status-label">CLI (agy)</span>
          <span class="status-email" id="curCliEmail">${escapeHtmlAttr(cur.cliEmail || "未登录")}</span>
        </div>
        <div class="status-divider"></div>
        <div class="status-cell">
          <span class="status-label">Magpie 首选</span>
          <span class="status-email" id="curMagpieEmail">${escapeHtmlAttr(cur.magpieFirstEmail || "未设置")}</span>
        </div>
      </section>

      <section class="list-section">
        <div class="account-list" id="accountList">${visibleAccounts.map(renderRow).join("\n")}</div>
        <div class="hidden-footer ${hiddenCount > 0 ? "" : "hidden"}" id="hiddenFooter">${
          hiddenCount > 0
            ? `已隐藏 ${hiddenCount} 个非会员或异常账号 · <button type="button" class="link-btn" id="btnShowHidden">显示全部</button>`
            : ""
        }</div>
      </section>
    </main>

    <script src="state.js"></script>
    <script src="app.js"></script>
  </body>
</html>
`;
}

export function syncStateFile() {
  let state;
  try {
    state = getFullState();
  } catch (err) {
    // 保留配置原件，并让页面显式呈现读取失败；下一轮同步可自动恢复。
    state = { generatedAt: new Date().toISOString(), error: sanitizeErrorMessage(err),
      current: {}, accounts: [], counts: { pro: 0, free: 0, unknown: 0, ineligible: 0 } };
  }
  const jsContent = [
    "// Auto-generated by magpie-antigravity-switch (contains no tokens or secrets)",
    `globalThis.__AGY_SWITCH_STATE__ = ${JSON.stringify(state, null, 2)};`,
    "if (typeof globalThis.__AGY_SWITCH_ON_STATE__ === 'function') {",
    "  globalThis.__AGY_SWITCH_ON_STATE__(globalThis.__AGY_SWITCH_STATE__);",
    "}",
    ""
  ].join("\n");
  writeTextAtomic(STATE_JS_PATH, jsContent, 0o644);
  return state;
}

function resolveAccountCredentials(email) {
  const { vault } = captureLiveClientAccounts();
  const logins = readLogins();
  const loginEntry = Array.isArray(logins)
    ? logins.find((item) => item && item.agent === "antigravity" && getLoginEmail(item) === email)
    : null;
  const vaultEntry = vault.accounts?.[email] || null;

  const loginExpiry = parseExpiryMs(loginEntry?.auth);
  const vaultExpiry = parseExpiryMs(vaultEntry?.auth || vaultEntry?.clientPayload);

  let chosenAuth = null;
  if (loginEntry?.auth?.refresh_token && vaultEntry?.auth?.refresh_token) {
    chosenAuth = loginExpiry >= vaultExpiry ? loginEntry.auth : vaultEntry.auth;
  } else if (loginEntry?.auth?.refresh_token) {
    chosenAuth = loginEntry.auth;
  } else if (vaultEntry?.auth?.refresh_token) {
    chosenAuth = vaultEntry.auth;
  } else if (vaultEntry?.clientPayload?.token?.refresh_token) {
    chosenAuth = vaultEntry.clientPayload.token;
  }

  if (!chosenAuth) {
    throw new Error(`未找到账号 ${email} 的可用 OAuth 凭证`);
  }

  const clientPayload = toClientOAuthPayload(email, chosenAuth, vaultEntry?.clientPayload);
  return {
    email,
    clientPayload,
    loginEntry,
    vaultEntry
  };
}

export function importAccountToMagpie(email) {
  const logins = readLogins();
  const { vault } = captureLiveClientAccounts();
  const vaultEntry = vault.accounts?.[email];
  if (!vaultEntry || !vaultEntry.auth?.refresh_token) {
    throw new Error(`未找到账号 ${email} 的凭证`);
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const existingIdx = logins.findIndex(
    (item) => item && item.agent === "antigravity" && getLoginEmail(item) === email
  );
  const newAuth = {
    access_token: vaultEntry.auth.access_token || "",
    refresh_token: vaultEntry.auth.refresh_token,
    expiry_date: vaultEntry.auth.expiry_date || Date.now() + 3599_000,
    project: vaultEntry.project || "aicode-consumers"
  };

  if (existingIdx >= 0) {
    logins[existingIdx] = {
      ...logins[existingIdx],
      user: email,
      seen: nowIso,
      on: true,
      plan: vaultEntry.plan || logins[existingIdx].plan || undefined,
      project: logins[existingIdx].project || vaultEntry.project || "aicode-consumers",
      auth: {
        ...(logins[existingIdx].auth || {}),
        ...newAuth
      }
    };
  } else {
    logins.push({
      id: crypto.randomBytes(8).toString("hex"),
      agent: "antigravity",
      user: email,
      seen: nowIso,
      on: true,
      ...(vaultEntry.plan ? { plan: vaultEntry.plan } : {}),
      project: vaultEntry.project || "aicode-consumers",
      auth: newAuth
    });
  }

  writeJsonAtomic(PATHS.loginsJson, logins, 0o600);
  const state = syncStateFile();
  return {
    ok: true,
    action: "import-magpie",
    email,
    message: `已将 ${email} 同步至 Magpie`,
    state
  };
}

export function setPreferences(patch = {}) {
  const vault = readVault();
  vault.preferences = {
    ...vault.preferences,
    ...patch
  };
  saveVault(vault);
  const state = syncStateFile();
  const modeText = vault.preferences.onlyPro ? "已开启「仅显示 Pro 会员」" : "已显示全部可用账号";
  return {
    ok: true,
    action: "set-preferences",
    message: modeText,
    state
  };
}

export function organizeAccounts({ onlyPro } = {}) {
  const logins = readLogins();
  const { vault } = captureLiveClientAccounts();
  const quotas = readJsonSafe(PATHS.quotasJson, {});

  let importedCount = 0;
  let disabledCount = 0;

  if (Array.isArray(logins)) {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    // 1. Ensure all vault Pro accounts are imported into Magpie logins.json
    for (const [email, vEntry] of Object.entries(vault.accounts || {})) {
      if (!vEntry?.auth?.refresh_token) continue;
      const plan = mergeQuotaSummaries(summarizeQuotaEntry(quotas?.[`antigravity/${email}`]), vEntry.liveQuota)?.plan || vEntry.plan;
      if (!isProPlanName(plan)) continue;
      const exists = logins.some((item) => item && item.agent === "antigravity" && getLoginEmail(item) === email);
      if (!exists) {
        logins.push({
          id: crypto.randomBytes(8).toString("hex"),
          agent: "antigravity",
          user: email,
          seen: nowIso,
          on: true,
          plan,
          project: vEntry.project || "aicode-consumers",
          auth: {
            access_token: vEntry.auth.access_token || "",
            refresh_token: vEntry.auth.refresh_token,
            expiry_date: vEntry.auth.expiry_date || Date.now() + 3599_000,
            project: vEntry.project || "aicode-consumers"
          }
        });
        importedCount++;
      }
    }

    // 2. Disable ineligible/unverified accounts & enrich plan labels
    for (const item of logins) {
      if (!item || item.agent !== "antigravity") continue;
      const email = getLoginEmail(item);
      if (!email) continue;
      const qEntry = quotas?.[`antigravity/${email}`];
      const vEntry = vault.accounts?.[email];
      const plan = mergeQuotaSummaries(summarizeQuotaEntry(qEntry), vEntry?.liveQuota)?.plan || vEntry?.plan || item.plan || null;
      if (plan) {
        item.plan = plan;
      }
      const hasProject = Boolean(item.project || item.auth?.project || plan);
      if (!hasProject) {
        if (item.on) {
          item.on = false;
          disabledCount++;
        }
        delete item.first;
      }
    }

    // 3. Sort antigravity accounts inside logins.json: Pro first, then eligible free, then ineligible
    const agyItems = logins.filter((item) => item && item.agent === "antigravity");
    const otherItems = logins.filter((item) => !item || item.agent !== "antigravity");
    agyItems.sort((a, b) => {
      const aPro = isProPlanName(a.plan);
      const bPro = isProPlanName(b.plan);
      if (aPro !== bPro) return aPro ? -1 : 1;
      const aElig = Boolean(a.project || a.auth?.project);
      const bElig = Boolean(b.project || b.auth?.project);
      if (aElig !== bElig) return aElig ? -1 : 1;
      return 0;
    });

    writeJsonAtomic(PATHS.loginsJson, [...otherItems, ...agyItems], 0o600);
  }

  const updatedVault = readVault();
  updatedVault.preferences = {
    ...updatedVault.preferences,
    hideIneligible: true,
    ...(typeof onlyPro === "boolean" ? { onlyPro } : {})
  };
  saveVault(updatedVault);

  const state = syncStateFile();
  const details = [];
  if (importedCount > 0) details.push(`纳管 ${importedCount} 个本地 Pro 账号`);
  if (disabledCount > 0) details.push(`停用 ${disabledCount} 个异常账号`);
  details.push(`共 ${state.counts.pro} 个 Pro 会员置顶`);

  return {
    ok: true,
    action: "organize",
    message: `整理完成：${details.join("，")}`,
    state
  };
}

function getCdpPageTarget() {
  try {
    if (!fs.existsSync(PATHS.devToolsActivePort)) return null;
    const lines = fs.readFileSync(PATHS.devToolsActivePort, "utf8").trim().split("\n");
    const cdpPort = Number(lines[0]);
    if (!cdpPort) return null;
    const out = execFileSync("curl", ["--noproxy", "127.0.0.1,localhost", "-s", "--max-time", "1", `http://127.0.0.1:${cdpPort}/json/list`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const list = JSON.parse(out);
    if (!Array.isArray(list)) return null;
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    return page ? { cdpPort, page } : null;
  } catch {
    return null;
  }
}

function injectSmoothTransitionOverlaySync(targetEmail) {
  const cdp = getCdpPageTarget();
  if (!cdp?.page?.webSocketDebuggerUrl) return null;

  let savedRoute = "/";
  try {
    const parsedUrl = new URL(cdp.page.url);
    if (parsedUrl.protocol === "https:" && parsedUrl.hostname === "127.0.0.1") {
      savedRoute = `${parsedUrl.pathname || "/"}${parsedUrl.search || ""}`;
    }
  } catch {
    // ignore
  }

  const overlayCode = `
    (() => {
      try {
        const existing = document.getElementById("__agy_switch_overlay__");
        if (existing) existing.remove();
        const el = document.createElement("div");
        el.id = "__agy_switch_overlay__";
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(19,19,19,0.92);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#f5f5f7;font-family:system-ui,-apple-system,sans-serif;transition:opacity 0.2s ease;";
        el.innerHTML = '<div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.14);border-top-color:#60a5fa;border-radius:50%;animation:agySpin 0.8s linear infinite;margin-bottom:14px;"></div>' +
          '<div style="font-size:15px;font-weight:600;letter-spacing:0.2px;">正在切换至 ${String(targetEmail || "").replace(/['"<>]/g, "")}</div>' +
          '<div style="font-size:12px;color:rgba(255,255,255,0.58);margin-top:6px;">正在同步桌面端服务，界面将在就绪后自动刷新…</div>' +
          '<style>@keyframes agySpin{to{transform:rotate(360deg)}}</style>';
        document.body.appendChild(el);
      } catch {}
    })()
  `;

  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `
        const ws = new WebSocket(${JSON.stringify(cdp.page.webSocketDebuggerUrl)});
        const timer = setTimeout(() => process.exit(0), 600);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: ${JSON.stringify(overlayCode)} }
          }));
        };
        ws.onmessage = () => {
          clearTimeout(timer);
          ws.close();
          process.exit(0);
        };
        ws.onerror = () => process.exit(0);
        `
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 800 }
    );
  } catch {
    // ignore
  }

  return savedRoute;
}

function spawnDesktopRecoveryWatcher(oldPid, savedRoute = "/") {
  const helperScript = `
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const oldPid = ${Number(oldPid) || 0};
    const savedRoute = ${JSON.stringify(savedRoute || "/")};
    const devToolsPortFile = ${JSON.stringify(PATHS.devToolsActivePort)};
    const lsPattern = ${JSON.stringify(LANGUAGE_SERVER_PATTERN)};

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function findNewLsPort() {
      try {
        const psOut = execFileSync("ps", ["aux"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const line = psOut.split("\\n").find((l) => l.includes(lsPattern) && !l.includes("grep"));
        if (!line) return null;
        const pid = Number(line.trim().split(/\\s+/)[1]);
        if (!pid || pid === oldPid) return null;
        const lsofOut = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        });
        const m = /:(\\d+)\\s+\\(LISTEN\\)/.exec(lsofOut);
        return m ? Number(m[1]) : null;
      } catch {
        return null;
      }
    }

    function isUiHttpReady(port) {
      try {
        const code = execFileSync("curl", ["--noproxy", "127.0.0.1,localhost", "-ks", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "1", \`https://127.0.0.1:\${port}/\`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        return code === "200";
      } catch {
        return false;
      }
    }

    async function ensureWindowLoaded(port) {
      if (!fs.existsSync(devToolsPortFile)) return;
      const cdpPort = Number(fs.readFileSync(devToolsPortFile, "utf8").trim().split("\\n")[0]);
      if (!cdpPort) return;
      const listRaw = execFileSync("curl", ["--noproxy", "127.0.0.1,localhost", "-s", "--max-time", "1", \`http://127.0.0.1:\${cdpPort}/json/list\`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      const list = JSON.parse(listRaw);
      const page = Array.isArray(list) ? list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) : null;
      if (!page) return;

      const targetUrl = \`https://127.0.0.1:\${port}\${savedRoute.startsWith("/") ? savedRoute : "/"}\`;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1200);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression: "location.href + '|' + (document.body ? document.body.innerText.length : 0)",
              returnByValue: true
            }
          }));
        };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
              const val = String(msg.result?.result?.value || "");
              const [href, lenStr] = val.split("|");
              const textLen = Number(lenStr) || 0;
              if (!href.includes(\`127.0.0.1:\${port}\`) || href.startsWith("chrome-error:") || textLen < 10) {
                ws.send(JSON.stringify({
                  id: 2,
                  method: "Page.navigate",
                  params: { url: targetUrl }
                }));
              } else {
                clearTimeout(t);
                ws.close();
                resolve();
              }
            } else if (msg.id === 2) {
              clearTimeout(t);
              ws.close();
              resolve();
            }
          } catch {
            clearTimeout(t);
            ws.close();
            resolve();
          }
        };
        ws.onerror = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }

    (async () => {
      let port = null;
      for (let i = 0; i < 45; i++) {
        await sleep(300);
        port = findNewLsPort();
        if (port && isUiHttpReady(port)) {
          break;
        }
      }
      if (port) {
        await sleep(400);
        await ensureWindowLoaded(port);
      }
      process.exit(0);
    })();
  `;

  try {
    const child = spawn(process.execPath, ["-e", helperScript], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // ignore
  }
}

export function reloadDesktopLanguageServer(targetEmail = "") {
  const lsState = inspectElectronRestartState();
  const lsInfo = getRunningLanguageServerInfo();

  // Case 1: Electron previously hit 3/3 crashes and gave up (window is stuck on black screen)
  if (!lsInfo && fs.existsSync(PATHS.devToolsActivePort)) {
    try {
      execFileSync("killall", ["Antigravity"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // ignore
    }
    try {
      execFileSync("open", ["-a", "/Applications/Antigravity.app"], { stdio: ["ignore", "ignore", "ignore"] });
      return {
        reloaded: true,
        reason: "检测到桌面端服务曾停止响应，已自动重启 Antigravity 恢复界面"
      };
    } catch {
      // ignore
    }
  }

  if (!lsInfo) {
    return {
      reloaded: false,
      reason: "桌面端当前未运行，凭证已就绪，打开即生效"
    };
  }

  // Case 2: Prevent hitting Electron's 3-restarts-in-60s permanent kill limit
  if (lsState.restartCount >= MAX_RELOADS_PER_WINDOW) {
    const elapsed = Date.now() - lsState.lastRestartMs;
    const waitSecs = Math.max(5, Math.ceil((62_000 - elapsed) / 1000));
    return {
      reloaded: false,
      reason: `凭证已切换。为避免桌面端黑屏保护，请隔 ${waitSecs} 秒后再连续切号`
    };
  }

  try {
    const savedRoute = injectSmoothTransitionOverlaySync(targetEmail);
    execFileSync("kill", ["-TERM", String(lsInfo.pid)], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    spawnDesktopRecoveryWatcher(lsInfo.pid, savedRoute || "/");

    const vault = readVault();
    const now = Date.now();
    vault.reloadHistory = [...(vault.reloadHistory || []).filter((ts) => now - ts < RELOAD_WINDOW_MS), now];
    saveVault(vault);

    return {
      reloaded: true,
      reason: "桌面端平滑重载中（约 5 秒自动完成刷新）"
    };
  } catch (err) {
    return {
      reloaded: false,
      reason: `桌面端重载失败: ${sanitizeErrorMessage(err)}`
    };
  }
}

export function switchAccount({
  email,
  target = "all",
  reloadDesktop = false,
  syncMagpie = true
} = {}) {
  if (!email || typeof email !== "string") {
    throw new Error("请指定要切换的目标邮箱账号");
  }

  if (!["all", "desktop", "cli"].includes(target)) throw new Error("无效切换目标，请使用 all、desktop 或 cli");
  // 在任何凭据写入前检查所有会写回的配置。
  if (syncMagpie) readLogins();
  const appStorage = (target === "all" || target === "desktop")
    ? readJsonForUpdate(PATHS.appStorage, {}, isRecord) : null;

  ensureInitialBackup();
  captureLiveClientAccounts();

  const { clientPayload } = resolveAccountCredentials(email);
  const updatedTargets = [];

  if (target === "all" || target === "desktop") {
    writeKeychainAuth(clientPayload);
    if (appStorage && typeof appStorage === "object") {
      appStorage["jetski.onboarding.lastLoginUsername"] = email;
      writeJsonAtomic(PATHS.appStorage, appStorage, 0o600);
    }
    updatedTargets.push("桌面端");
  }

  if (target === "all" || target === "cli") {
    writeJsonAtomic(PATHS.cliToken, clientPayload, 0o600);
    writeJsonAtomic(PATHS.standaloneToken, clientPayload, 0o600);
    updatedTargets.push("CLI");
  }

  if (syncMagpie) {
    const logins = readLogins();
    if (Array.isArray(logins)) {
      const hasAccountInMagpie = logins.some(
        (item) => item && item.agent === "antigravity" && getLoginEmail(item) === email
      );
      if (hasAccountInMagpie) {
        for (const item of logins) {
          if (item && item.agent === "antigravity") {
            if (getLoginEmail(item) === email) {
              item.first = true;
              item.on = true;
            } else if (item.first) {
              delete item.first;
            }
          }
        }
        writeJsonAtomic(PATHS.loginsJson, logins, 0o600);
        updatedTargets.push("Magpie");
      }
    }
  }

  let reloadResult = null;
  if (reloadDesktop && (target === "all" || target === "desktop")) {
    reloadResult = reloadDesktopLanguageServer(email);
  }

  const vault = readVault();
  vault.accounts[email] = {
    ...(vault.accounts[email] || {}),
    email,
    project: vault.accounts[email]?.project || "aicode-consumers",
    capturedAt: new Date().toISOString(),
    auth: {
      access_token: clientPayload.token.access_token,
      refresh_token: clientPayload.token.refresh_token,
      expiry_date: parseExpiryMs(clientPayload),
      project: vault.accounts[email]?.project || "aicode-consumers"
    },
    clientPayload
  };

  const summaryMsg = [
    `已保存 ${email} 的登录设置（${updatedTargets.join(" + ")}）`,
    reloadResult?.reason ? `· ${reloadResult.reason}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  vault.lastSwitch = {
    id: `${Date.now()}`,
    at: new Date().toISOString(),
    email,
    target,
    reloadDesktop: Boolean(reloadDesktop),
    reloaded: Boolean(reloadResult?.reloaded),
    ok: true,
    message: summaryMsg
  };
  saveVault(vault);

  const state = syncStateFile();
  const pending = (target === "all" || target === "desktop") &&
    (Boolean(state.error) || (state.current.desktopRunning && state.current.desktopRuntimeEmail !== email));
  return {
    ok: true,
    pending,
    email,
    target,
    reloadResult,
    message: pending ? `${summaryMsg} · 桌面端待生效` : summaryMsg,
    state
  };
}

export function executeCommandPayload(cmd) {
  if (!cmd || typeof cmd !== "object" || !cmd.id) return null;
  if (typeof cmd.ts === "number" && Math.abs(Date.now() - cmd.ts) > 30_000) {
    return null;
  }
  const vault = readVault();
  if (vault.lastExecutedCmdId === cmd.id || vault.lastSwitch?.cmdId === cmd.id) {
    return null;
  }

  try {
    let result;
    if (cmd.type === "switch") {
      result = switchAccount({
        email: cmd.email,
        target: cmd.target || "all",
        reloadDesktop: Boolean(cmd.reloadDesktop),
        syncMagpie: cmd.syncMagpie !== false
      });
    } else if (cmd.type === "import-magpie") {
      result = importAccountToMagpie(cmd.email);
    } else if (cmd.type === "organize") {
      result = organizeAccounts({ onlyPro: cmd.onlyPro });
    } else if (cmd.type === "set-preferences") {
      result = setPreferences(cmd.preferences || {});
    } else if (cmd.type === "reload-desktop") {
      const reloadRes = reloadDesktopLanguageServer(getFullState().current.desktopSavedEmail || "");
      result = {
        ok: reloadRes.reloaded,
        email: getFullState().current.desktopEmail,
        message: reloadRes.reason
      };
    } else if (cmd.type === "refresh") {
      const state = syncStateFile();
      if (state.error) throw new Error(state.error);
      result = {
        ok: true,
        email: state.current.desktopEmail,
        message: "已同步最新账号与配额状态"
      };
    } else {
      return null;
    }

    const updatedVault = readVault();
    updatedVault.lastExecutedCmdId = cmd.id;
    updatedVault.lastSwitch = {
      ...(updatedVault.lastSwitch || {}),
      cmdId: cmd.id,
      at: new Date().toISOString(),
      email: cmd.email || result?.email || null,
      ok: result?.ok !== false,
      message: result?.message || "操作完成"
    };
    saveVault(updatedVault);
    syncStateFile();
    return result;
  } catch (err) {
    const cleanMsg = sanitizeErrorMessage(err);
    const updatedVault = readVault();
    updatedVault.lastExecutedCmdId = cmd.id;
    updatedVault.lastSwitch = {
      cmdId: cmd.id,
      at: new Date().toISOString(),
      email: cmd.email || null,
      ok: false,
      message: cleanMsg
    };
    saveVault(updatedVault);
    syncStateFile();
    return {
      ok: false,
      error: cleanMsg
    };
  }
}
