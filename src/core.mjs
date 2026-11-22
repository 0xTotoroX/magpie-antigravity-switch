/**
 * [INPUT]: Magpie logins/plugin-auth/配额 JSON、隔离 agyHome 令牌、macOS security 与 language_server 登录身份。
 * [OUTPUT]: Magpie 单一来源（兼容 legacy antigravity、plugin:antigravity 与 plugin:agy-cli）的套餐、配额窗口及其读数时间、会员分类、登录状态、校验备份、账号操作与无凭据的 page/state.js。
 * [POS]: CLI 与守护进程共用核心；状态脚本供 page/app.js 渲染，运行身份与待生效凭据分别返回。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
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
  pluginAuthJson: path.join(HOME, ".config", "magpie", "plugin-auth.json"),
  quotasJson: path.join(HOME, ".config", "magpie", "quotas.json"),
  pluginsJson: path.join(HOME, ".config", "magpie", "plugins.json"),
  vaultJson: path.join(HOME, ".config", "magpie", "antigravity-switch-vault.json"),
  cliQuotaCache: path.join(HOME, ".config", "magpie", "antigravity-switch-cli-cache.json"),
  cliToken: path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  standaloneToken: path.join(HOME, ".gemini", "jetski-standalone-oauth-token"),
  appStorage: path.join(HOME, "Library", "Application Support", "Antigravity", "app_storage.json"),
  devToolsActivePort: path.join(HOME, "Library", "Application Support", "Antigravity", "DevToolsActivePort"),
  mainLog: path.join(HOME, "Library", "Logs", "Antigravity", "main.log"),
  backupRoot: path.join(HOME, "Documents", "Backups-archive", "antigravity"),
  daemonLock: path.join(HOME, ".config", "magpie", "antigravity-switch-daemon.json")
};

const SUPPORTED_LOGIN_AGENTS = ["plugin:agy-cli", "plugin:antigravity", "antigravity"];
const QUOTA_PROVIDER_PREFIXES = ["agy-cli", "antigravity"];
const AGY_HOME_ID = /^[a-z0-9]{8,32}$/;
const CLI_QUOTA_TTL_MS = 15 * 60_000;
const CLI_BACKOFF_FIRST_MS = 5 * 60_000;
const CLI_BACKOFF_MAX_MS = 60 * 60_000;
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYCHAIN_PREFIX = "go-keyring-base64:";
const AGY_VERSION_TTL_MS = 60_000;
const DESKTOP_APP = "/Applications/Antigravity.app";
const DESKTOP_EXECUTABLE = `${DESKTOP_APP}/Contents/MacOS/Antigravity`;
const LANGUAGE_SERVER_PATTERN = `${DESKTOP_APP}/Contents/Resources/bin/language_server`;
const RELOAD_WINDOW_MS = 65_000;
const MAX_RELOADS_PER_WINDOW = 2;

function sanitizeErrorMessage(err) {
  const baseMsg = String(err?.message || err || "操作失败");
  const causeDetail = err?.cause?.code || err?.cause?.message || "";
  const raw = causeDetail && !baseMsg.includes(causeDetail) ? `${baseMsg} (${causeDetail})` : baseMsg;
  const cleaned = raw
    .replace(/go-keyring-base64:[A-Za-z0-9+/=_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
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
function readJsonSnapshot(filePath, fallback, validate) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return { value: fallback, raw: null };
    throw new Error(`无法读取 ${path.basename(filePath)}，已停止写入`);
  }
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!validate(value)) throw new Error("invalid shape");
    return { value, raw };
  } catch {
    throw new Error(`${path.basename(filePath)} 格式无效，已保留原文件`);
  }
}

function readJsonForUpdate(filePath, fallback, validate) {
  return readJsonSnapshot(filePath, fallback, validate).value;
}

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const readLogins = () => readJsonForUpdate(PATHS.loginsJson, [], Array.isArray);
const readPluginAuth = () => readJsonForUpdate(PATHS.pluginAuthJson, {}, isRecord);
const readCliQuotaCache = () => {
  const data = readJsonForUpdate(
    PATHS.cliQuotaCache,
    { version: 1, accounts: {} },
    (value) => isRecord(value) && (value.accounts === undefined || isRecord(value.accounts))
  );
  return {
    version: 1,
    ...data,
    accounts: isRecord(data?.accounts) ? data.accounts : {}
  };
};

function saveCliQuotaCache(cache) {
  writeJsonAtomic(
    PATHS.cliQuotaCache,
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts: isRecord(cache?.accounts) ? cache.accounts : {}
    },
    0o600
  );
}

function normalizeEmail(value) {
  return typeof value === "string" && value.includes("@") ? value.trim() : null;
}

function getAgyAccountsDir() {
  const stateBase =
    (typeof process !== "undefined" && process.env?.XDG_STATE_HOME) ||
    path.join(HOME, ".local", "state");
  return path.join(stateBase, "magpie-agy-bridge", "accounts");
}

function agyHomeTokenPath(agyHome) {
  if (typeof agyHome !== "string" || !AGY_HOME_ID.test(agyHome)) return null;
  return path.join(getAgyAccountsDir(), agyHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function isSupportedLoginAgent(agent) {
  return typeof agent === "string" && SUPPORTED_LOGIN_AGENTS.includes(agent);
}

function isPluginLoginAgent(agent) {
  return agent === "plugin:agy-cli" || agent === "plugin:antigravity";
}

function isMagpieAgyCliLogin(item, pluginAuth) {
  return item?.agent === "plugin:agy-cli" && !item.hidden &&
    isRecord(pluginAuth[getLoginHomeKey(item)]);
}

function getLoginHomeKey(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.home === "string" && item.home.trim()) return item.home.trim();
  if (item.agent === "plugin:antigravity") return "antigravity";
  if (item.agent === "plugin:agy-cli") return "agy-cli";
  return null;
}

function isRelevantPluginAuthKey(key) {
  return (
    key === "antigravity" ||
    key.startsWith("antigravity#") ||
    key === "agy-cli" ||
    key.startsWith("agy-cli#")
  );
}

function jsonText(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function writeJsonAtomic(filePath, data, mode = 0o600) {
  writeTextAtomic(filePath, jsonText(data), mode);
}

function writeTextAtomic(filePath, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* Best-effort cleanup. */ }
    throw err;
  }
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
  // Existing items already own their access policy. Passing -T even with the
  // same allowlist invokes SecKeychainItemSetAccess and prompts on every switch.
  // Only new items need an explicit allowlist; -T "" removes creator trust.
  const trustedArgs = [];
  if (previous === null) {
    trustedArgs.push("-T", "");
    if (fs.existsSync(LANGUAGE_SERVER_PATTERN)) trustedArgs.push("-T", LANGUAGE_SERVER_PATTERN);
  }
  const baseArgs = ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT];
  let wrote = false;
  try {
    execFileSync(
      "security",
      [...baseArgs, ...trustedArgs, "-w", encoded],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    wrote = true;
    if (readKeychainRaw({ strict: true }) !== encoded) {
      throw new Error("macOS 钥匙串未确认目标账号，请检查登录状态后重试");
    }
  } catch (err) {
    // Preserve the existing item's access policy even when restoration is needed.
    if (previous !== null) {
      try {
        if (readKeychainRaw() !== previous) {
          execFileSync("security", [...baseArgs, "-w", previous], { stdio: ["ignore", "ignore", "ignore"] });
          if (readKeychainRaw({ strict: true }) !== previous) throw new Error("恢复后校验失败");
        }
      } catch {
        throw new Error("钥匙串更新及旧凭据恢复失败，请从本地备份恢复后再切换账号");
      }
    }
    if (wrote) throw err;
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

function findAppProcess(executable, column = "comm") {
  const processes = execFileSync("ps", ["-axww", "-o", `pid=,${column}=`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000
  });
  for (const line of processes.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const command = match[2].trim();
    if (command === executable || (column === "args" && command.startsWith(`${executable} `))) {
      return { pid: Number(match[1]), command };
    }
  }
  return null;
}

function getRunningLanguageServerInfo() {
  try {
    const ls = findAppProcess(LANGUAGE_SERVER_PATTERN, "args");
    if (!ls) return null;
    const { pid, command } = ls;
    const csrf = /(?:^|\s)--csrf_token(?:=|\s+)([a-f0-9-]+)/i.exec(command)?.[1] || null;

    let port = null;
    try {
      const lsofOut = execFileSync(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }
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

function queryLiveLanguageServerIdentity() {
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

    // 本地接口只确认运行身份；套餐与窗口额度统一由 Magpie 提供。
    return { email };
  } catch {
    return null;
  }
}

function extractPluginCredential(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "oauth" && typeof entry.refresh === "string") {
    const parts = entry.refresh.split("|");
    const refreshToken = (parts[0] || "").trim();
    if (!refreshToken) return null;
    const project = (parts[1] || "").trim() || null;
    const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
    const expiryRaw = Number(entry.expires);
    const expiryDate = Number.isFinite(expiryRaw) && expiryRaw > 0 ? expiryRaw : 0;
    const email = normalizeEmail(entry.accountId || entry.metadata?.email);
    const auth = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: expiryDate,
      ...(project ? { project } : {})
    };
    return {
      email,
      project,
      auth,
      clientPayload: email ? toClientOAuthPayload(email, auth) : null,
      agyHome: null,
      source: "magpie-plugin-auth"
    };
  }

  const metaEmail = normalizeEmail(entry.metadata?.email || entry.accountId);
  const rawHome = entry.metadata?.agyHome;
  const agyHome = typeof rawHome === "string" && AGY_HOME_ID.test(rawHome) ? rawHome : null;
  if (!agyHome) {
    return metaEmail
      ? { email: metaEmail, project: null, auth: null, clientPayload: null, agyHome: null, source: "agy-cli-default" }
      : null;
  }

  const tokenPath = agyHomeTokenPath(agyHome);
  const payload = tokenPath ? readJsonSafe(tokenPath, null) : null;
  const email = normalizeEmail(payload?.id_token_email) || metaEmail;
  const refreshToken =
    typeof payload?.token?.refresh_token === "string" ? payload.token.refresh_token.trim() : "";
  if (!refreshToken) {
    return email
      ? { email, project: null, auth: null, clientPayload: null, agyHome, source: "agy-cli-home" }
      : null;
  }
  const accessToken =
    typeof payload?.token?.access_token === "string" ? payload.token.access_token.trim() : "";
  const expiryDate = parseExpiryMs(payload);
  const auth = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate
  };
  return {
    email,
    project: null,
    auth,
    clientPayload: email ? toClientOAuthPayload(email, payload, payload) : payload,
    agyHome,
    source: "agy-cli-home"
  };
}

function readPluginCredentials(pluginAuth) {
  const credentials = new Map();
  for (const [key, entry] of Object.entries(pluginAuth)) {
    if (!isRelevantPluginAuthKey(key)) continue;
    const credential = extractPluginCredential(entry);
    if (credential) credentials.set(key, credential);
  }
  return credentials;
}

export function captureLiveClientAccounts() {
  ensureInitialBackup();
  const vault = readVault();
  let changed = false;

  const upsertTokenRecord = (
    { email, project = null, accessToken = "", refreshToken = "", expiryDate = 0, clientPayload = null, sourceName },
    { preserveMatchingToken = false } = {}
  ) => {
    if (!email || !refreshToken) return;
    const existing = vault.accounts[email] || {};
    const existingExpiry = parseExpiryMs(existing.auth || existing.clientPayload);
    const incomingExpiry = expiryDate || parseExpiryMs(clientPayload);

    const isSameToken =
      existing.auth?.refresh_token === refreshToken &&
      existing.auth?.access_token === accessToken &&
      existingExpiry === incomingExpiry &&
      (!project || existing.project === project);

    const shouldUpdateToken = preserveMatchingToken
      ? !isSameToken && (
          !existing.auth?.refresh_token ||
          (incomingExpiry > 0 && incomingExpiry > existingExpiry) ||
          (incomingExpiry >= existingExpiry && Boolean(accessToken) && existing.auth?.access_token !== accessToken) ||
          (incomingExpiry >= existingExpiry && existing.auth?.refresh_token !== refreshToken)
        )
      : (
          !existing.auth?.refresh_token ||
          incomingExpiry >= existingExpiry ||
          existing.auth?.access_token !== accessToken
        );

    if (shouldUpdateToken) {
      const nextProject = project || existing.project || "aicode-consumers";
      const nextPayload = clientPayload || toClientOAuthPayload(email, {
        access_token: accessToken || existing.auth?.access_token || "",
        refresh_token: refreshToken,
        expiry_date: incomingExpiry || existingExpiry
      });
      vault.accounts[email] = {
        ...existing,
        email,
        project: nextProject,
        plan: existing.plan || null,
        capturedFrom: sourceName,
        capturedAt: new Date().toISOString(),
        auth: {
          access_token: accessToken || existing.auth?.access_token || "",
          refresh_token: refreshToken,
          expiry_date: incomingExpiry || existingExpiry || Date.now() + 3600_000,
          project: nextProject
        },
        clientPayload: toClientOAuthPayload(email, nextPayload, nextPayload)
      };
      changed = true;
    }
  };

  const upsertFromClient = (payload, sourceName) => {
    const email = normalizeEmail(payload?.id_token_email);
    const refreshToken = payload?.token?.refresh_token?.trim?.();
    const accessToken = payload?.token?.access_token?.trim?.() || "";
    upsertTokenRecord({
      email,
      accessToken,
      refreshToken,
      expiryDate: parseExpiryMs(payload),
      clientPayload: payload,
      sourceName
    });
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

  const pluginAuth = readPluginAuth();
  const pluginCredentials = readPluginCredentials(pluginAuth);
  for (const cred of pluginCredentials.values()) {
    if (cred.email && cred.auth?.refresh_token) {
      upsertTokenRecord(
        {
          email: cred.email,
          project: cred.project,
          accessToken: cred.auth.access_token,
          refreshToken: cred.auth.refresh_token,
          expiryDate: cred.auth.expiry_date,
          clientPayload: cred.clientPayload,
          sourceName: cred.source
        },
        { preserveMatchingToken: true }
      );
    }
  }

  const liveLs = queryLiveLanguageServerIdentity();

  if (changed) {
    saveVault(vault);
  }
  return { vault, keychainPayload, cliPayload, standalonePayload, pluginAuth, pluginCredentials, liveLs };
}

function quotaWindowMatches(window, spec) {
  if (!window) return false;
  const [name, qualifiedPeriod] = String(window.name || "").split(" · ", 2);
  if (qualifiedPeriod && window.pool && name !== window.pool) return false;
  const pool = window.pool || (qualifiedPeriod ? name : null);
  const period = qualifiedPeriod || name;
  return period === spec.name && (pool === spec.pool ||
    (spec.pool === "Gemini 4 Carbon" && /^(?:gemini[ -]+4[ -]+)?carbon(?: models?)?$/i.test(pool)));
}

function summarizeQuotaEntry(entry) {
  if (!entry || !entry.quota) return null;
  const windows = Array.isArray(entry.quota.windows) ? entry.quota.windows : [];
  const pools = [];
  const desired = [
    { pool: "Claude & GPT", name: "5 hours", label: "GPT / Claude 5h" },
    { pool: "Claude & GPT", name: "7 days", label: "GPT / Claude 7d" },
    { pool: "Gemini", name: "5 hours", label: "Gemini 5h" },
    { pool: "Gemini", name: "7 days", label: "Gemini 7d" },
    { pool: "Gemini 4 Argon", name: "7 days", label: "Gemini 4 Argon 7d" },
    { pool: "Gemini 4 Carbon", name: "5 hours", label: "Gemini 4 Carbon 5h" },
    { pool: "Gemini 4 Carbon", name: "7 days", label: "Gemini 4 Carbon 7d" }
  ];

  const nowMs = Date.now();
  for (const spec of desired) {
    const win = windows.find((window) => quotaWindowMatches(window, spec) &&
      !window.text && !window.unlimited && Number.isFinite(window.used));
    if (win && !entry.error) {
      const resetMs = win.resetsAt ? Date.parse(win.resetsAt) : 0;
      const isExpired = resetMs > 0 && resetMs <= nowMs;
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
    source: "magpie",
    plan: entry.quota.plan || null,
    updatedAt: entry.quota.readAt || entry.quota.asOf || entry.at || null,
    previousReading: Boolean(entry.quota.asOf),
    error: entry.error || null,
    pools
  };
}

function findQuotaEntry(quotas, prefix, email) {
  if (!quotas || typeof quotas !== "object" || !email) return null;
  const direct = quotas[`${prefix}/${email}`];
  if (direct) return direct;
  const lowerEmail = email.toLowerCase();
  const lowerDirect = quotas[`${prefix}/${lowerEmail}`];
  if (lowerDirect) return lowerDirect;
  const keyPrefix = `${prefix}/`;
  for (const [k, v] of Object.entries(quotas)) {
    if (k.startsWith(keyPrefix) && k.slice(keyPrefix.length).toLowerCase() === lowerEmail) {
      return v;
    }
  }
  return null;
}

function findCliCacheEntry(cliCache, email) {
  const accounts = cliCache?.accounts;
  if (!accounts || typeof accounts !== "object" || !email) return null;
  if (accounts[email]) return accounts[email];
  const lower = email.toLowerCase();
  if (accounts[lower]) return accounts[lower];
  for (const [k, v] of Object.entries(accounts)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function resolveQuotaForEmail(email, quotas, cliCache = null, providers = QUOTA_PROVIDER_PREFIXES) {
  const candidates = [];
  const cliEntry = findCliCacheEntry(cliCache, email);
  if (cliEntry) {
    const cliSummary = summarizeQuotaEntry({
      at: cliEntry.fetchedAt || null,
      error: cliEntry.error || null,
      quota: cliEntry.quota || (cliEntry.plan ? { plan: cliEntry.plan, windows: [] } : null)
    });
    if (cliSummary) {
      candidates.push({
        provider: "agy-cli",
        fromCliCache: true,
        entry: cliEntry,
        summary: {
          ...cliSummary,
          refreshError: cliEntry.refreshError || null
        },
        atMs: new Date(cliSummary.updatedAt ?? 0).getTime() || 0
      });
    }
  }
  for (const provider of providers) {
    const entry = findQuotaEntry(quotas, provider, email);
    const summary = summarizeQuotaEntry(entry);
    if (!summary) continue;
    const atMs = new Date(summary.updatedAt ?? 0).getTime() || 0;
    candidates.push({ provider, fromCliCache: false, entry, summary, atMs });
  }
  if (candidates.length === 0) return null;

  const withPlan = [...candidates]
    .filter((c) => typeof c.summary.plan === "string" && c.summary.plan.trim())
    .sort((a, b) => b.atMs - a.atMs || Number(b.fromCliCache) - Number(a.fromCliCache));
  const resolvedPlan = withPlan[0]?.summary.plan || null;

  const healthyWithPools = candidates
    .filter((c) => !c.summary.error && c.summary.pools.length > 0)
    .sort((a, b) => b.atMs - a.atMs || Number(b.fromCliCache) - Number(a.fromCliCache));
  const healthy = candidates
    .filter((c) => !c.summary.error)
    .sort((a, b) => b.atMs - a.atMs || Number(b.fromCliCache) - Number(a.fromCliCache));
  const errored = [...candidates].sort((a, b) => b.atMs - a.atMs || Number(b.fromCliCache) - Number(a.fromCliCache));

  const selected = healthyWithPools[0] || healthy[0] || errored[0];
  const cliErr = cliEntry?.refreshError || (cliEntry?.error && !selected.summary.error ? cliEntry.error : null);
  return {
    ...selected.summary,
    provider: selected.provider,
    plan: resolvedPlan || selected.summary.plan || null,
    refreshError: selected.summary.refreshError || cliErr || null
  };
}

function getLoginEmail(item) {
  if (!item || typeof item !== "object") return null;
  return normalizeEmail(item.user || item.email || item.name);
}

function resolveLoginItemEmail(item, pluginCredentials) {
  const direct = getLoginEmail(item);
  if (direct) return direct;
  const homeKey = getLoginHomeKey(item);
  return homeKey ? pluginCredentials?.get(homeKey)?.email || null : null;
}

function collectPluginCredentialsForEmail(email, matchingLogins, pluginCredentials) {
  const seenKeys = new Set();
  const list = [];
  if (pluginCredentials instanceof Map) {
    for (const login of matchingLogins || []) {
      const homeKey = getLoginHomeKey(login);
      const cred = homeKey ? pluginCredentials.get(homeKey) : null;
      if (cred && !seenKeys.has(homeKey) && (!cred.email || cred.email.toLowerCase() === email.toLowerCase())) {
        seenKeys.add(homeKey);
        list.push(cred);
      }
    }
    for (const [key, cred] of pluginCredentials.entries()) {
      if (!seenKeys.has(key) && cred?.email === email) {
        seenKeys.add(key);
        list.push(cred);
      }
    }
  }
  return list;
}

function collectCredentialCandidates(email, matchingLogins, pluginCredentials, vaultEntry) {
  const candidates = [];
  for (const item of matchingLogins || []) {
    if (item?.agent === "antigravity" && item?.auth?.refresh_token) {
      candidates.push({
        auth: item.auth,
        clientPayload: null,
        expiry: parseExpiryMs(item.auth),
        source: "magpie-login"
      });
    }
  }
  for (const cred of collectPluginCredentialsForEmail(email, matchingLogins, pluginCredentials)) {
    if (cred?.auth?.refresh_token) {
      candidates.push({
        auth: cred.auth,
        clientPayload: cred.clientPayload || null,
        expiry: parseExpiryMs(cred.auth),
        source: cred.source
      });
    }
  }
  if (vaultEntry?.auth?.refresh_token) {
    candidates.push({
      auth: vaultEntry.auth,
      clientPayload: vaultEntry.clientPayload || null,
      expiry: parseExpiryMs(vaultEntry.auth),
      source: vaultEntry.capturedFrom || "vault"
    });
  } else if (vaultEntry?.clientPayload?.token?.refresh_token) {
    candidates.push({
      auth: vaultEntry.clientPayload.token,
      clientPayload: vaultEntry.clientPayload,
      expiry: parseExpiryMs(vaultEntry.clientPayload),
      source: vaultEntry.capturedFrom || "vault"
    });
  }
  return candidates;
}

function describePlan(plan) {
  const rawName = typeof plan === "string" && plan.trim() ? plan.trim() : null;
  const name = rawName === "g1-ultra-tier" ? "Google AI Ultra" : rawName;
  const normalized = (name || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const paid = /^(?:(?:google\s+)?ai\s+|antigravity\s+)?(pro|ultra|enterprise)\b/i.exec(normalized);
  const family = paid?.[1]?.toLowerCase() || (/^gemini\s+enterprise\b/i.test(normalized) ? "enterprise" : null);
  const isFree = !family && /^(?:(?:google\s+)?ai\s+|antigravity\s+)?(?:free|starter)\b/i.test(normalized);
  return { name, family: family || (isFree ? "free" : "unknown"), isPaid: Boolean(family), isFree, recognized: Boolean(family || isFree) };
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

  const memberBonus = account.isPaid ? 25 : 0;

  if (pools.length > 0) {
    const c = claudeRem ?? 0;
    const a = argonRem ?? 0;
    const g = geminiRem ?? 0;
    const base = c * 0.55 + a * 0.3 + g * 0.15;
    return Math.round((base + memberBonus) * 10) / 10;
  }

  return memberBonus;
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

function resolveLoginPlan(matchingLogins) {
  const order = ["plugin:antigravity", "antigravity", "plugin:agy-cli"];
  for (const agent of order) {
    const hit = matchingLogins.find(
      (item) => item.agent === agent && typeof item.plan === "string" && item.plan.trim()
    );
    if (hit) return hit.plan.trim();
  }
  return null;
}

let agyVersionProbe = null;

function detectInstalledAgyVersion({ refresh = false } = {}) {
  if (!refresh && agyVersionProbe && Date.now() < agyVersionProbe.expiresAt) {
    return agyVersionProbe.version;
  }
  const candidates = [
    "agy",
    path.join(HOME, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    path.join(HOME, ".local", "share", "magpie-agy-cli", "agy")
  ];
  for (const bin of candidates) {
    try {
      if (bin !== "agy" && !fs.existsSync(bin)) continue;
      const output = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const version = /^(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
      if (version) {
        agyVersionProbe = { version, expiresAt: Date.now() + AGY_VERSION_TTL_MS };
        return version;
      }
    } catch {
      // 继续检查已知的安装位置。
    }
  }
  agyVersionProbe = { version: null, expiresAt: Date.now() + AGY_VERSION_TTL_MS };
  return null;
}

function usesSharedAgyKeychain(options) {
  if (process.platform !== "darwin" || process.env.SSH_CONNECTION) return false;
  const [major, minor] = (detectInstalledAgyVersion(options) || "").split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 5);
}

function readStateInputs() {
  return {
    ...captureLiveClientAccounts(),
    logins: readLogins(),
    cliCache: readCliQuotaCache(),
    quotas: readJsonSafe(PATHS.quotasJson, {}),
    appStorage: readJsonSafe(PATHS.appStorage, {})
  };
}

export function getFullState() {
  return buildState(readStateInputs());
}

function buildState(inputs, agyCliOnly = false) {
  const { vault, keychainPayload, cliPayload, pluginAuth, pluginCredentials, liveLs,
    logins, cliCache, quotas, appStorage } = inputs;

  const desktopKeychainEmail = keychainPayload?.id_token_email || null;
  const desktopUiEmail = appStorage?.["jetski.onboarding.lastLoginUsername"] || null;
  const desktopSavedEmail = desktopKeychainEmail || desktopUiEmail || null;
  const lsRunning = Boolean(liveLs) || isLanguageServerRunning();
  const desktopRuntimeEmail = lsRunning ? liveLs?.email || null : null;
  const desktopEmail = lsRunning ? desktopRuntimeEmail : desktopSavedEmail;
  const desktopPending = Boolean(lsRunning && desktopSavedEmail && desktopRuntimeEmail !== desktopSavedEmail);
  const desktopStatus = !lsRunning ? "stopped" : !desktopRuntimeEmail ? "unknown" : desktopPending ? "pending" : "running";
  const cliUsesSharedLogin = usesSharedAgyKeychain();
  const cliEmail = (cliUsesSharedLogin ? desktopKeychainEmail : cliPayload?.id_token_email) || null;

  const supportedLogins = logins.filter((item) =>
    (agyCliOnly ? isMagpieAgyCliLogin(item, pluginAuth) : isSupportedLoginAgent(item?.agent)) &&
    resolveLoginItemEmail(item, pluginCredentials));
  const firstCandidates = supportedLogins.filter((item) => item.on && !item.lapsed);
  const magpieFirst = firstCandidates.find((item) => item.first) || firstCandidates.find((item) => item.on) || null;
  const magpieFirstEmail = resolveLoginItemEmail(magpieFirst, pluginCredentials);

  const allEmails = new Set();
  for (const item of supportedLogins) {
    allEmails.add(resolveLoginItemEmail(item, pluginCredentials));
  }
  if (!agyCliOnly) {
    for (const cred of pluginCredentials.values()) {
      if (cred?.email) allEmails.add(cred.email);
    }
    for (const email of Object.keys(vault.accounts || {})) {
      allEmails.add(email);
    }
    if (desktopEmail) allEmails.add(desktopEmail);
    if (desktopSavedEmail) allEmails.add(desktopSavedEmail);
    if (cliEmail) allEmails.add(cliEmail);
  }

  const accounts = [];
  for (const email of allEmails) {
    const matchingLogins = supportedLogins.filter(
      (item) => resolveLoginItemEmail(item, pluginCredentials) === email
    );
    const loginEntry =
      matchingLogins.find((item) => item.agent === "plugin:agy-cli") ||
      matchingLogins.find((item) => item.agent === "plugin:antigravity") ||
      matchingLogins[0] ||
      null;
    const pluginCreds = collectPluginCredentialsForEmail(email, matchingLogins, pluginCredentials);
    const vaultEntry = vault.accounts?.[email] || null;
    const cliCacheEntry = findCliCacheEntry(cliCache, email);
    const quotaSummary = resolveQuotaForEmail(email, quotas, cliCache, agyCliOnly ? ["agy-cli"] : undefined);

    const credCandidates = collectCredentialCandidates(email, matchingLogins, pluginCredentials, vaultEntry);
    const hasLegacyAccessOnly = matchingLogins.some(
      (item) => item?.agent === "antigravity" && Boolean(item?.auth?.refresh_token || item?.auth?.access_token)
    );
    const hasCredentials = credCandidates.length > 0 || hasLegacyAccessOnly;

    const loginPlan = resolveLoginPlan(matchingLogins);
    const rawPlan = quotaSummary?.plan || loginPlan || null;

    const hasPluginPresence =
      matchingLogins.some((item) => isPluginLoginAgent(item.agent)) ||
      pluginCreds.some((cred) => cred.source === "magpie-plugin-auth" || Boolean(cred.agyHome));
    const legacyHasProject = matchingLogins.some(
      (item) => item?.agent === "antigravity" && Boolean(item?.project || item?.auth?.project)
    );
    const pluginHasProject = pluginCreds.some((cred) => Boolean(cred.project));
    const magpieDisabled = agyCliOnly && !matchingLogins.some((item) => item.on);
    const magpieLapse = agyCliOnly && !magpieDisabled &&
      matchingLogins.filter((item) => item.on).every((item) => item.lapsed);
    const explicitlyIneligible = magpieDisabled || magpieLapse || cliCacheEntry?.eligible === false;
    const isEligible = explicitlyIneligible
      ? false
      : matchingLogins.length === 0
        ? true
        : hasPluginPresence
          ? true
          : Boolean(legacyHasProject || pluginHasProject || quotaSummary?.plan || loginPlan);

    const planInfo = describePlan(rawPlan);
    const tierLabel = magpieDisabled ? "已停用" : !isEligible ? "不可用" : planInfo.name || "套餐未知";
    const resolvedProject =
      cliCacheEntry?.project ||
      matchingLogins.find((item) => item?.project)?.project ||
      matchingLogins.find((item) => item?.auth?.project)?.auth?.project ||
      pluginCreds.find((cred) => cred.project)?.project ||
      vaultEntry?.project ||
      "aicode-consumers";
    const agents = [...new Set(matchingLogins.map((item) => item.agent))];
    const hasAgyCli =
      agents.includes("plugin:agy-cli") ||
      pluginCreds.some((cred) => cred.source === "agy-cli-home" || cred.source === "agy-cli-default");
    const agyCliMode = hasAgyCli
      ? pluginCreds.some((cred) => Boolean(cred.agyHome))
        ? "isolated"
        : "default"
      : null;

    const accountObj = {
      email,
      name: resolveLoginItemEmail(loginEntry, pluginCredentials) || email,
      plan: planInfo.name,
      tierLabel,
      planFamily: planInfo.family,
      isPaid: planInfo.isPaid,
      isFree: planInfo.isFree,
      membershipKnown: planInfo.recognized,
      // Compatibility alias: older pages use isPro for all recognized members.
      isPro: planInfo.isPaid,
      planKnown: Boolean(planInfo.name),
      isEligible,
      ineligibleReason: magpieDisabled
        ? "已在 Magpie 停用"
        : magpieLapse ? "登录已失效，请在 Magpie 重新登录" : !isEligible ? cliCacheEntry?.ineligibleReason || null : null,
      hasProject: isEligible,
      project: resolvedProject,
      agents,
      agyCliMode,
      quotaProvider: quotaSummary?.provider || null,
      inMagpie: matchingLogins.length > 0,
      inVault: Boolean(vaultEntry),
      hasCredentials,
      magpieOn: matchingLogins.some((item) => Boolean(item.on)),
      magpieFirst: matchingLogins.some((item) => Boolean(item.first)),
      activeDesktop: lsRunning && desktopRuntimeEmail === email,
      savedDesktop: desktopSavedEmail === email,
      pendingDesktop: desktopPending && desktopSavedEmail === email,
      activeDesktopKeychain: desktopKeychainEmail === email,
      activeDesktopUi: desktopUiEmail === email,
      activeCli: cliEmail === email,
      activeMagpieFirst: magpieFirstEmail === email,
      capturedFrom: vaultEntry?.capturedFrom || pluginCreds[0]?.source || null,
      updatedAt:
        matchingLogins.find((item) => item.seen)?.seen ||
        matchingLogins.find((item) => item.updatedAt)?.updatedAt ||
        vaultEntry?.capturedAt ||
        null,
      quota: quotaSummary,
      score: 0
    };
    accountObj.score = computeRecommendationScore(accountObj);
    accounts.push(accountObj);
  }

  accounts.sort((a, b) => {
    if (a.isPaid !== b.isPaid) return a.isPaid ? -1 : 1;
    if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
    if (a.activeDesktop !== b.activeDesktop) return a.activeDesktop ? -1 : 1;
    if (a.activeCli !== b.activeCli) return a.activeCli ? -1 : 1;
    return b.score - a.score;
  });

  const onlyProPref = Boolean(vault.preferences?.onlyPro);
  const recommended =
    [...accounts]
      .filter((a) => a.hasCredentials && a.isEligible && (!onlyProPref || a.isPaid))
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
      paid: accounts.filter((a) => a.isPaid && a.isEligible).length,
      // Compatibility aggregate; the visible label is no longer restricted to Pro.
      pro: accounts.filter((a) => a.isPaid && a.isEligible).length,
      free: accounts.filter((a) => a.isFree && a.isEligible).length,
      unknown: accounts.filter((a) => !a.membershipKnown && a.isEligible).length,
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
      cliUsesSharedLogin,
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

export function syncStateFile({ fullResult = false } = {}) {
  let state;
  let fullState;
  try {
    const inputs = readStateInputs();
    state = buildState(inputs, true);
    if (fullResult) fullState = buildState(inputs);
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
  return fullState || state;
}

function resolveAccountCredentials(email, { vault, pluginCredentials }, logins) {
  const matchingLogins = Array.isArray(logins)
    ? logins.filter(
        (item) => item && isSupportedLoginAgent(item.agent) && resolveLoginItemEmail(item, pluginCredentials) === email
      )
    : [];
  const vaultEntry = vault.accounts?.[email] || null;
  const candidates = collectCredentialCandidates(email, matchingLogins, pluginCredentials, vaultEntry);
  candidates.sort((a, b) => b.expiry - a.expiry);
  const chosen = candidates[0] || null;

  if (!chosen?.auth?.refresh_token) {
    throw new Error(`未找到账号 ${email} 的可用 OAuth 凭证`);
  }

  const clientPayload = toClientOAuthPayload(
    email,
    chosen.auth,
    chosen.clientPayload || vaultEntry?.clientPayload
  );
  return {
    email,
    clientPayload,
    loginEntry: matchingLogins[0] || null,
    vaultEntry
  };
}

export function importAccountToMagpie(email) {
  const logins = readLogins();
  const { vault, pluginCredentials } = captureLiveClientAccounts();
  const cliCache = readCliQuotaCache();
  const quotas = readJsonSafe(PATHS.quotasJson, {});
  const plan = resolveQuotaForEmail(email, quotas, cliCache)?.plan || null;
  const vaultEntry = vault.accounts?.[email] || null;
  const pluginCreds = collectPluginCredentialsForEmail(email, [], pluginCredentials);
  const pluginWithToken = pluginCreds.find((cred) => cred?.auth?.refresh_token) || null;
  const authSource = vaultEntry?.auth?.refresh_token ? vaultEntry.auth : pluginWithToken?.auth || null;
  const resolvedProject = vaultEntry?.project || pluginWithToken?.project || "aicode-consumers";

  const existingPluginIdx = logins.findIndex(
    (item) => item && isPluginLoginAgent(item.agent) && resolveLoginItemEmail(item, pluginCredentials) === email
  );
  if (existingPluginIdx < 0 && !authSource?.refresh_token) {
    throw new Error(`未找到账号 ${email} 的凭证`);
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const existingLegacyIdx = logins.findIndex(
    (item) => item && item.agent === "antigravity" && getLoginEmail(item) === email
  );

  if (existingPluginIdx >= 0) {
    for (const item of logins) {
      if (item && isSupportedLoginAgent(item.agent) && resolveLoginItemEmail(item, pluginCredentials) === email) {
        item.seen = nowIso;
        item.on = true;
        if (!item.user) item.user = email;
        if (plan && item.agent !== "plugin:agy-cli") {
          item.plan = plan;
        }
      }
    }
  } else {
    const newAuth = {
      access_token: authSource.access_token || "",
      refresh_token: authSource.refresh_token,
      expiry_date: authSource.expiry_date || Date.now() + 3599_000,
      project: resolvedProject
    };

    if (existingLegacyIdx >= 0) {
      logins[existingLegacyIdx] = {
        ...logins[existingLegacyIdx],
        user: email,
        seen: nowIso,
        on: true,
        plan: plan || logins[existingLegacyIdx].plan || undefined,
        project: logins[existingLegacyIdx].project || resolvedProject,
        auth: {
          ...(logins[existingLegacyIdx].auth || {}),
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
        ...(plan ? { plan } : {}),
        project: resolvedProject,
        auth: newAuth
      });
    }
  }

  writeJsonAtomic(PATHS.loginsJson, logins, 0o600);
  const state = syncStateFile({ fullResult: true });
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
  const state = syncStateFile({ fullResult: true });
  const modeText = vault.preferences.onlyPro ? "已开启「仅显示已识别会员」" : "已显示全部可用账号";
  return {
    ok: true,
    action: "set-preferences",
    message: modeText,
    state
  };
}

export function organizeAccounts({ onlyPro } = {}) {
  const logins = readLogins();
  const { vault, pluginCredentials } = captureLiveClientAccounts();
  const cliCache = readCliQuotaCache();
  const quotas = readJsonSafe(PATHS.quotasJson, {});

  let importedCount = 0;
  let disabledCount = 0;

  if (Array.isArray(logins)) {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    // 1. Ensure all recognized paid accounts are imported into Magpie logins.json
    for (const [email, vEntry] of Object.entries(vault.accounts || {})) {
      if (!vEntry?.auth?.refresh_token) continue;
      const plan = resolveQuotaForEmail(email, quotas, cliCache)?.plan;
      if (!describePlan(plan).isPaid) continue;
      const exists = logins.some(
        (item) => item && isSupportedLoginAgent(item.agent) && resolveLoginItemEmail(item, pluginCredentials) === email
      );
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

    // 2. Disable ineligible legacy accounts & enrich plan labels from Magpie / agy-cli cache
    for (const item of logins) {
      if (!item || !isSupportedLoginAgent(item.agent)) continue;
      const email = resolveLoginItemEmail(item, pluginCredentials);
      if (!email) continue;
      if (isPluginLoginAgent(item.agent)) {
        const prefix = item.agent === "plugin:agy-cli" ? "agy-cli" : "antigravity";
        const quotaPlan =
          summarizeQuotaEntry(findQuotaEntry(quotas, prefix, email))?.plan ||
          (item.agent === "plugin:agy-cli" ? findCliCacheEntry(cliCache, email)?.plan || null : null);
        if (quotaPlan) {
          item.plan = quotaPlan;
        }
        continue;
      }
      const plan = resolveQuotaForEmail(email, quotas, cliCache)?.plan || item.plan || null;
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

    // 3. Sort supported accounts inside logins.json: Members first, then other eligible accounts, then ineligible
    const agyItems = logins.filter((item) => item && isSupportedLoginAgent(item.agent));
    const otherItems = logins.filter((item) => !item || !isSupportedLoginAgent(item.agent));
    agyItems.sort((a, b) => {
      const aEmail = resolveLoginItemEmail(a, pluginCredentials);
      const bEmail = resolveLoginItemEmail(b, pluginCredentials);
      const aPlan = a.plan || resolveQuotaForEmail(aEmail, quotas, cliCache)?.plan || null;
      const bPlan = b.plan || resolveQuotaForEmail(bEmail, quotas, cliCache)?.plan || null;
      const aPaid = describePlan(aPlan).isPaid;
      const bPaid = describePlan(bPlan).isPaid;
      if (aPaid !== bPaid) return aPaid ? -1 : 1;
      const aElig = isPluginLoginAgent(a.agent) || Boolean(a.project || a.auth?.project || aPlan);
      const bElig = isPluginLoginAgent(b.agent) || Boolean(b.project || b.auth?.project || bPlan);
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

  const state = syncStateFile({ fullResult: true });
  const details = [];
  if (importedCount > 0) details.push(`纳管 ${importedCount} 个本地会员账号`);
  if (disabledCount > 0) details.push(`停用 ${disabledCount} 个异常账号`);
  details.push(`共 ${state.counts.paid} 个会员置顶`);

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

function injectSmoothTransitionOverlaySync(targetEmail, language) {
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

  const pendingTitle = language === "en" ? `Switching to ${targetEmail}` : `正在切换至 ${targetEmail}`;
  const pendingDetail = language === "en"
    ? "Reloading the desktop app. This window will refresh when ready…"
    : "正在同步桌面端服务，界面将在就绪后自动刷新…";
  const overlayCode = `
    (() => {
      try {
        const existing = document.getElementById("__agy_switch_overlay__");
        if (existing) existing.remove();
        const el = document.createElement("div");
        el.id = "__agy_switch_overlay__";
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(19,19,19,0.92);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#f5f5f7;font-family:system-ui,-apple-system,sans-serif;transition:opacity 0.2s ease;";
        el.innerHTML = '<div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.14);border-top-color:#60a5fa;border-radius:50%;animation:agySpin 0.8s linear infinite;margin-bottom:14px;"></div>' +
          '<div data-title style="font-size:15px;font-weight:600;letter-spacing:0.2px;"></div>' +
          '<div data-detail style="font-size:12px;color:rgba(255,255,255,0.58);margin-top:6px;"></div>' +
          '<style>@keyframes agySpin{to{transform:rotate(360deg)}}</style>';
        el.querySelector("[data-title]").textContent = ${JSON.stringify(pendingTitle)};
        el.querySelector("[data-detail]").textContent = ${JSON.stringify(pendingDetail)};
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
        const psOut = execFileSync("ps", ["-axww", "-o", "pid=,comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
        const line = psOut.split("\\n").map((line) => line.trim().split(/\\s+/, 2)).find((pair) => pair[1] === lsPattern);
        const pid = Number(line?.[0]);
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

export function reloadDesktopLanguageServer(targetEmail = "", language) {
  const lsState = inspectElectronRestartState();
  const lsInfo = getRunningLanguageServerInfo();

  // Only recover a running desktop app that recorded a language-server crash.
  if (!lsInfo && lsState.gaveUp) {
    try {
      const desktop = findAppProcess(DESKTOP_EXECUTABLE);
      if (desktop) {
        execFileSync("kill", ["-TERM", String(desktop.pid)], { stdio: ["ignore", "ignore", "ignore"] });
        execFileSync("open", ["-a", DESKTOP_APP], { stdio: ["ignore", "ignore", "ignore"] });
        return {
          reloaded: true,
          reason: "检测到桌面端服务曾停止响应，已自动重启 Antigravity 恢复界面"
        };
      }
    } catch (err) {
      return { reloaded: false, reason: `桌面端重载失败: ${sanitizeErrorMessage(err)}` };
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
    const savedRoute = injectSmoothTransitionOverlaySync(targetEmail, language);
    if (findAppProcess(LANGUAGE_SERVER_PATTERN)?.pid !== lsInfo.pid) {
      throw new Error("桌面端服务进程已变化，请重试");
    }
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

function readFileOrMissing(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
}

function sameFileContents(left, right) {
  return left === null || right === null ? left === right : left.equals(right);
}

function saveSwitchFiles(updates, payloadForKeychain) {
  const applied = [];
  try {
    for (const { filePath, previous, value } of updates) {
      if (!sameFileContents(readFileOrMissing(filePath), previous)) {
        throw new Error(`${path.basename(filePath)} 在切换期间发生变化，请重试`);
      }
      const content = Buffer.from(jsonText(value));
      writeTextAtomic(filePath, content, 0o600);
      applied.push({ filePath, previous, content });
    }
    if (payloadForKeychain) writeKeychainAuth(payloadForKeychain);
  } catch (err) {
    const failures = [];
    for (const { filePath, previous, content } of applied.reverse()) {
      try {
        if (!sameFileContents(readFileOrMissing(filePath), content)) {
          throw new Error("配置已被其他进程修改");
        }
        if (previous === null) fs.unlinkSync(filePath);
        else writeTextAtomic(filePath, previous, 0o600);
      } catch {
        failures.push(path.basename(filePath));
      }
    }
    if (failures.length) {
      throw new Error(`${sanitizeErrorMessage(err)} · 未能恢复 ${failures.join("、")}，请检查当前登录状态`);
    }
    throw err;
  }
}

export function switchAccount({
  email: requestedEmail,
  target = "all",
  reloadDesktop = false,
  syncMagpie = true,
  language
} = {}) {
  const email = normalizeEmail(requestedEmail);
  if (!email) throw new Error("请指定要切换的目标邮箱账号");

  if (!["all", "desktop", "cli"].includes(target)) throw new Error("无效切换目标，请使用 all、desktop 或 cli");
  const switchesDesktop = target !== "cli";
  const switchesCli = target !== "desktop";
  const loginSnapshot = readJsonSnapshot(PATHS.loginsJson, [], Array.isArray);
  const desktopSnapshot = switchesDesktop ? readJsonSnapshot(PATHS.appStorage, {}, isRecord) : null;
  const sharedCliLogin = switchesCli && usesSharedAgyKeychain({ refresh: true });
  const writesKeychain = switchesDesktop || sharedCliLogin;

  const captured = captureLiveClientAccounts();
  const { pluginCredentials } = captured;
  const { clientPayload } = resolveAccountCredentials(email, captured, loginSnapshot.value);
  const updatedTargets = [];
  const updates = [];

  if (switchesDesktop) {
    const { value, raw } = desktopSnapshot;
    value["jetski.onboarding.lastLoginUsername"] = email;
    updates.push({ filePath: PATHS.appStorage, previous: raw, value });
    updatedTargets.push("桌面端");
  }

  if (switchesCli) {
    if (switchesDesktop || !sharedCliLogin) {
      for (const filePath of [PATHS.cliToken, PATHS.standaloneToken]) {
        const { raw } = readJsonSnapshot(filePath, null, isRecord);
        updates.push({ filePath, previous: raw, value: clientPayload });
      }
    }
    updatedTargets.push("CLI");
  }

  if (syncMagpie) {
    const { value: logins, raw } = loginSnapshot;
    const siblings = logins.filter((item) => isSupportedLoginAgent(item?.agent));
    const matches = siblings.filter((item) => resolveLoginItemEmail(item, pluginCredentials) === email);
    if (matches.length) {
      for (const item of siblings) {
        if (matches.includes(item)) {
          item.first = true;
          item.on = true;
        } else if (item.first) {
          delete item.first;
        }
      }
      updates.push({ filePath: PATHS.loginsJson, previous: raw, value: logins });
      updatedTargets.push("Magpie");
    }
  }

  saveSwitchFiles(updates, writesKeychain ? clientPayload : null);

  let reloadResult = null;
  if (reloadDesktop && switchesDesktop) {
    reloadResult = reloadDesktopLanguageServer(email, language);
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
    sharedCliLogin ? "· 新启动的 CLI 使用此账号" : "",
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

  const state = syncStateFile({ fullResult: true });
  const pending = writesKeychain &&
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

function refreshMagpieQuota(user) {
  const app = "/Applications/magpie.app/Contents/MacOS/magpie";
  const command = fs.existsSync(app) ? app : "magpie";
  return new Promise((resolve, reject) => {
    execFile(command, ["quota", "refresh", "agy-cli", user, "--json"], {
      encoding: "utf8", timeout: 55_000, maxBuffer: 1024 * 1024,
      // The provider supports an 18s allowance within Magpie's 20s usage call.
      env: { AGY_BRIDGE_USAGE_TIMEOUT_MS: "18000", ...process.env }
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") {
          reject(new Error("找不到 Magpie 命令，无法刷新额度"));
        } else if (error.killed || error.signal) {
          reject(new Error("Magpie 额度刷新超时"));
        } else {
          reject(new Error("Magpie 未能刷新这个账号的额度"));
        }
        return;
      }
      try {
        const entries = JSON.parse(stdout);
        if (!Array.isArray(entries)) throw new Error("Magpie 返回了无效的额度数据");
        const key = user.toLowerCase();
        const quota = entries.find((entry) => entry?.provider === "agy-cli" &&
          [entry.user, entry.alias].some((name) => typeof name === "string" && name.toLowerCase() === key));
        if (!quota) throw new Error("Magpie 未返回这个账号的额度");
        const cached = /(?:^|\n)read .+ ago: not asked again/.test(stderr);
        resolve({ quota, cached });
      } catch (err) {
        reject(err instanceof SyntaxError ? new Error("Magpie 返回了无效的额度数据") : err);
      }
    });
  });
}

export async function refreshCliAccounts({ force = false, now = () => Date.now() } = {}) {
  const pluginAuth = readPluginAuth();
  const pluginCredentials = readPluginCredentials(pluginAuth);
  const cache = readCliQuotaCache();
  const nowMs = now();
  const attemptedAt = new Date(nowMs).toISOString();
  const jobs = new Map();
  let skipped = 0;

  for (const login of readLogins()) {
    if (!isMagpieAgyCliLogin(login, pluginAuth) || !login.on || login.lapsed) continue;
    const email = resolveLoginItemEmail(login, pluginCredentials);
    if (!email || jobs.has(email)) continue;

    const home = getLoginHomeKey(login);
    const prev = findCliCacheEntry(cache, email);
    if (!force && prev?.providerHome === home) {
      const fetchedMs = Date.parse(prev.fetchedAt || prev.attemptedAt || "");
      if ((prev.retryAfter && nowMs < prev.retryAfter) ||
          (!prev.error && Number.isFinite(fetchedMs) && nowMs - fetchedMs < CLI_QUOTA_TTL_MS)) {
        skipped++;
        continue;
      }
    }
    jobs.set(email, { user: login.user || email, prev, home });
  }

  let refreshed = 0;
  const updates = new Map();
  const errors = [];
  const pending = jobs.entries();
  const workers = Array.from({ length: Math.min(jobs.size, 4) }, async () => {
    for (const [email, { user, home, prev }] of pending) {
      try {
        const { quota, cached } = await refreshMagpieQuota(user);
        if (quota.error) throw new Error(quota.error);
        const reused = Boolean(cached || quota.readDeferred || quota.asOf);
        // A cached reply without a reading time cannot be dated by this attempt.
        const readAt = quota.readAt || quota.asOf || (reused ? null : attemptedAt);
        const reading = {
          plan: quota.plan || null,
          readAt,
          asOf: quota.asOf || null,
          windows: Array.isArray(quota.windows) ? quota.windows : []
        };
        if (summarizeQuotaEntry({ quota: reading }).pools.length === 0) {
          throw new Error("Magpie 未返回可显示的额度读数");
        }
        updates.set(email, { providerHome: home, fetchedAt: readAt, attemptedAt, quota: reading });
        if (reused) skipped++;
        else refreshed++;
      } catch (err) {
        const message = sanitizeErrorMessage(err);
        const sameLogin = !prev?.providerHome || prev.providerHome === home;
        const keepPriorQuota = sameLogin && prev?.quota?.windows?.length > 0;
        const failureCount = (sameLogin ? prev?.failureCount || 0 : 0) + 1;
        const backoff = Math.min(CLI_BACKOFF_FIRST_MS * 2 ** Math.min(failureCount - 1, 4), CLI_BACKOFF_MAX_MS);
        updates.set(email, {
          providerHome: home, attemptedAt, failureCount, retryAfter: nowMs + backoff,
          fetchedAt: keepPriorQuota ? prev.fetchedAt : attemptedAt,
          quota: keepPriorQuota ? prev.quota : { readAt: attemptedAt, windows: [] },
          error: keepPriorQuota ? null : message,
          refreshError: keepPriorQuota ? message : null
        });
        errors.push({ email, error: message });
      }
    }
  });

  await Promise.all(workers);

  if (updates.size) {
    const latestCache = readCliQuotaCache();
    for (const [email, entry] of updates) {
      if ((latestCache.accounts[email]?.attemptedAt || "") <= entry.attemptedAt) {
        latestCache.accounts[email] = entry;
      }
    }
    saveCliQuotaCache(latestCache);
  }

  const state = syncStateFile();
  const failed = errors.length;
  const details = [`已同步 ${state.accounts.length} 个账号`];
  if (refreshed) details.push(`已刷新 ${refreshed} 个账号的额度`);
  if (skipped) details.push(`沿用 ${skipped} 个账号的近期额度`);
  if (failed) details.push(`${failed} 个额度查询失败`);

  return {
    ok: failed < jobs.size || failed === 0,
    refreshed,
    skipped,
    failed,
    total: jobs.size,
    errors,
    message: details.join("，"),
    state
  };
}

const GITHUB_REPO_URL = "https://github.com/0xTotoroX/magpie-antigravity-switch";

function openGitHubRepo() {
  execFileSync("open", [GITHUB_REPO_URL], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  return {
    ok: true,
    action: "open-github",
    url: GITHUB_REPO_URL,
    message: "已在浏览器打开 GitHub 仓库，欢迎点亮 Star"
  };
}

function isPendingCommand(cmd, receivedAt = Date.now()) {
  if (!cmd || typeof cmd !== "object" || !cmd.id) return false;
  if (typeof cmd.ts === "number" && Math.abs(receivedAt - cmd.ts) > 30_000) return false;
  const vault = readVault();
  return vault.lastExecutedCmdId !== cmd.id && vault.lastSwitch?.cmdId !== cmd.id;
}

function recordCommandResult(id, { email, ok, message }, { preservePrevious = true } = {}) {
  const vault = readVault();
  vault.lastExecutedCmdId = id;
  vault.lastSwitch = {
    ...(preservePrevious ? vault.lastSwitch : null),
    cmdId: id,
    at: new Date().toISOString(),
    email,
    ok,
    message
  };
  saveVault(vault);
  syncStateFile();
}

function recordCommandFailure(id, err, email = null) {
  const message = sanitizeErrorMessage(err);
  recordCommandResult(id, { email, ok: false, message }, { preservePrevious: false });
  return { ok: false, error: message };
}

export async function executeCommandAsync(cmd, { receivedAt } = {}) {
  if (cmd?.type !== "refresh") return executeCommandPayload(cmd, { receivedAt });
  if (!isPendingCommand(cmd, receivedAt)) return null;

  try {
    const result = await refreshCliAccounts({ force: true });
    if (result.state?.error) throw new Error(result.state.error);
    recordCommandResult(cmd.id, {
      email: result.state?.current?.desktopEmail || null,
      ok: result.ok !== false,
      message: result.message
    });
    return result;
  } catch (err) {
    return recordCommandFailure(cmd.id, err);
  }
}

export function executeCommandPayload(cmd, { receivedAt } = {}) {
  if (!isPendingCommand(cmd, receivedAt)) return null;

  try {
    let result;
    if (cmd.type === "switch") {
      result = switchAccount({
        email: cmd.email,
        target: cmd.target || "all",
        reloadDesktop: Boolean(cmd.reloadDesktop),
        syncMagpie: cmd.syncMagpie !== false,
        language: cmd.language
      });
    } else if (cmd.type === "import-magpie") {
      result = importAccountToMagpie(cmd.email);
    } else if (cmd.type === "set-preferences") {
      result = setPreferences(cmd.preferences || {});
    } else if (cmd.type === "reload-desktop") {
      const reloadRes = reloadDesktopLanguageServer(getFullState().current.desktopSavedEmail || "", cmd.language);
      result = {
        ok: reloadRes.reloaded,
        email: getFullState().current.desktopEmail,
        message: reloadRes.reason
      };
    } else if (cmd.type === "open-github") {
      result = openGitHubRepo();
    } else if (cmd.type === "refresh") {
      const state = syncStateFile();
      if (state.error) throw new Error(state.error);
      result = {
        ok: true,
        email: state.current.desktopEmail,
        message: "已读取 Magpie 配额与本地登录状态"
      };
    } else {
      return null;
    }

    recordCommandResult(cmd.id, {
      email: cmd.email || result?.email || null,
      ok: result?.ok !== false,
      message: result?.message || "操作完成"
    });
    return result;
  } catch (err) {
    return recordCommandFailure(cmd.id, err, cmd.email || null);
  }
}
