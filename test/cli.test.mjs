import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { project } from "./fixture.mjs";

test("#9 direct, relative and installed-style symlink CLI entries all run help", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const link = path.join(temp, "magpie-agy-switch");
  fs.symlinkSync(path.join(project, "index.mjs"), link);
  for (const [entry, cwd] of [[path.join(project, "index.mjs"), temp], ["./index.mjs", project], [link, temp]]) {
    const result = spawnSync(process.execPath, [entry, "help"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /用法/);
    assert.match(result.stdout, /switch <email\|best>/);
  }
});

test("#9 plugin import does not run the CLI", () => {
  const url = pathToFileURL(path.join(project, "index.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
