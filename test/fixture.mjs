import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export const project = fileURLToPath(new URL("../", import.meta.url));
export const future = () => new Date(Date.now() + 86400_000).toISOString();
export const auth = (email) => ({ id_token_email: email, token: {
  access_token: "fixture-access", refresh_token: "fixture-refresh", expiry: future()
} });
export const login = (email, plan = "Google AI Pro") => ({
  agent: "antigravity", user: email, on: true, plan, project: "fixture-project",
  auth: { access_token: "fixture-access", refresh_token: "fixture-refresh", expiry_date: Date.now() + 86400_000 }
});
export const live = (email, remaining = 0, plan = "Google AI Pro") => ({
  email, userTier: plan ? { name: plan } : {}, cascadeModelConfigData: {
    clientModelConfigs: [{ label: "Claude", quotaInfo: { remainingFraction: remaining / 100, resetTime: future() } }]
  }
});
export const quota = (c5, c7, at = Date.now()) => ({ at, quota: { plan: "Google AI Pro", windows: [
  { pool: "Claude & GPT", name: "5 hours", used: 100 - c5, resetsAt: future() },
  { pool: "Claude & GPT", name: "7 days", used: 100 - c7, resetsAt: future() },
  { pool: "Gemini 4 Argon", name: "7 days", used: 0, resetsAt: future() },
  { pool: "Gemini", name: "5 hours", used: 0, resetsAt: future() }
] } });

// 所有生产文件系统和子进程依赖均被替换；未列出的命令直接报错。
export async function fixture(options = {}) {
  const files = new Map(), dirs = new Set(["/"]), calls = [];
  const readErrors = new Map();
  let keychain = options.keychain ? JSON.stringify(options.keychain) : null;
  let keychainWrites = 0;
  const mockFs = {
    existsSync(p) { return files.has(String(p)) || dirs.has(String(p)); },
    mkdirSync(p) { dirs.add(String(p)); },
    chmodSync() {},
    readFileSync(p, enc) {
      if (readErrors.has(String(p))) throw Object.assign(new Error("fixture read denied"), { code: readErrors.get(String(p)) });
      if (!files.has(String(p))) throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      const content = files.get(String(p));
      return enc ? content.toString() : Buffer.from(content);
    },
    writeFileSync(p, content) { files.set(String(p), Buffer.from(content)); },
    renameSync(from, to) {
      assert(files.has(String(from)), "fixture rename source must exist");
      files.set(String(to), files.get(String(from))); files.delete(String(from));
    }
  };
  const childProcess = {
    execFileSync(cmd, args = []) {
      calls.push({ cmd, args });
      if (cmd === "security") {
        if (args[0] === "find-generic-password") {
          if (options.denyKeychainRead) throw Object.assign(new Error("fixture read denied"), { status: 36 });
          if (keychain === null) throw Object.assign(new Error("fixture item absent"), { status: 44 });
          return keychain;
        }
        if (args[0] === "add-generic-password") {
          const isReplacement = ++keychainWrites === 1;
          if (keychain !== null && args.includes("-T") && options.denyAclChange) {
            throw new Error("fixture ACL authorization denied");
          }
          if (options.failBeforeWrite || (!isReplacement && options.rollbackFails)) throw new Error("fixture write denied");
          keychain = args[args.indexOf("-w") + 1];
          if (isReplacement && options.failAfterWrite) throw new Error("fixture write failed after data changed");
          return "";
        }
      }
      if (cmd === "ps") return (options.liveStatus || options.running)
        ? "fixture 4242 0 0 0 0 ?? S 0:00 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token abc-def" : "";
      if (cmd === "lsof") return "server 4242 fixture TCP 127.0.0.1:40001 (LISTEN)";
      if (cmd === "curl") {
        if (!options.liveStatus) throw new Error("fixture live status unavailable");
        return JSON.stringify({ userStatus: options.liveStatus });
      }
      throw new Error(`Unexpected command blocked: ${cmd}`);
    },
    spawn() { throw new Error("Unexpected spawn blocked"); }
  };
  if (options.desktopInstalled) dirs.add("/Applications/Antigravity.app/Contents/Resources/bin/language_server");
  const context = vm.createContext({ Buffer, console, URL, process: { pid: 5555, execPath: process.execPath, argv: [] } });
  const dependencies = {
    "node:fs": { default: mockFs }, "node:path": { default: path },
    "node:os": { default: { homedir: () => "/fixture-only" } },
    "node:crypto": { default: crypto }, "node:child_process": childProcess, "node:url": { fileURLToPath }
  };
  const filename = path.join(project, "src/core.mjs");
  const mod = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
    context, identifier: filename, initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; }
  });
  await mod.link((name) => {
    assert(name in dependencies, `Unmocked import blocked: ${name}`);
    const exports = dependencies[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const core = mod.namespace;
  return { core, files, calls, options, readErrors, fs: mockFs,
    write(p, value) { mockFs.writeFileSync(p, JSON.stringify(value)); },
    read(p) { return JSON.parse(mockFs.readFileSync(p, "utf8")); },
    keychainRaw() { return keychain; },
    keychain() { return core.parseKeychainSecret(keychain); }
  };
}
