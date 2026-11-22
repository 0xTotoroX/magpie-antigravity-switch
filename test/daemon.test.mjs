import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const daemonSource = new URL("../src/daemon.mjs", import.meta.url);

async function waitFor(read, message) {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const value = read();
    if (value) return value;
    await delay(40);
  }
  assert.fail(message);
}

test("the macOS watcher ignores a reused PID and hands off its lock when reloading", {
  skip: process.platform !== "darwin", timeout: 28_000
}, async (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-watcher-test-")));
  const state = path.join(temp, "state");
  fs.mkdirSync(state);
  const lock = path.join(state, "daemon.json");
  const trace = path.join(state, "trace");
  const release = path.join(state, "release");
  const plugins = path.join(state, "plugins.json");
  const backup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    if (backup.exitCode === null && backup.signalCode === null) backup.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const readTrace = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n") : [];
  const info = () => JSON.parse(fs.readFileSync(lock, "utf8"));

  function install(name) {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ magpie: { page: { service: { port: 0 } } } }));
    fs.copyFileSync(new URL("../src/page-service.mjs", import.meta.url), path.join(dir, "page-service.mjs"));
    const file = path.join(dir, "daemon.mjs");
    fs.copyFileSync(daemonSource, file);
    fs.writeFileSync(path.join(dir, "core.mjs"), `
      import fs from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      export const PATHS = ${JSON.stringify({
        magpieDir: state, daemonLock: lock, pluginsJson: plugins,
        cliToken: path.join(state, "cli"), appStorage: path.join(state, "desktop")
      })};
      export const PLUGIN_DIR = ${JSON.stringify(dir)};
      export const PLUGIN_NAME = "magpie-antigravity-switch";
      export function syncStateFile() {}
      export async function refreshCliAccounts() {}
      export async function executeCommandAsync(cmd, { receivedAt }) {
        if (fs.existsSync(${JSON.stringify(trace)}) && fs.readFileSync(${JSON.stringify(trace)}, "utf8").includes("done")) return;
        fs.appendFileSync(${JSON.stringify(trace)}, "started:" + process.pid + "\\n");
        while (!fs.existsSync(${JSON.stringify(release)})) await delay(25);
        fs.appendFileSync(${JSON.stringify(trace)}, "done:" + process.pid + ":" + (receivedAt >= cmd.ts) + "\\n");
      }
    `);
    return file;
  }
  const first = install("first");
  const launch = async (daemon, forPage = false) => {
    const script = `import { ensureBackgroundWatcher } from ${JSON.stringify(pathToFileURL(daemon).href)};
      console.log(JSON.stringify(ensureBackgroundWatcher({ forPage: ${forPage} })))`;
    const result = await run(process.execPath, ["--input-type=module", "-e", script]);
    return JSON.parse(result.stdout);
  };
  write(lock, { pid: backup.pid, script: first, signature: "from-an-old-install" });
  const starts = await Promise.all([launch(first), launch(first), launch(first)]);
  assert.equal(starts.filter((result) => result.started).length, 1);
  const firstPid = starts.find((result) => result.started).pid;
  await waitFor(() => info().version === 2 && info().pid === firstPid, "watcher did not publish its PID");
  assert.equal(backup.exitCode, null);
  assert.equal(backup.signalCode, null);
  assert.equal((await launch(first)).pid, firstPid);

  write(plugins, { plugins: [{ spec: path.dirname(first), options: { cmd: {
    id: "manual-refresh", type: "refresh", ts: Date.now()
  } } }] });
  await waitFor(() => readTrace().includes(`started:${firstPid}`), "watcher did not receive the command");
  fs.appendFileSync(first, "\n// updated source\n");
  await delay(4_200);
  assert.equal(info().pid, firstPid, "reload interrupted an in-flight command");
  fs.writeFileSync(release, "");
  await waitFor(() => info().pid !== firstPid, "watcher did not reload");
  assert.deepEqual(readTrace(), [`started:${firstPid}`, `done:${firstPid}:true`]);

  const second = install("second");
  await launch(second, true);
  await waitFor(() => info().script === second, "watcher did not follow the registered page installation");
  assert.equal((await launch(first)).pid, info().pid, "CLI should reuse the page's watcher");
  assert.equal(backup.exitCode, null);
  assert.equal(backup.signalCode, null);
});
