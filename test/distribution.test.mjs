import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { readPendingCommand } from "../src/daemon.mjs";
import { PLUGIN_DIR } from "../src/core.mjs";

test("Magpie v1 host initializes only when server is called", async () => {
  let starts = 0;
  const result = {};
  const context = vm.createContext({});
  const entry = new vm.SourceTextModule(fs.readFileSync(new URL("../host.mjs", import.meta.url), "utf8"), { context });
  await entry.link((name) => {
    assert.equal(name, "./index.mjs");
    return new vm.SyntheticModule(["AntigravitySwitchPlugin"], function () {
      this.setExport("AntigravitySwitchPlugin", async () => { starts++; return result; });
    }, { context });
  });
  await entry.evaluate();
  assert.equal(starts, 0);
  assert.equal(entry.namespace.default.id, "antigravity-switch");
  assert.equal(await entry.namespace.default.server({}, {}), result);
  assert.equal(starts, 1);
});

for (const spec of ["magpie-antigravity-switch@0.1.2", "@magpie-community/page-antigravity-switch@0.1.2", "/fixture/magpie-antigravity-switch"]) {
  test(`page commands reach the watcher for ${spec}`, () => {
    const cmd = { id: "fixture-command", type: "refresh" };
    assert.equal(readPendingCommand({ plugins: [{ spec, options: { cmd } }] }), cmd);
    assert.equal(readPendingCommand({ items: [{ spec, options: { pendingCommand: cmd } }] }), cmd);
  });
}

test("legacy and community keyed options work while unrelated options are ignored", () => {
  const cmd = { id: "fixture-command", type: "refresh" };
  for (const name of ["magpie-antigravity-switch", "@magpie-community/page-antigravity-switch"]) {
    assert.equal(readPendingCommand({ [name]: { cmd } }), cmd);
  }
  assert.equal(readPendingCommand({ plugins: [{ spec: "another-plugin", options: { cmd } }] }), null);
  assert.equal(readPendingCommand(null), null);
});

test("sandboxed page requests no undeclared reads or external network", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const html = fs.readFileSync(new URL("../page/index.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../page/app.js", import.meta.url), "utf8");
  assert.deepEqual(pkg.magpie.permissions, []);
  assert.doesNotMatch(script, /magpie\s*\.\s*read\s*\(/);
  assert.doesNotMatch(script, /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.equal(match[2].trim(), "");
    assert.match(match[1], /\bsrc="(?!https?:|\/\/)[^"]+"/);
  }
});

test("a local community checkout works even when its folder differs from the package name", () => {
  const cmd = { id: "fixture-local-command", type: "refresh" };
  assert.equal(readPendingCommand({ plugins: [{ spec: PLUGIN_DIR, options: { cmd } }] }), cmd);
  assert.equal(readPendingCommand({ plugins: [{ spec: `file:${PLUGIN_DIR}`, options: { cmd } }] }), cmd);
});
