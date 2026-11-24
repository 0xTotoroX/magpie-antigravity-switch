import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, auth, login, live, quota, future } from "./fixture.mjs";

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

test("CLI-only switch uses and confirms the shared Keychain for local agy 1.5", async () => {
  const old = "old@example.test", next = "next@example.test";
  const f = await fixture({ agyVersion: "1.5.12", keychain: auth(old), liveStatus: live(old) });
  const p = f.core.PATHS;
  f.write(p.loginsJson, [login(old), login(next)]);
  f.write(p.cliToken, auth("legacy@example.test"));
  f.write(p.standaloneToken, auth("legacy@example.test"));
  f.write(p.appStorage, { "jetski.onboarding.lastLoginUsername": old });
  assert.equal(f.core.getFullState().current.cliEmail, old);

  const result = f.core.switchAccount({ email: next, target: "cli", reloadDesktop: true });
  assert.equal(f.keychain().id_token_email, next);
  assert.equal(result.state.current.cliEmail, next);
  assert.equal(result.state.current.cliUsesSharedLogin, true);
  assert.equal(result.state.current.desktopRuntimeEmail, old);
  assert.equal(result.pending, true);
  assert.equal(result.reloadResult, null);
  assert.equal(f.read(p.appStorage)["jetski.onboarding.lastLoginUsername"], old);
  assert.equal(f.read(p.cliToken).id_token_email, "legacy@example.test");
  assert.equal(f.read(p.standaloneToken).id_token_email, "legacy@example.test");
  assert.equal(f.read(p.loginsJson).find(entry => entry.user === next).first, true);
});

test("older agy and remote SSH sessions retain CLI file-based switching", async () => {
  for (const options of [{ agyVersion: "1.4.9" }, { agyVersion: "1.5.12", env: { SSH_CONNECTION: "remote" } }]) {
    const old = "old@example.test", next = "next@example.test";
    const f = await fixture({ ...options, keychain: auth(old) });
    const p = f.core.PATHS;
    f.write(p.loginsJson, [login(next)]);
    const result = f.core.switchAccount({ email: next, target: "cli" });
    assert.equal(f.keychain().id_token_email, old);
    assert.equal(f.read(p.cliToken).id_token_email, next);
    assert.equal(f.read(p.standaloneToken).id_token_email, next);
    assert.equal(result.state.current.cliEmail, next);
    assert.equal(result.state.current.cliUsesSharedLogin, false);
  }
});

test("CLI-only switch leaves preferences alone if the Keychain does not confirm the account", async () => {
  const old = "old@example.test", next = "next@example.test";
  const f = await fixture({ agyVersion: "1.5.12", keychain: auth(old), ignoreKeychainWrite: true });
  const logins = [{ ...login(old), first: true }, login(next)];
  f.write(f.core.PATHS.loginsJson, logins);
  assert.throws(() => f.core.switchAccount({ email: next, target: "cli" }), /钥匙串未确认目标账号/);
  assert.deepEqual(f.read(f.core.PATHS.loginsJson), logins);
  assert.equal(f.core.getFullState().current.cliEmail, old);
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
  assert.equal(state.current.desktopPending, false);
  assert.equal(state.current.desktopConsistent, false);
  assert.equal(state.accounts[0].activeDesktop, false);
  assert.equal(state.accounts[0].pendingDesktop, false);
});

test("saving a login with unavailable live identity reports verification rather than a confirmed mismatch", async () => {
  const email = "next@example.test";
  const f = await fixture({ keychain: auth("old@example.test"), running: true });
  f.write(f.core.PATHS.loginsJson, [login(email)]);
  const result = f.core.executeCommandPayload({ id: "unknown-identity", type: "switch", email, target: "all" });
  assert.equal(result.ok, true);
  assert.equal(result.pending, false);
  assert.equal(result.desktopUnverified, true);
  assert.match(result.message, /桌面端账号待确认$/);
  assert.equal(f.core.getFullState().lastSwitch.pageMessage, `已保存登录 · ${email} · 桌面端账号待确认`);
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
  assert.equal(state.accounts.find(a => a.email === exhausted).score, 46.4);
});
test("#7 Magpie is authoritative even when the current desktop reports a different quota", async () => {
  const email = "live@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 0) });
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: quota(100, 20, 1) });
  const pools = f.core.getFullState().accounts[0].quota.pools;
  assert.equal(pools.find(p => p.window === "5 hours" && p.pool === "Claude & GPT").remaining, 100);
  assert.equal(pools.find(p => p.window === "7 days" && p.pool === "Claude & GPT").remaining, 20);
});
test("#7 saved local quota is ignored even when it is newer than Magpie", async () => {
  const email = "cached@example.test", f = await fixture();
  f.write(f.core.PATHS.loginsJson, [login(email)]);
  f.write(f.core.PATHS.vaultJson, { accounts: { [email]: { liveQuota: { updatedAt: Date.now() + 100000, pools: [{ pool: "Claude & GPT", window: "5 hours", remaining: 100 }] } } } });
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: quota(25, 50) });
  assert.equal(f.core.getFullState().accounts[0].quota.pools.find(p => p.window === "5 hours").remaining, 25);
});
test("#7 local status identifies the running account without capturing quota or tier", async () => {
  const email = "same@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 50) });
  const captured = f.core.captureLiveClientAccounts();
  assert.deepEqual(JSON.parse(JSON.stringify(captured.liveLs)), { email });
  const state = f.core.getFullState();
  assert.equal(state.current.desktopRuntimeEmail, email);
  assert.equal(state.accounts[0].quota, null);
  assert.equal(state.accounts[0].plan, null);
  assert.equal(f.read(f.core.PATHS.vaultJson).accounts[email].liveQuota, undefined);
});

test("#7 old local-only readings remain preserved but cannot classify or auto-import an account", async () => {
  const email = "legacy@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 100) });
  const legacyQuota = { updatedAt: Date.now(), plan: "Google AI Ultra (20x)", pools: [{ pool: "Claude & GPT", window: "7 days", remaining: 100 }] };
  f.write(f.core.PATHS.vaultJson, { accounts: { [email]: { plan: "Google AI Ultra (20x)", liveQuota: legacyQuota } } });
  const account = f.core.getFullState().accounts[0];
  assert.equal(account.quota, null);
  assert.equal(account.plan, null);
  assert.equal(account.isPaid, false);
  f.core.organizeAccounts();
  assert.deepEqual(f.read(f.core.PATHS.loginsJson), []);
  f.core.importAccountToMagpie(email);
  assert.equal(f.read(f.core.PATHS.loginsJson)[0].plan, undefined);
  assert.deepEqual(f.read(f.core.PATHS.vaultJson).accounts[email].liveQuota, legacyQuota);
});

test("#7 the four shared windows keep their order and ignore legacy Argon", async () => {
  const email = "windows@example.test", f = await fixture();
  const entry = quota(80, 60);
  entry.quota.windows.find(w => w.pool === "Gemini" && w.name === "7 days").used = 84;
  entry.quota.windows.reverse();
  f.write(f.core.PATHS.loginsJson, [login(email)]);
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: entry });
  const summary = f.core.getFullState().accounts[0].quota;
  assert.equal(summary.source, "magpie");
  assert.equal(summary.updatedAt, entry.at);
  assert.deepEqual(Array.from(summary.pools, p => [p.label, p.remaining]), [
    ["GPT / Claude 5h", 80], ["GPT / Claude 7d", 60],
    ["Gemini 5h", 100], ["Gemini 7d", 16]
  ]);
});

test("#7 missing, invalid and failed Magpie reads never fall back to local allowances", async () => {
  const email = "missing@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 100) });
  const entry = quota(80, 60);
  entry.quota.windows = entry.quota.windows.slice(0, 2);
  entry.quota.windows[0].used = null;
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: entry });
  assert.equal(f.core.getFullState().accounts[0].quota.pools.length, 1);
  entry.error = "quota request failed";
  f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: entry });
  const summary = f.core.getFullState().accounts[0].quota;
  assert.equal(summary.pools.length, 0);
  assert.equal(summary.error, entry.error);
});

test("#7 Gemini recommendations also respect the Magpie weekly limit", async () => {
  const f = await fixture();
  const exhausted = quota(50, 50), usable = quota(50, 50);
  exhausted.quota.windows.find(w => w.pool === "Gemini" && w.name === "7 days").used = 100;
  f.write(f.core.PATHS.loginsJson, [login("limited@example.test"), login("usable@example.test")]);
  f.write(f.core.PATHS.quotasJson, { "antigravity/limited@example.test": exhausted, "antigravity/usable@example.test": usable });
  assert.equal(f.core.getFullState().recommendedEmail, "usable@example.test");
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
  test(`#8 local plan ${plan} does not classify an account without Magpie tier data`, async () => {
    const email = "tier@example.test", f = await fixture({ keychain: auth(email), liveStatus: live(email, 50, plan) });
    const state = f.core.getFullState();
    assert.equal(state.accounts[0].isPro, false);
    assert.equal(state.accounts[0].plan, null);
    f.core.organizeAccounts();
    assert.equal(f.read(f.core.PATHS.loginsJson).length, 0);
  });
}

for (const [plan, family, paid, free] of [
  ["Google AI Pro", "pro", true, false],
  ["Google AI Ultra", "ultra", true, false],
  ["Google AI Ultra (5x)", "ultra", true, false],
  ["Google AI Ultra (20x)", "ultra", true, false],
  ["Enterprise", "enterprise", true, false],
  ["Gemini Enterprise", "enterprise", true, false],
  ["Antigravity Starter Quota", "free", false, true],
  ["Free", "free", false, true],
  ["Google AI Plus", "unknown", false, false],
  ["Professional Preview", "unknown", false, false]
]) {
  test(`membership preserves the observed name and eligibility for ${plan}`, async () => {
    const email = "membership@example.test";
    const f = await fixture({ keychain: auth(email), liveStatus: live(email, 50, plan) });
    const entry = quota(50, 50);
    entry.quota.plan = plan;
    f.write(f.core.PATHS.quotasJson, { [`antigravity/${email}`]: entry });
    const state = f.core.getFullState();
    const account = state.accounts[0];
    assert.equal(account.plan, plan);
    assert.equal(account.tierLabel, plan);
    assert.equal(account.planFamily, family);
    assert.equal(account.isPaid, paid);
    assert.equal(account.isPro, paid, "legacy member flag stays compatible");
    assert.equal(account.isFree, free);
    assert.equal(account.membershipKnown, paid || free);
    assert.equal(state.counts.paid, paid ? 1 : 0);
    assert.equal(state.counts.free, free ? 1 : 0);
    assert.equal(state.counts.unknown, paid || free ? 0 : 1);
    const result = f.core.organizeAccounts();
    assert.equal(f.read(f.core.PATHS.loginsJson).length, paid ? 1 : 0);
    assert.doesNotMatch(result.message, /Pro 会员/);
  });
}

test("an Ultra plan without a multiplier never invents 5x or 20x", async () => {
  const f = await fixture({ keychain: auth("ultra@example.test"), liveStatus: live("ultra@example.test", 100, "Google AI Ultra") });
  const entry = quota(100, 100);
  entry.quota.plan = "Google AI Ultra";
  f.write(f.core.PATHS.quotasJson, { "antigravity/ultra@example.test": entry });
  const account = f.core.getFullState().accounts[0];
  assert.equal(account.tierLabel, "Google AI Ultra");
  assert.doesNotMatch(account.tierLabel, /5x|20x/i);
});

test("member-only preferences keep the old storage key without a Pro-only label", async () => {
  const f = await fixture();
  const result = f.core.setPreferences({ onlyPro: true });
  assert.equal(result.state.preferences.onlyPro, true);
  assert.match(result.message, /仅显示已识别会员/);
  assert.doesNotMatch(result.message, /Pro 会员/);
});

test("plugin:agy-cli reads multi-account isolated homes, agy-cli quota windows and keeps missing plan eligible", async () => {
  const isoEmail = "isolated@example.test";
  const defEmail = "default@example.test";
  const f = await fixture({ keychain: auth(defEmail) });
  f.write(f.core.PATHS.loginsJson, [
    { agent: "plugin:agy-cli", home: "agy-cli#slot1", user: isoEmail, on: true },
    { agent: "plugin:agy-cli", home: "agy-cli", user: defEmail, on: true },
    { agent: "plugin:antigravity-bridge", home: "antigravity-bridge", user: "API key", on: true }
  ]);
  f.write(f.core.PATHS.pluginAuthJson, {
    "agy-cli#slot1": { type: "api", key: "k1", metadata: { email: isoEmail, agyHome: "abcd1234ef567890" } },
    "agy-cli": { type: "api", key: "k2", metadata: { email: defEmail } },
    "antigravity-bridge": { type: "api", key: "bridge-key" }
  });
  f.write("/fixture-only/.local/state/magpie-agy-bridge/accounts/abcd1234ef567890/.gemini/antigravity-cli/antigravity-oauth-token", {
    id_token_email: isoEmail,
    auth_method: "consumer",
    token: { access_token: "iso-access", refresh_token: "1//iso-refresh", expiry: future() }
  });
  f.write(f.core.PATHS.quotasJson, {
    [`agy-cli/${isoEmail}`]: {
      at: new Date().toISOString(),
      quota: {
        provider: "agy-cli",
        user: isoEmail,
        windows: [
          { name: "Gemini · 7 days", used: 12.5, remaining: 87.5, resetsAt: future() },
          { name: "Claude & GPT · 7 days", used: 0, remaining: 100, resetsAt: future() }
        ]
      }
    }
  });

  const state = f.core.getFullState();
  const iso = state.accounts.find((a) => a.email === isoEmail);
  const def = state.accounts.find((a) => a.email === defEmail);
  assert.equal(state.accounts.some((a) => a.email === "API key"), false);
  assert.equal(iso.isEligible, true);
  assert.equal(iso.plan, null);
  assert.equal(iso.tierLabel, "套餐未知");
  assert.equal(iso.agyCliMode, "isolated");
  assert.equal(iso.hasCredentials, true);
  assert.equal(iso.quotaProvider, "agy-cli");
  assert.deepEqual(
    Array.from(iso.quota.pools, (p) => [p.pool, p.window, p.remaining]),
    [
      ["Claude & GPT", "7 days", 100],
      ["Gemini", "7 days", 87.5]
    ]
  );
  assert.equal(def.isEligible, true);
  assert.equal(def.agyCliMode, "default");
  assert.equal(def.hasCredentials, true);

  const switched = f.core.switchAccount({ email: isoEmail, target: "all" });
  assert.equal(switched.ok, true);
  assert.equal(f.keychain().id_token_email, isoEmail);
  assert.equal(f.keychain().token.refresh_token, "1//iso-refresh");
  assert.equal(f.read(f.core.PATHS.cliToken).id_token_email, isoEmail);
  assert.equal(f.read(f.core.PATHS.loginsJson).find((item) => item.user === isoEmail).first, true);
  assert.equal(f.read(f.core.PATHS.loginsJson).find((item) => item.user === "API key").first, undefined);

  const organized = f.core.organizeAccounts();
  assert.equal(organized.ok, true);
  const loginsAfter = f.read(f.core.PATHS.loginsJson);
  assert.equal(loginsAfter.filter((item) => item.user === isoEmail).length, 1);
  assert.equal(loginsAfter.find((item) => item.user === isoEmail).on, true);
});

test("plugin:antigravity and plugin:agy-cli merge per email, strip piped project in oauth refresh and retain fresher quota", async () => {
  const email = "dual@example.test";
  const oldAt = new Date(Date.now() - 86_400_000).toISOString();
  const newAt = new Date().toISOString();
  const futureAgyMs = Date.now() + 7_200_000;
  const f = await fixture();
  f.write(f.core.PATHS.loginsJson, [
    { agent: "plugin:agy-cli", home: "agy-cli#abc123", user: email, on: true },
    { agent: "plugin:antigravity", home: "antigravity#def456", user: email, plan: "Google AI Pro", on: true }
  ]);
  f.write(f.core.PATHS.pluginAuthJson, {
    "antigravity#def456": {
      type: "oauth",
      access: "plugin-oauth-access",
      refresh: "1//bare-oauth-refresh|aicode-consumers",
      expires: Date.now() + 3_600_000,
      accountId: email
    },
    "agy-cli#abc123": {
      type: "api",
      key: "k",
      metadata: { email, agyHome: "deadbeef12345678" }
    }
  });
  f.write("/fixture-only/.local/state/magpie-agy-bridge/accounts/deadbeef12345678/.gemini/antigravity-cli/antigravity-oauth-token", {
    id_token_email: email,
    auth_method: "consumer",
    token: {
      access_token: "agy-newer-access",
      refresh_token: "1//agy-refresh",
      expiry: new Date(futureAgyMs).toISOString()
    }
  });
  f.write(f.core.PATHS.quotasJson, {
    [`antigravity/${email}`]: {
      at: oldAt,
      quota: {
        plan: "Google AI Pro",
        windows: [{ pool: "Claude & GPT", name: "5 hours", used: 50, resetsAt: future() }]
      }
    },
    [`agy-cli/${email}`]: {
      at: newAt,
      quota: {
        windows: [
          { name: "Claude & GPT · 5 hours", used: 10, remaining: 90, resetsAt: future() },
          { name: "Gemini · 7 days", used: 20, remaining: 80, resetsAt: future() }
        ]
      }
    }
  });

  const state = f.core.getFullState();
  assert.equal(state.accounts.length, 1);
  const acc = state.accounts[0];
  assert.equal(acc.plan, "Google AI Pro");
  assert.equal(acc.isPaid, true);
  assert.equal(acc.quotaProvider, "agy-cli");
  assert.equal(acc.quota.pools.find((p) => p.label === "GPT / Claude 5h").remaining, 90);
  assert.equal(acc.quota.pools.find((p) => p.label === "Gemini 7d").remaining, 80);

  // Uses freshest valid token across agyHome and plugin-auth oauth
  f.core.switchAccount({ email, target: "cli" });
  assert.equal(f.read(f.core.PATHS.cliToken).token.refresh_token, "1//agy-refresh");

  // Also verifies piped |project stripping when only plugin:antigravity oauth exists
  f.write("/fixture-only/.local/state/magpie-agy-bridge/accounts/deadbeef12345678/.gemini/antigravity-cli/antigravity-oauth-token", {});
  f.write(f.core.PATHS.cliToken, {});
  f.write(f.core.PATHS.standaloneToken, {});
  f.write(f.core.PATHS.vaultJson, { accounts: {} });
  f.core.switchAccount({ email, target: "cli" });
  assert.equal(f.read(f.core.PATHS.cliToken).token.refresh_token, "1//bare-oauth-refresh");
  assert.equal(f.core.getFullState().accounts[0].project, "aicode-consumers");
});

test("corrupt plugin-auth.json is preserved and surfaces state error without writing", async () => {
  const f = await fixture();
  f.fs.writeFileSync(f.core.PATHS.pluginAuthJson, "{broken");
  assert.match(f.core.syncStateFile().error, /plugin-auth\.json/);
  assert.equal(f.fs.readFileSync(f.core.PATHS.pluginAuthJson, "utf8"), "{broken");
  assert.throws(() => f.core.organizeAccounts(), /plugin-auth\.json/);
});


test("the page mirrors the agy-cli provider rather than the local backup", async () => {
  const f = await fixture({ keychain: auth("local@example.test"), agyVersion: "1.5.12" });
  const { loginsJson, pluginAuthJson, quotasJson, vaultJson } = f.core.PATHS;
  const known = "enabled@example.test";
  const providerLogins = [
    { agent: "plugin:agy-cli", user: known, home: "agy-cli", on: true },
    { agent: "plugin:agy-cli", user: "disabled@example.test", home: "agy-cli#disabled", on: false },
    { agent: "plugin:agy-cli", user: "hidden@example.test", home: "agy-cli#hidden", on: true, hidden: "removed" },
    { agent: "plugin:agy-cli", user: "revoked@example.test", home: "agy-cli#revoked", on: true, lapsed: "revoked" },
    { agent: "plugin:agy-cli", user: "stale@example.test", home: "agy-cli#stale", on: true },
    { agent: "plugin:antigravity", user: "other@example.test", home: "antigravity", on: true }
  ];
  const authEntry = (email) => ({ type: "api", metadata: { email } });
  f.write(loginsJson, providerLogins);
  f.write(pluginAuthJson, {
    "agy-cli": authEntry(known),
    "agy-cli#disabled": authEntry("disabled@example.test"),
    "agy-cli#hidden": authEntry("hidden@example.test"),
    "agy-cli#revoked": authEntry("revoked@example.test"),
    "antigravity": authEntry("other@example.test")
  });
  f.write(vaultJson, { accounts: { "backup@example.test": { auth: { refresh_token: "backup-token" } } } });
  f.write(quotasJson, {
    [`agy-cli/${known}`]: {
      at: new Date(Date.now() - 6000).toISOString(),
      quota: { plan: "Google AI Pro", windows: [{ name: "Gemini · 5 hours", used: 25, resetsAt: future() }] }
    },
    [`antigravity/${known}`]: {
      at: new Date().toISOString(),
      quota: { plan: "Antigravity Starter Quota", windows: [{ name: "Gemini · 5 hours", used: 100, resetsAt: future() }] }
    }
  });

  const state = f.core.syncStateFile();
  assert.deepEqual(Array.from(state.accounts, (a) => a.email).sort(),
    ["disabled@example.test", known, "revoked@example.test"]);
  assert.equal(state.accounts.find((a) => a.email === known).quota.pools[0].remaining, 75);
  assert.equal(state.accounts.find((a) => a.email === known).plan, "Google AI Pro");
  assert.equal(state.accounts.find((a) => a.email === "disabled@example.test").tierLabel, "已停用");
  assert.equal(state.accounts.find((a) => a.email === "revoked@example.test").isEligible, false);
  assert.equal(state.current.cliEmail, "local@example.test");

  f.write(loginsJson, providerLogins.filter((login) => login.user !== known));
  assert.equal(f.core.syncStateFile().accounts.some((a) => a.email === known), false);
  assert.ok(f.read(vaultJson).accounts["backup@example.test"]);
  assert.equal(f.keychain().id_token_email, "local@example.test");
});

test("missing agy-cli plan falls back to a named Antigravity login without switching or borrowing quotas", async () => {
  const email = "reader@example.test", active = "active@example.test";
  const f = await fixture({ keychain: auth(active), agyVersion: "1.5.12" });
  const { loginsJson, pluginAuthJson, quotasJson, cliQuotaCache } = f.core.PATHS;
  const cliLogin = { agent: "plugin:agy-cli", user: email, home: "agy-cli#reader", on: true };
  const saved = { agent: "plugin:antigravity", user: email.toUpperCase(), plan: "Google AI Pro" };
  const incidental = [
    { ...saved, user: "different@example.test", plan: "Enterprise" },
    { ...saved, hidden: true, plan: "Hidden plan" },
    { ...saved, user: "Alias", home: cliLogin.home, plan: "Other login" }
  ];
  f.write(pluginAuthJson, { [cliLogin.home]: { type: "api", metadata: { email } } });
  f.write(loginsJson, [cliLogin, ...incidental, saved]);
  const earlier = new Date(Date.now() - 60000).toISOString();
  const now = new Date().toISOString();
  const windows = [{ name: "Gemini · 5 hours", used: 40, resetsAt: future() }];
  f.write(quotasJson, {
    [`agy-cli/${email}`]: { at: earlier, quota: { plan: "Old quota plan", windows } },
    [`antigravity/${email}`]: { at: now, quota: { plan: "Other provider", windows: [
      { name: "Gemini · 7 days", used: 10, resetsAt: future() }
    ] } }
  });
  const cachePlan = (plan) => f.write(cliQuotaCache, { accounts: {
    [email]: { providerHome: cliLogin.home, fetchedAt: now, quota: { plan, windows } }
  } });
  cachePlan("  ");
  const state = f.core.syncStateFile();
  assert.equal(state.current.cliEmail, active);
  assert.deepEqual(Array.from(state.accounts, a => a.email), [email]);
  const [row] = state.accounts;
  assert.equal(row.plan, saved.plan);
  assert.equal(row.planFromLoginRecord, true);
  assert.equal(row.isPaid, true);
  assert.equal(row.quota.plan, null);
  assert.deepEqual(Array.from(row.quota.pools, p => p.remaining), [60]);

  cachePlan("Google AI Ultra");
  const direct = f.core.syncStateFile().accounts[0];
  assert.equal(direct.plan, "Google AI Ultra");
  assert.equal(direct.planFromLoginRecord, false);

  cachePlan(null);
  f.write(loginsJson, [cliLogin, ...incidental, { ...saved, agent: "antigravity" }]);
  assert.equal(f.core.syncStateFile().accounts[0].plan, saved.plan);
  f.write(loginsJson, [cliLogin, ...incidental]);
  const unknown = f.core.syncStateFile().accounts[0];
  assert.equal(unknown.tierLabel, "套餐未知");
  assert.equal(unknown.planFromLoginRecord, false);
  assert.deepEqual(f.read(loginsJson), [cliLogin, ...incidental]);
  assert.equal(f.keychain().id_token_email, active);
});

test("refresh queries only enabled Magpie accounts and rereads the roster after a deletion", async () => {
  const enabled = { agent: "plugin:agy-cli", user: "enabled@example.test", home: "agy-cli", on: true };
  const disabled = { agent: "plugin:agy-cli", user: "off@example.test", home: "agy-cli#off", on: false };
  const removed = { agent: "antigravity", user: "removed@example.test", on: true };
  const f = await fixture({ keychain: auth(enabled.user), agyVersion: "1.5.12" });
  const { loginsJson, pluginAuthJson, vaultJson } = f.core.PATHS;
  f.write(loginsJson, [enabled, disabled, removed]);
  f.write(pluginAuthJson, {
    "agy-cli": { type: "api", metadata: { email: enabled.user } },
    "agy-cli#off": { type: "oauth", refresh: "off-token", accountId: disabled.user },
    "agy-cli#removed": { type: "oauth", refresh: "removed-token", accountId: removed.user }
  });
  f.options.refreshQuota = (args, opts) => {
    assert.deepEqual(Array.from(args), ["quota", "refresh", "agy-cli", enabled.user, "--json"]);
    assert.equal(opts.env.AGY_BRIDGE_USAGE_TIMEOUT_MS, "18000");
    f.write(loginsJson, [disabled]);
    return { cards: [{ provider: "agy-cli", user: enabled.user, plan: "Google AI Pro",
      windows: [{ pool: "Gemini", name: "Gemini · 7 days", used: 25 }] }] };
  };

  const result = await f.core.refreshCliAccounts({ force: true });
  assert.equal(result.total, 1);
  assert.equal(result.refreshed, 1);
  assert.deepEqual(Array.from(result.state.accounts, (a) => a.email), [disabled.user]);
  assert.deepEqual(f.read(loginsJson), [disabled]);
  assert.equal(f.keychain().id_token_email, enabled.user);
  assert.ok(f.read(vaultJson).accounts[enabled.user]);
});

test("Magpie refresh keeps exact provider quotas, honors cache age and preserves values on failure", async () => {
  const email = "member@example.test";
  const f = await fixture();
  f.write(f.core.PATHS.loginsJson, [{ agent: "plugin:agy-cli", user: email, on: true }]);
  f.write(f.core.PATHS.pluginAuthJson, { "agy-cli": { metadata: { email } } });
  let nowMs = Date.now();
  const refresh = (force = false) => f.core.refreshCliAccounts({ force, now: () => nowMs });
  const windows = [
    { pool: "Claude & GPT", name: "Claude & GPT · 5 hours", used: 50, resetsAt: future() },
    { pool: "Gemini", name: "Gemini · 7 days", used: 25, resetsAt: future() },
    { pool: "Gemini 4 Argon", name: "Gemini 4 Argon · 7 days", used: 100, resetsAt: future() }
  ];
  const card = { provider: "agy-cli", user: email, plan: "Google AI Pro", windows };
  f.options.refreshQuota = () => ({ cards: [
    { ...card, provider: "antigravity", plan: "Other provider" },
    { ...card, user: "other@example.test", plan: "Another account" },
    card
  ] });
  const first = await refresh();
  assert.equal(first.refreshed, 1);
  assert.equal(first.state.accounts[0].tierLabel, "Google AI Pro");
  assert.deepEqual(Array.from(first.state.accounts[0].quota.pools, (p) => p.remaining), [50, 75]);

  nowMs += 60_000;
  const callsBefore = f.calls.length;
  const recent = await refresh();
  assert.equal(recent.skipped, 1);
  assert.equal(f.calls.slice(callsBefore).some((call) => call.cmd === "magpie"), false);

  f.options.refreshQuota = () => ({ cards: [card], stderr: "read 6s ago: not asked again before 30s have passed" });
  await f.core.executeCommandAsync({ type: "refresh", id: "cached-only", ts: Date.now() });
  assert.equal(f.core.syncStateFile().lastSwitch.pageMessage, "已沿用近期额度");
  const limited = await refresh(true);
  assert.equal(limited.refreshed, 0);
  assert.match(limited.message, /沿用 1 个账号的近期额度/);

  assert.equal(limited.state.accounts[0].quota.updatedAt, null);
  const readAt = new Date(nowMs - 60_000).toISOString();
  f.options.refreshQuota = () => ({ cards: [{ ...card, readAt, asOf: new Date(nowMs).toISOString() }] });
  const fallback = await refresh(true);
  assert.equal(fallback.state.accounts[0].quota.previousReading, true);
  assert.equal(fallback.state.accounts[0].quota.updatedAt, readAt);

  f.options.refreshQuota = () => ({ cards: [{ ...card, windows: [
    { pool: "Gemini", name: "Gemini · 7 days", used: 0, text: true },
    { pool: "Gemini", name: "Claude & GPT · 7 days", used: 0 }
  ] }] });
  const unreadable = await refresh(true);
  assert.equal(unreadable.refreshed, 0);
  assert.equal(unreadable.failed, 1);
  assert.match(unreadable.state.accounts[0].quota.refreshError, /未返回可显示的额度读数/);
  assert.deepEqual(Array.from(unreadable.state.accounts[0].quota.pools, (p) => p.remaining), [50, 75]);

  nowMs += 60_000;
  f.options.refreshQuota = () => ({ cards: [{ ...card, error: "agy usage query timed out.", windows: [] }] });
  const failed = await refresh(true);
  assert.equal(failed.failed, 1);
  assert.equal(failed.state.accounts[0].quota.pools.length, 2);
  assert.match(failed.state.accounts[0].quota.refreshError, /timed out/);
  assert.equal(failed.state.accounts[0].quota.updatedAt, readAt);
  const retryAt = f.read(f.core.PATHS.cliQuotaCache).accounts[email].retryAfter;
  nowMs = retryAt - 1;
  assert.equal((await refresh()).skipped, 1);
  nowMs = retryAt;
  f.options.refreshQuota = () => ({ cards: [card] });
  assert.equal((await refresh()).refreshed, 1);
});

test("manual refresh retries only timed-out accounts after the host cooldown", async () => {
  let now = Date.now();
  const waits = [];
  const f = await fixture({ onWait(ms) { waits.push(ms); now += ms; } });
  const users = ["slow@example.test", "ready@example.test", "expired@example.test", "network@example.test"];
  f.write(f.core.PATHS.loginsJson, users.map((user, i) => ({ agent: "plugin:agy-cli", home: "agy-cli/" + i, user, on: true })));
  f.write(f.core.PATHS.pluginAuthJson, Object.fromEntries(users.map((email, i) => ["agy-cli/" + i, { metadata: { email } }])));
  const calls = [];
  f.options.refreshQuota = (args) => {
    const user = args[3];
    calls.push(user);
    const card = { provider: "agy-cli", user };
    if (user === users[2]) card.error = "not signed in";
    else if (user === users[0] && calls.filter(value => value === user).length === 1) card.error = "agy usage query timed out.";
    else if (user === users[3] && calls.filter(value => value === user).length === 1) card.error = "agy's stored sign-in couldn't be renewed. Check the network or proxy.";
    else Object.assign(card, { readAt: new Date(now).toISOString(), windows: [{ pool: "Gemini", name: "7 days", used: 42 }] });
    return { cards: [card] };
  };
  const result = await f.core.refreshCliAccounts({ force: true, now: () => now });
  assert.deepEqual(calls, [...users, users[0], users[3]]);
  assert.deepEqual(waits, [31_000]);
  assert.equal(result.refreshed, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].email, users[2]);
  assert.equal(f.read(f.core.PATHS.cliQuotaCache).accounts[users[0]].quota.readAt, new Date(now).toISOString());
});

test("corrupt cliQuotaCache file is preserved without overwriting", async () => {
  const f = await fixture();
  f.fs.writeFileSync(f.core.PATHS.cliQuotaCache, "{broken");
  assert.match(f.core.syncStateFile().error, /antigravity-switch-cli-cache\.json/);
  assert.equal(f.fs.readFileSync(f.core.PATHS.cliQuotaCache, "utf8"), "{broken");
});

test("open-github command launches repository URL in default browser", async () => {
  const f = await fixture();
  const res = await f.core.executeCommandAsync({
    id: "cmd-open-github",
    ts: Date.now(),
    type: "open-github"
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "open-github");
  assert.equal(res.url, "https://github.com/0xTotoroX/magpie-antigravity-switch");
  assert(
    f.calls.some(
      (c) => c.cmd === "open" && c.args[0] === "https://github.com/0xTotoroX/magpie-antigravity-switch"
    )
  );
  const state = f.core.syncStateFile();
  assert.equal(state.lastSwitch?.cmdId, "cmd-open-github");
  assert.equal(state.lastSwitch?.ok, true);
  assert.equal(state.lastSwitch?.pageMessage, "");
});

test("Magpie refresh recognizes Ultra and reports Carbon separately", async () => {
  const email = "ultra@example.test";
  const f = await fixture();
  f.write(f.core.PATHS.loginsJson, [{ agent: "plugin:agy-cli", user: email, on: true }]);
  f.write(f.core.PATHS.pluginAuthJson, { "agy-cli": { type: "api", metadata: { email } } });
  f.options.refreshQuota = () => ({ cards: [{
    provider: "agy-cli", user: email, plan: "g1-ultra-tier",
    windows: [
      { name: "Gemini · 5 hours", used: 50 },
      { name: "Gemini 4 Argon · 7 days", used: 25 },
      { name: "Gemini 4 Carbon Models · 5 hours", used: 100 },
      { name: "Gemini 4 Carbon · 7 days", used: 60 }
    ]
  }] });
  const result = await f.core.refreshCliAccounts({ force: true });
  assert.equal(result.refreshed, 1);
  const account = result.state.accounts[0];
  assert.equal(account.planFamily, "ultra");
  assert.equal(account.tierLabel, "Google AI Ultra");
  assert.equal(account.isPaid, true);
  assert.deepEqual(Array.from(account.quota.pools, (pool) => [pool.label, pool.remaining]), [
    ["Gemini 5h", 50], ["Gemini 4 Carbon 5h", 0], ["Gemini 4 Carbon 7d", 40]
  ]);
});

test("refresh command results stay deduplicated and replace prior switch details on errors", async () => {
  const email = "current@example.test";
  const f = await fixture();
  const { PATHS } = f.core;
  f.write(PATHS.loginsJson, [{ agent: "plugin:agy-cli", user: email, on: true }]);
  f.write(PATHS.pluginAuthJson, { "agy-cli": { type: "api", metadata: { email } } });
  f.write(PATHS.vaultJson, { lastSwitch: { id: "previous-switch", target: "cli" } });
  f.options.refreshQuota = () => ({ cards: [{
    provider: "agy-cli", user: email, windows: [{ pool: "Gemini", name: "Gemini · 7 days", used: 25 }]
  }] });

  const cmd = { type: "refresh", id: "refresh-command", ts: Date.now() };
  assert.equal(await f.core.executeCommandAsync({ ...cmd, ts: cmd.ts - 31_000 }), null);
  assert.equal((await f.core.executeCommandAsync(cmd)).refreshed, 1);
  assert.equal(await f.core.executeCommandAsync(cmd), null);
  assert.equal(f.calls.filter(({ cmd: name }) => name === "magpie").length, 1);
  const refreshed = f.read(PATHS.vaultJson);
  assert.equal(refreshed.lastExecutedCmdId, cmd.id);
  assert.equal(refreshed.lastSwitch.pageMessage, "已刷新");
  assert.equal(refreshed.lastSwitch.cmdId, cmd.id);
  assert.equal(refreshed.lastSwitch.target, "cli");

  f.fs.writeFileSync(PATHS.loginsJson, "{broken");
  const failedId = "failed-refresh";
  const failed = await f.core.executeCommandAsync({ ...cmd, id: failedId });
  assert.equal(failed.ok, false);
  const afterFailure = f.read(PATHS.vaultJson);
  assert.equal(afterFailure.lastExecutedCmdId, failedId);
  assert.equal(afterFailure.lastSwitch.ok, false);
  assert.equal(afterFailure.lastSwitch.message, failed.error);
  assert.equal(afterFailure.lastSwitch.target, undefined);
});

test("a failed file replacement rolls back preceding switch writes and leaves the Keychain alone", async () => {
  const old = "old@example.test", next = "next@example.test";
  const f = await fixture({ keychain: auth(old) });
  const { PATHS } = f.core;
  f.write(PATHS.loginsJson, [{ ...login(old), first: true }, login(next)]);
  const original = '{ "jetski.onboarding.lastLoginUsername": "old@example.test" }\n';
  f.fs.writeFileSync(PATHS.appStorage, original);
  f.renameErrors.set(PATHS.standaloneToken, "EACCES");

  assert.throws(() => f.core.switchAccount({ email: next }), /fixture rename denied/);
  assert.equal(f.fs.readFileSync(PATHS.appStorage, "utf8"), original);
  assert.equal(f.fs.existsSync(PATHS.cliToken), false);
  assert.equal(f.fs.existsSync(PATHS.standaloneToken), false);
  assert.equal(f.read(PATHS.loginsJson)[0].first, true);
  assert.equal(f.keychain().id_token_email, old);
  assert(!f.calls.some(c => c.args[0] === "add-generic-password"));
  assert(![...f.files.keys()].some(file => file.includes(".tmp-")));
});

test("a reused provider home cannot switch a different email to its credentials", async () => {
  const f = await fixture();
  const { PATHS } = f.core;
  const old = "old@example.test", next = "next@example.test";
  f.write(PATHS.loginsJson, [{ agent: "plugin:agy-cli", user: old, home: "agy-cli#shared", on: true }]);
  f.write(PATHS.pluginAuthJson, { "agy-cli#shared": {
    type: "oauth", access: "unrelated-access", refresh: "unrelated-refresh",
    expires: Date.now() + 1000, metadata: { email: next }
  } });
  const account = f.core.getFullState().accounts.find(a => a.email === old);
  assert.equal(account.hasCredentials, false);
  assert.throws(() => f.core.switchAccount({ email: old }), /未找到账号/);
  assert.equal(f.keychainRaw(), null);
});

test("a fresh command can finish after waiting in the daemon queue", async () => {
  const f = await fixture();
  const receivedAt = Date.now() - 60_000;
  const cmd = { id: "queued", type: "refresh", ts: receivedAt - 10 };
  assert.equal(await f.core.executeCommandAsync(cmd), null);
  assert.equal((await f.core.executeCommandAsync(cmd, { receivedAt })).ok, true);
  assert.equal(f.read(f.core.PATHS.vaultJson).lastExecutedCmdId, cmd.id);
});

test("an old DevTools file and a lookalike process cannot trigger a desktop restart", async () => {
  const f = await fixture({ fakeProcessList:
    "4242 /bin/sh -c /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token abc-def"
  });
  f.fs.writeFileSync(f.core.PATHS.devToolsActivePort, "46800\n");
  f.fs.writeFileSync(f.core.PATHS.mainLog, "Language server crashed 3 times in a row. Giving up.\n");
  const result = f.core.reloadDesktopLanguageServer();
  assert.equal(result.reloaded, false);
  assert.match(result.reason, /当前未运行/);
  assert(!f.calls.some(c => ["kill", "killall", "open"].includes(c.cmd)));
});

test("preferring an account merges a login added while the switch was preparing", async () => {
  const old = "first@example.test", next = "second@example.test", added = login("added@example.test");
  const f = await fixture({ keychain: auth(old) });
  const list = f.core.PATHS.loginsJson;
  f.write(list, [{ ...login(old), first: true }, login(next)]);
  f.options.onLoginLock = () => f.write(list, [...f.read(list), added]);
  f.core.switchAccount({ email: next });
  const saved = f.read(list);
  assert.deepEqual(saved.find(x => x.user === added.user), added);
  assert.deepEqual(saved.filter(x => x.first).map(x => x.user), [next]);
});
