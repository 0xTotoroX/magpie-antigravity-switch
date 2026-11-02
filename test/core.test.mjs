import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, auth, login, live, quota } from "./fixture.mjs";

test("#1 new Keychain item has restricted ACL and never deletes", async () => {
  const f = await fixture({ desktopInstalled: true });
  f.core.writeKeychainAuth(auth("new@example.test"));
  assert.equal(f.keychain().id_token_email, "new@example.test");
  const args = f.calls.find(c => c.args[0].startsWith("add-generic")).args;
  assert(!args.includes("-A"));
  assert(args.includes("/Applications/Antigravity.app/Contents/Resources/bin/language_server"));
  assert.equal(args[args.indexOf("-T") + 1], "");
  assert(!f.calls.some(c => c.args[0].startsWith("delete-")));
});

test("#1 existing Keychain credentials can change without requesting ACL authorization", async () => {
  const f = await fixture({ keychain: auth("old@example.test"), desktopInstalled: true, denyAclChange: true });
  f.core.writeKeychainAuth(auth("new@example.test"));
  assert.equal(f.keychain().id_token_email, "new@example.test");
  const args = f.calls.find(c => c.args[0] === "add-generic-password").args;
  assert(args.includes("-U"));
  assert(!args.includes("-T"));
  assert(!args.includes("-A"));
  assert(!f.calls.some(c => c.args[0].startsWith("delete-")));
});

for (const failure of ["failBeforeWrite", "failAfterWrite"]) {
  test(`#2 ${failure} preserves exact previous credential`, async () => {
    const f = await fixture({ keychain: auth("old@example.test"), [failure]: true });
    const previous = f.keychainRaw();
    assert.throws(() => f.core.writeKeychainAuth(auth("new@example.test")), /旧凭据已保留/);
    assert.equal(f.keychainRaw(), previous);
    assert(!f.calls.some(c => c.args[0].startsWith("delete-")));
  });
}
test("#2 a failed rollback is surfaced instead of claiming preservation", async () => {
  const f = await fixture({ keychain: auth("old@example.test"), failAfterWrite: true, rollbackFails: true });
  assert.throws(() => f.core.writeKeychainAuth(auth("new@example.test")), /恢复失败/);
});
test("#2 denied credential read blocks replacement", async () => {
  const f = await fixture({ keychain: auth("old@example.test"), denyKeychainRead: true });
  assert.throws(() => f.core.writeKeychainAuth(auth("new@example.test")), /无法读取/);
  assert(!f.calls.some(c => c.args[0].startsWith("add-")));
});

for (const content of ["", "{invalid", "{}", "null"]) {
  test(`#3 organize preserves invalid login file ${JSON.stringify(content)}`, async () => {
    const f = await fixture();
    f.fs.writeFileSync(f.core.PATHS.loginsJson, content);
    assert.throws(() => f.core.organizeAccounts(), /格式无效/);
    assert.equal(f.fs.readFileSync(f.core.PATHS.loginsJson, "utf8"), content);
  });
}
test("#3 login read denial blocks all writing commands", async () => {
  for (const command of [f => f.core.organizeAccounts(), f => f.core.importAccountToMagpie("x@example.test"), f => f.core.switchAccount({ email: "x@example.test" })]) {
    const f = await fixture();
    f.readErrors.set(f.core.PATHS.loginsJson, "EACCES");
    assert.throws(() => command(f), /无法读取/);
    assert.equal(f.files.size, 0);
  }
});
test("#3 corrupt app storage blocks Keychain write; corrupt vault is preserved", async () => {
  const f = await fixture();
  f.fs.writeFileSync(f.core.PATHS.appStorage, "{broken");
  assert.throws(() => f.core.switchAccount({ email: "x@example.test" }), /app_storage/);
  assert.equal(f.calls.length, 0);
  f.fs.writeFileSync(f.core.PATHS.vaultJson, "{broken");
  assert.throws(() => f.core.setPreferences({ onlyPro: false }), /vault/);
  assert.equal(f.fs.readFileSync(f.core.PATHS.vaultJson, "utf8"), "{broken");
});
test("#3 safe state exposes configuration failure and recovers after repair", async () => {
  const f = await fixture();
  f.fs.writeFileSync(f.core.PATHS.loginsJson, "{broken");
  assert.match(f.core.syncStateFile().error, /logins/);
  f.write(f.core.PATHS.loginsJson, []);
  assert.equal(f.core.syncStateFile().error, undefined);
});
test("#3 valid organize preserves unrelated provider and credential fields", async () => {
  const f = await fixture();
  const other = { agent: "codex", user: "other@example.test", auth: { untouched: "fixture" } };
  f.write(f.core.PATHS.loginsJson, [other]);
  f.core.organizeAccounts();
  assert.deepEqual(f.read(f.core.PATHS.loginsJson), [other]);
});

test("#4 denied Keychain backup remains incomplete and can retry", async () => {
  const f = await fixture({ keychain: auth("x@example.test"), denyKeychainRead: true });
  assert.throws(() => f.core.ensureInitialBackup(), /无法读取/);
  assert.equal(f.fs.existsSync(f.core.PATHS.vaultJson), false);
  f.options.denyKeychainRead = false;
  const dir = f.core.ensureInitialBackup();
  assert(f.read(path.join(dir, "manifest.json")).complete);
  assert(f.fs.existsSync(path.join(dir, "keychain-gemini-antigravity.txt")));
  assert.equal(f.core.ensureInitialBackup(), dir);
});
test("#4 item not found is recorded as absent, not as a read failure", async () => {
  const f = await fixture();
  const dir = f.core.ensureInitialBackup();
  const manifest = f.read(path.join(dir, "manifest.json"));
  assert.equal(manifest.files["keychain-gemini-antigravity.txt"].absent, true);
  assert.equal(f.core.ensureInitialBackup(), dir);
});
test("#4 legacy and damaged backups are revalidated without deleting old copies", async () => {
  const f = await fixture({ keychain: auth("x@example.test") });
  const legacy = "/fixture-only/legacy";
  f.fs.mkdirSync(legacy);
  f.write(f.core.PATHS.vaultJson, { initialBackupPath: legacy });
  const first = f.core.ensureInitialBackup();
  assert.notEqual(first, legacy);
  assert.equal(f.read(path.join(first, "manifest.json")).previousBackupPath, legacy);
  f.fs.writeFileSync(path.join(first, "keychain-gemini-antigravity.txt"), "damaged");
  const second = f.core.ensureInitialBackup();
  assert.notEqual(second, first);
  assert(f.fs.existsSync(path.join(first, "manifest.json")));
});
test("#4 file read failure does not mark the backup complete", async () => {
  const f = await fixture();
  f.readErrors.set(f.core.PATHS.cliToken, "EACCES");
  assert.throws(() => f.core.ensureInitialBackup(), /无法备份/);
  assert.equal(f.fs.existsSync(f.core.PATHS.vaultJson), false);
});

test("#5 cooldown keeps running identity distinct from pending credentials", async () => {
  const old = "old@example.test", next = "next@example.test";
  const f = await fixture({ keychain: auth(old), liveStatus: live(old) });
  f.write(f.core.PATHS.loginsJson, [login(old), login(next)]);
  const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  f.fs.writeFileSync(f.core.PATHS.mainLog, `[${stamp}] Attempting restart 2/3\n`);
  const result = f.core.switchAccount({ email: next, target: "desktop", reloadDesktop: true, syncMagpie: false });
  assert.equal(result.reloadResult.reloaded, false);
  assert.equal(result.pending, true);
  assert.match(result.message, /待生效/);
  assert.equal(result.state.current.desktopEmail, old);
  assert.equal(result.state.current.desktopSavedEmail, next);
  assert.equal(result.state.current.desktopConsistent, false);
  assert.equal(result.state.accounts.find(a => a.email === next).pendingDesktop, true);
  f.options.liveStatus = live(next);
  const after = f.core.getFullState();
  assert.equal(after.current.desktopPending, false);
  assert.equal(after.current.desktopConsistent, true);
  assert.equal(after.current.desktopEmail, next);
});
test("#5 unavailable live identity is unknown, not guessed from Keychain", async () => {
  const f = await fixture({ keychain: auth("saved@example.test"), running: true });
  const state = f.core.getFullState();
  assert.equal(state.current.desktopEmail, null);
  assert.equal(state.current.desktopStatus, "unknown");
  assert.equal(state.current.desktopConsistent, false);
  assert.equal(state.accounts[0].activeDesktop, false);
});
test("#5 stopped desktop reports saved identity without marking it active", async () => {
  const f = await fixture({ keychain: auth("saved@example.test") });
  const state = f.core.getFullState();
  assert.equal(state.current.desktopStatus, "stopped");
  assert.equal(state.current.desktopSavedEmail, "saved@example.test");
  assert.equal(state.accounts[0].activeDesktop, false);
});

test("#6 recommendations use the most restrictive window in each pool", async () => {
  const f = await fixture(), exhausted = "exhausted@example.test", usable = "usable@example.test";
  f.write(f.core.PATHS.loginsJson, [login(exhausted), login(usable)]);
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${exhausted}`]: quota(100, 0), [`antigravity/${usable}`]: quota(70, 70) });
  const state = f.core.getFullState();
  assert.equal(state.recommendedEmail, usable);
  assert.equal(state.accounts.find(a => a.email === exhausted).score, 70);
});
test("#7 live quota replaces old matching window and preserves the weekly cap", async () => {
  const email = "live@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 0) });
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: quota(100, 20, 1) });
  const pools = f.core.getFullState().accounts[0].quota.pools;
  assert.equal(pools.find(p => p.window === "5 hours" && p.pool === "Claude & GPT").remaining, 0);
  assert.equal(pools.find(p => p.window === "7 days" && p.pool === "Claude & GPT").remaining, 20);
});
test("#7 a newer cache supersedes an older saved live reading", async () => {
  const email = "cached@example.test", f = await fixture();
  f.write(f.core.PATHS.loginsJson, [login(email)]);
  f.write(f.core.PATHS.vaultJson, { accounts: { [email]: { liveQuota: { updatedAt: 1, pools: [{ pool: "Claude & GPT", window: "5 hours", remaining: 100 }] } } } });
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: quota(25, 50) });
  assert.equal(f.core.getFullState().accounts[0].quota.pools.find(p => p.window === "5 hours").remaining, 25);
});
test("#7 equal live quota values still update their observation time", async () => {
  const email = "same@example.test", f = await fixture({ liveStatus: live(email, 50) });
  f.core.getFullState();
  const vault = f.read(f.core.PATHS.vaultJson);
  vault.accounts[email].liveQuota.updatedAt = 1;
  f.write(f.core.PATHS.vaultJson, vault);
  f.core.getFullState();
  assert(f.read(f.core.PATHS.vaultJson).accounts[email].liveQuota.updatedAt > 1);
});
test("#7 expired cache does not invent a full allowance", async () => {
  const email = "expired@example.test", f = await fixture();
  const entry = quota(0, 0);
  entry.quota.windows.forEach(w => { w.resetsAt = "2000-01-01T00:00:00Z"; });
  f.write(f.core.PATHS.loginsJson, [login(email)]);
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: entry });
  const pool = f.core.getFullState().accounts[0].quota.pools[0];
  assert.equal(pool.remaining, 0);
  assert.equal(pool.stale, true);
});

test("#8 unknown local plan remains unknown and organize does not auto-import it", async () => {
  const f = await fixture({ keychain: auth("unknown@example.test") });
  const state = f.core.getFullState();
  assert.equal(state.accounts[0].plan, null);
  assert.equal(state.accounts[0].isPro, false);
  assert.equal(state.accounts[0].tierLabel, "套餐未知");
  assert.equal(state.counts.unknown, 1);
  assert.equal(state.counts.free, 0);
  f.core.organizeAccounts();
  assert.deepEqual(f.read(f.core.PATHS.loginsJson), []);
  f.core.importAccountToMagpie("unknown@example.test");
  assert.equal(f.read(f.core.PATHS.loginsJson)[0].plan, undefined);
});
for (const plan of [null, "Starter", "Google AI Pro"]) {
  test(`#8 live plan ${plan} is not promoted beyond the observed tier`, async () => {
    const email = "tier@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 50, plan) });
    const state = f.core.getFullState();
    assert.equal(state.accounts[0].isPro, plan === "Google AI Pro");
    f.core.organizeAccounts();
    assert.equal(f.read(f.core.PATHS.loginsJson).length, plan === "Google AI Pro" ? 1 : 0);
  });
}
