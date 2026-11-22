import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startPageService } from "../src/page-service.mjs";

test("the local page reads its projection and submits refresh and switch without plugin options", async t => {
  const pageDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-page-"));
  const connection = path.join(pageDir, ".runtime/connection.js");
  const received = [];
  const state = { accounts: [{ email: "member@example.test" }] };
  const stop = startPageService({ pageDir, port: 0, getState: () => state,
    submit: async cmd => { received.push(cmd); return { ...state, lastSwitch: { cmdId: cmd.id } }; }
  });
  t.after(async () => { stop(); await fs.rm(pageDir, { recursive: true, force: true }); });
  let file;
  for (let i = 0; i < 100 && !file; i++) {
    try { file = await fs.readFile(connection, "utf8"); } catch { await delay(10); }
  }
  assert.ok(file);
  const { key, port } = JSON.parse(file.split(" = ")[1].split(";")[0]);
  const base = "http://127.0.0.1:" + port;
  const headers = { authorization: "Bearer " + key, origin: "null", "content-type": "application/json" };
  assert.equal((await fetch(base + "/state")).status, 403);
  assert.deepEqual(await (await fetch(base + "/state", { headers })).json(), state);
  assert.equal((await fetch(base + "/.runtime/connection.js")).status, 404);
  for (const cmd of [{ type: "refresh", id: "cmd-refresh" }, { type: "switch", target: "all", email: state.accounts[0].email, id: "cmd-switch" }]) {
    const response = await fetch(base + "/command", { method: "POST", headers, body: JSON.stringify(cmd) });
    assert.equal((await response.json()).lastSwitch.cmdId, cmd.id);
  }
  assert.deepEqual(received.map(c => c.type), ["refresh", "switch"]);
  assert.equal(received[1].reloadDesktop, true);
  assert.equal(received[1].syncMagpie, true);
});
