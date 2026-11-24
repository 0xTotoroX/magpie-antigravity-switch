import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { project } from "./fixture.mjs";

function page(state, language = "zh-CN", send) {
  const elements = new Map();
  let click, toastTimer;
  class Element {
    constructor(selector, attrs) { this.selector = selector; this.attrs = attrs; }
    closest(selector) { return selector === this.selector ? this : null; }
    getAttribute(name) { return this.attrs?.[name]; }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        const attributes = new Map();
        elements.set(id, { textContent: "", innerHTML: "", disabled: false, className: "", title: "",
          addEventListener() {}, showModal() { this.open = true; },
          setAttribute: (name, value) => attributes.set(name, value),
          getAttribute: (name) => attributes.get(name),
          classList: { add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: c => classes.has(c) }
        });
      }
      return elements.get(id);
    },
    addEventListener(type, handler) { if (type === "click") click = handler; },
    createElement: () => ({ remove() {} }),
    body: { appendChild: (script) => script.onload() }
  };
  let localeChanged;
  const magpie = { theme: { lang: language }, onTheme: (callback) => { localeChanged = callback; } };
  const agyPage = { state: async () => state, command: send };
  const context = vm.createContext({
    document, magpie, agyPage, Element,
    setInterval() {},
    setTimeout(callback) { toastTimer = callback; },
    clearTimeout() { toastTimer = null; },
    __AGY_SWITCH_STATE__: state
  });
  vm.runInContext(fs.readFileSync(path.join(project, "page/i18n.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(project, "page/app.js"), "utf8"), context);
  return { el: id => document.getElementById(id), render: state => context.__AGY_SWITCH_ON_STATE__(state),
    setLanguage: (lang) => localeChanged({ lang }),
    clickSaved: () => click({ target: new Element('[data-action="saved-login-detail"]') }),
    clickFeedback: () => click({ target: new Element('[data-action="feedback-detail"]') }),
    clickRefresh: () => click({ target: new Element("#btnRefresh") }),
    clickQuotaStatus: () => click({ target: new Element("#quotaStatus") }),
    clickCliToggle: () => click({ target: new Element("#btnToggleCli") }),
    clickSwitch: (email, action = "switch-all") => click({ target: new Element("[data-action]", { "data-action": action, "data-email": email }) }),
    expireToast: () => toastTimer?.()
  };
}
const baseState = () => ({ current: {}, hideCliAction: false, counts: { pro: 0, free: 0, unknown: 0, ineligible: 0 }, accounts: [], preferences: { onlyPro: false } });

function accountRow(html, email) {
  return html.split('<div class="account-row">').find((row) => row.startsWith("\n") && row.includes(`title="${email}">${email}</span>`)) || "";
}

test("#5 legacy snapshot flags cannot mark a desktop session active or offer Apply", () => {
  const state = baseState();
  state.current = { desktopEmail: "old@example.test", desktopSavedEmail: "next@example.test", desktopRunning: true, desktopPending: true };
  state.accounts = [
    { email: "old@example.test", activeDesktop: true, hasCredentials: true, isEligible: true, isPaid: true },
    { email: "next@example.test", pendingDesktop: true, savedDesktop: true, activeCli: true, hasCredentials: true, isEligible: true, isPaid: false },
    { email: "magpie@example.test", activeMagpieFirst: true, hasCredentials: true, isEligible: true, isPaid: false }
  ];
  state.recommendedEmail = "next@example.test";
  const p = page(state), html = p.el("accountList").innerHTML;
  assert.doesNotMatch(accountRow(html, "old@example.test"), /tag-active">桌面端</);
  assert.match(accountRow(html, "next@example.test"), /tag tag-cli" title="[^"]+">CLI</);
  assert.doesNotMatch(accountRow(html, "next@example.test"), /待确认|desktop-mark/);
  assert.doesNotMatch(html, /应用到桌面/);
  assert.doesNotMatch(accountRow(html, "next@example.test"), />桌面端待生效</);
  assert.doesNotMatch(accountRow(html, "next@example.test"), /tag-active">桌面端</);
  assert.match(accountRow(html, "magpie@example.test"), /tag-active">Magpie 首选</);
  assert.doesNotMatch(html, /当前使用中|推荐|is-current/);
});

test("#5 page still marks a confirmed saved login when the desktop is closed", () => {
  const state = baseState();
  const p = page({ ...state, current: { desktopSavedEmail: "saved@example.test", desktopStatus: "stopped" },
    accounts: [{ email: "saved@example.test", savedDesktop: true, activeDesktopKeychain: true, isEligible: true }] });
  const html = p.el("accountList").innerHTML;
  assert.match(html, /account-email" title="saved@example.test">saved@example.test<\/span><button[^>]*class="desktop-mark"/);
  assert.doesNotMatch(html, /tag-active">桌面端</);
});

test("an unverified desktop keeps the regular switch actions without a standing warning", () => {
  const email = "saved@example.test";
  const state = baseState();
  state.current = { desktopRunning: true, desktopStatus: "unknown", desktopSavedEmail: email };
  state.accounts = [
    { email, savedDesktop: true, activeCli: true, pendingDesktop: true, isEligible: true, hasCredentials: true },
    { email: "another@example.test", isEligible: true, hasCredentials: true }
  ];
  const p = page(state), html = p.el("accountList").innerHTML;
  assert.match(accountRow(html, email), /data-action="switch-all"/);
  assert.doesNotMatch(accountRow(html, email), /action-apply|icon-check|待确认/);
  assert.match(accountRow(html, "another@example.test"), /data-action="switch-all"/);
});

test("the CLI-only control describes the shared login for recent local agy", () => {
  const state = baseState();
  state.current = { cliEmail: "old@example.test", cliUsesSharedLogin: true };
  state.accounts = [{ email: "next@example.test", isPaid: true, isEligible: true, hasCredentials: true }];
  assert.match(page(state).el("accountList").innerHTML, /title="新启动的 CLI 和桌面端共用此登录"/);
});

test("CLI actions and tags start hidden and reopen in the last selected state", async () => {
  const email = "cli@example.test";
  const state = { ...baseState(), hideCliAction: undefined, accounts: [{ email, activeCli: true, isEligible: true, hasCredentials: true }] };
  const setVisibility = async cmd => {
    assert.equal(cmd.type, "set-cli-visibility");
    state.hideCliAction = cmd.hidden;
    return { hideCliAction: cmd.hidden };
  };
  const p = page(state, "zh", setVisibility);
  assert.equal(p.el("btnToggleCli").getAttribute("aria-pressed"), "false");
  assert.equal(p.el("btnToggleCli").title, "显示 CLI 标签和操作");
  assert(p.el("switchPage").classList.contains("hide-cli-actions"));
  const row = accountRow(p.el("accountList").innerHTML, email);
  assert.doesNotMatch(row, /data-action="switch-cli"/);
  assert.match(row, /data-action="switch-all"/);
  assert.doesNotMatch(row, /tag tag-cli/);
  p.clickCliToggle();
  await new Promise(setImmediate);
  assert.equal(p.el("btnToggleCli").getAttribute("aria-pressed"), "true");
  assert.match(p.el("accountList").innerHTML, /tag tag-cli" title="[^"]+">CLI</);
  assert.match(p.el("accountList").innerHTML, /data-action="switch-cli"/);
  const reopened = page(state, "en", setVisibility);
  assert.equal(reopened.el("btnToggleCli").getAttribute("aria-pressed"), "true");
  assert.equal(reopened.el("btnToggleCli").title, "Hide CLI tags and actions");
  reopened.clickCliToggle();
  await new Promise(setImmediate);
  assert.doesNotMatch(reopened.el("accountList").innerHTML, /data-action="switch-cli"|tag tag-cli/);
  assert.equal(page(state, "zh").el("btnToggleCli").getAttribute("aria-pressed"), "false");
});

test("#8 page does not describe an unknown quota or plan as normal or free", () => {
  const state = baseState();
  state.preferences.onlyPro = false;
  state.counts.unknown = 1;
  state.accounts = [{ email: "unknown@example.test", isEligible: true, hasCredentials: true, tierLabel: "套餐未知" }];
  const p = page(state);
  assert.match(p.el("accountList").innerHTML, /套餐未知/);
  assert.match(p.el("accountList").innerHTML, /GPT \/ Claude 5h：未知/);
  assert.doesNotMatch(p.el("accountList").innerHTML, /配额正常/);
});
test("#3 page surfaces read errors, disables writes and clears the recovered error", () => {
  const p = page({ ...baseState(), error: "logins.json 格式无效，已保留原文件" });
  assert.match(p.el("toastBanner").textContent, /保留原文件/);
  assert.equal(p.el("btnRefresh").disabled, false);
  p.render(baseState());
  assert.equal(p.el("btnRefresh").disabled, false);
  assert.equal(p.el("toastBanner").classList.contains("hidden"), true);
});

test("the provider list abbreviates known tiers and retains multipliers even with an older member-only preference", () => {
  const state = baseState();
  state.preferences.onlyPro = true;
  state.accounts = ["Google AI Pro", "Google AI Ultra (5x)", "Google AI Ultra (20x)", "Enterprise"].map((plan, i) => ({
    email: `paid-${i}@example.test`, tierLabel: plan, plan,
    isPaid: true, isPro: false, isEligible: true, hasCredentials: true
  }));
  state.accounts.push({ email: "free@example.test", tierLabel: "Starter", isPaid: false, isEligible: true });
  state.accounts.push({ email: "unknown@example.test", tierLabel: "Unrecognized plan", isPaid: false, isEligible: true });
  const p = page(state);
  const rows = p.el("accountList").innerHTML;
  for (const plan of ["Pro", "Ultra (5x)", "Ultra (20x)", "Enterprise", "Unrecognized plan"]) assert(rows.includes(`>${plan}</span>`));
  assert.match(rows, /free@example.test/);
  assert.match(rows, /unknown@example.test/);
});

test("quota columns stay in model/window order regardless of input order", () => {
  const state = baseState();
  state.accounts = [{ email: "columns@example.test", isPaid: true, isEligible: true, hasCredentials: true,
    quota: { updatedAt: Date.now(), pools: [
      { pool: "Gemini 4 Argon", window: "7 days", remaining: 30 },
      { pool: "Gemini", window: "7 days", remaining: 84 },
      { pool: "Claude & GPT", window: "7 days", remaining: 0 },
      { pool: "Gemini", window: "5 hours", remaining: 86 },
      { pool: "Claude & GPT", window: "5 hours", remaining: 100 }
    ] }
  }];
  const html = page(state).el("accountList").innerHTML;
  assert.deepEqual(html.match(/aria-label="[^"]+：[^"]+"/g), [
    'aria-label="Gemini 5h：86%"', 'aria-label="Gemini 7d：84%"',
    'aria-label="GPT / Claude 5h：100%"', 'aria-label="GPT / Claude 7d：0%"'
  ]);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /--remaining:0%/);
  assert.doesNotMatch(html, /Argon|5 小时|7 天|>账号<|>操作</);
});

test("missing, invalid and expired cells keep their position without inventing zero", () => {
  const state = baseState();
  state.accounts = [{ email: "states@example.test", isPaid: true, isEligible: true, hasCredentials: true,
    quota: { pools: [
      { pool: "Claude & GPT", window: "5 hours", remaining: 0 },
      { pool: "Claude & GPT", window: "7 days", remaining: 90, resetsAt: "2000-01-01T00:00:00Z" },
      { pool: "Gemini", window: "5 hours", remaining: null }
    ] }
  }];
  const html = page(state).el("accountList").innerHTML;
  assert.deepEqual(html.match(/aria-label="[^"]+：[^"]+"/g), [
    'aria-label="Gemini 5h：未知"', 'aria-label="Gemini 7d：未知"',
    'aria-label="GPT / Claude 5h：0%"', 'aria-label="GPT / Claude 7d：待刷新"'
  ]);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 1);
  assert.match(html, /Gemini 5h：未知">—</);
});

test("account types are separate sections and inactive accounts stay collapsed across updates", () => {
  const state = baseState();
  state.preferences.onlyPro = false;
  state.accounts = [
    { email: "unknown@example.test", isEligible: true, hasCredentials: true },
    { email: "free@example.test", isEligible: true, isFree: true, plan: "Starter", hasCredentials: true },
    { email: "paid@example.test", isEligible: true, isPaid: true, plan: "Google AI Ultra (20x)", hasCredentials: true },
    { email: "unavailable@example.test", isEligible: false, tierLabel: "已停用", ineligibleReason: "已在 Magpie 停用" }
  ];
  const p = page(state), html = p.el("accountList").innerHTML;
  assert(html.indexOf('aria-label="会员账号"') < html.indexOf('aria-label="免费账号"'));
  assert(html.indexOf('aria-label="免费账号"') < html.indexOf('aria-label="套餐未知"'));
  assert.match(html, />Ultra \(20x\)</);
  assert.doesNotMatch(html, /unavailable@example.test/);
  const disabledRow = p.el("unavailableList").innerHTML;
  assert.match(disabledRow, /unavailable@example.test/);
  assert.match(disabledRow, /已停用/);
  assert.equal(disabledRow.match(/已停用/g)?.length, 1);
  assert.doesNotMatch(disabledRow, /已在 Magpie 停用/);
  assert.doesNotMatch(disabledRow, /data-action="switch/);
  assert.equal(p.el("unavailableAccounts").hidden, false);
  p.el("unavailableAccounts").open = true;
  p.render(state);
  assert.equal(p.el("unavailableAccounts").open, true);
});

test("Carbon appears only for the windows supplied by an eligible account", () => {
  const state = baseState();
  const ultra = { email: "ultra@example.test", isEligible: true, isPaid: true, tierLabel: "Google AI Ultra" };
  const pro = { email: "pro@example.test", isEligible: true, isPaid: true, tierLabel: "Google AI Pro" };
  state.accounts = [ultra, pro];
  const p = page(state);
  assert.doesNotMatch(p.el("accountList").innerHTML, /Gemini 4 Carbon/);

  ultra.quota = { pools: [{ pool: "Gemini 4 Carbon", window: "7 days", remaining: 0 }] };
  p.render(state);
  let html = p.el("accountList").innerHTML;
  assert.deepEqual([...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]), ["Gemini", "Gemini 4 Carbon", "GPT / Claude"]);
  assert.match(accountRow(html, ultra.email), /Gemini 4 Carbon 7d：0%/);
  assert.match(accountRow(html, pro.email), /Gemini 4 Carbon 7d：未知/);
  assert.doesNotMatch(html, /Gemini 4 Carbon 5h/);

  ultra.quota.pools.push({ pool: "Gemini 4 Carbon", window: "5 hours", remaining: 60 });
  p.render(state);
  html = p.el("accountList").innerHTML;
  assert.match(accountRow(html, ultra.email), /Gemini 4 Carbon 5h：60%/);
  assert.match(html, /--carbon-width: 2fr/);

  ultra.quota.previousReading = true;
  p.render(state);
  assert.doesNotMatch(p.el("accountList").innerHTML, /Gemini 4 Carbon/);
  ultra.quota.previousReading = false;
  ultra.quota.pools[0].stale = true;
  ultra.quota.pools[1].resetsAt = "2000-01-01T00:00:00Z";
  p.render(state);
  assert.doesNotMatch(p.el("accountList").innerHTML, /Gemini 4 Carbon/);
});

test("the page follows Magpie language changes and keeps tier multipliers", async () => {
  const state = baseState();
  state.accounts = [{
    email: "member@example.test", plan: "Google AI Ultra (20x)", isEligible: true, isPaid: true,
    hasCredentials: true, activeMagpieFirst: true,
    quota: { pools: [
      { pool: "Gemini", window: "5 hours", remaining: 8, resetsAt: new Date(Date.now() + 32 * 60_000).toISOString() },
      { pool: "Gemini", window: "7 days", remaining: 75, resetsAt: new Date(Date.now() + (6 * 60 + 32) * 60_000).toISOString() },
      { pool: "Claude & GPT", window: "7 days", remaining: 75, resetsAt: new Date(Date.now() + (6 * 24 + 4) * 3600_000).toISOString() }
    ] }
  }];
  const p = page(state, "en-US", async (cmd) => ({ ...state, lastSwitch: { cmdId: cmd.id, ok: true, pageMessage: "已刷新" } }));
  assert.equal(p.el("refreshLabel").textContent, "Refresh");
  let html = p.el("accountList").innerHTML;
  assert.match(html, /Paid accounts/);
  assert.match(html, /Magpie preferred/);
  assert.match(html, />Ultra \(20x\)</);
  assert.match(html, /Gemini 5h: 8%/);
  assert.match(html, /Reset time: /);
  for (const value of ["32min", "6h32min", "6d4h"]) assert.ok(html.includes(`>${value}</span>`));
  assert.match(html, /CLI only/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);

  await p.clickRefresh();
  await new Promise(setImmediate);
  assert.equal(p.el("refreshLabel").textContent, "Refreshed");
  p.setLanguage("zh-CN");
  assert.equal(p.el("refreshLabel").textContent, "已刷新");
  html = p.el("accountList").innerHTML;
  assert.match(html, /Magpie 首选/);
  for (const value of ["32min", "6h32min", "6d4h"]) assert.ok(html.includes(`>${value}</span>`));
  assert.doesNotMatch(html, /小时后|分后|天后/);
  p.expireToast();
  assert.equal(p.el("refreshLabel").textContent, "刷新");
});

test("a cached-only refresh reports the previous reading in the toolbar", async () => {
  const state = baseState();
  const p = page(state, "zh-CN", async (cmd) => ({
    ...state, lastSwitch: { cmdId: cmd.id, ok: true, pageMessage: "已沿用近期额度" }
  }));
  await p.clickRefresh();
  await new Promise(setImmediate);
  assert.equal(p.el("refreshLabel").textContent, "已沿用近期额度");
  p.setLanguage("en-US");
  assert.equal(p.el("refreshLabel").textContent, "Showing recent quotas");
});

test("live and saved plan names share short labels in both languages", () => {
  const state = baseState();
  const row = { email: "saved@example.test", isEligible: true, plan: "Google AI Pro", planFromLoginRecord: true };
  state.accounts = [row, { ...row, email: "starter@example.test", plan: "Antigravity Starter Quota" }];
  const p = page(state);
  for (const language of ["zh-CN", "en-US"]) {
    p.setLanguage(language);
    const html = p.el("accountList").innerHTML;
    assert.match(html, />Pro</);
    assert.match(html, />Starter</);
    assert.doesNotMatch(html, /上次记录|Last recorded|Google AI Pro/);
  }
  p.render({ ...state, accounts: [{ ...row, planFromLoginRecord: false }] });
  assert.match(p.el("accountList").innerHTML, />Pro</);
});

test("English shows recoverable configuration errors and disabled provider status", () => {
  const p = page({ ...baseState(), error: "logins.json 格式无效，已保留原文件" }, "en");
  assert.equal(p.el("toastBanner").textContent, "logins.json has an invalid format. The original file was preserved.");
  p.render({ ...baseState(), accounts: [{ email: "disabled@example.test", isEligible: false,
    tierLabel: "已停用", ineligibleReason: "已在 Magpie 停用" }] });
  assert.match(p.el("unavailableSummary").textContent, /Unavailable accounts/);
  assert.match(p.el("unavailableList").innerHTML, />Disabled</);
  assert.doesNotMatch(p.el("unavailableList").innerHTML, /Disabled in Magpie/);
  assert.doesNotMatch(p.el("unavailableList").innerHTML, /\p{Script=Han}/u);
});


test("refresh stays busy across unrelated updates until its own result arrives", async () => {
  const state = baseState();
  const commands = [];
  let finish;
  const p = page(state, "en", (cmd) => {
    commands.push(cmd);
    return new Promise(resolve => { finish = resolve; });
  });
  const btn = p.el("btnRefresh");

  p.clickRefresh();
  p.clickRefresh();
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.equal(btn.disabled, true);
  assert.equal(p.el("refreshLabel").textContent, "Refreshing…");

  await new Promise(setImmediate);
  assert.equal(commands.length, 1);
  p.render({ ...state, lastSwitch: { id: "other", message: "Another result" } });
  await new Promise(setImmediate);
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.equal(btn.disabled, true);

  finish({ ...state, lastSwitch: { cmdId: commands[0].id, message: "额度查询失败", ok: false } });
  await new Promise(setImmediate);
  assert.equal(btn.getAttribute("aria-busy"), "false");
  assert.equal(btn.disabled, false);
  assert.equal(p.el("refreshLabel").textContent, "Refresh");
  assert.equal(p.el("quotaStatus").title, "额度查询失败");
});

test("the quota timeout follows Magpie's language and keeps available readings visible", () => {
  const state = baseState();
  state.accounts = [{ email: "member@example.test", isEligible: true, isPaid: true, quota: {
    refreshError: "agy usage query timed out.",
    pools: [{ pool: "Gemini", window: "7 days", remaining: 72 }]
  } }];
  const p = page(state);
  assert.match(p.el("quotaStatus").title, /agy 额度查询超时 · 上次数据 更新时间未知/);
  assert.doesNotMatch(p.el("accountList").innerHTML, /额度查询超时|上次数据/);
  assert.match(p.el("accountList").innerHTML, /aria-valuenow="72"/);

  state.accounts[0].quota.refreshError = "context deadline exceeded";
  p.setLanguage("en");
  assert.match(p.el("quotaStatus").title, /The agy quota query timed out/);
  assert.match(p.el("accountList").innerHTML, /aria-valuenow="72"/);
});

test("failed quota refresh dates the retained reading, clears on recovery and handles an empty history", () => {
  const state = baseState();
  const quota = { refreshError: "Magpie 未能刷新这个账号的额度", updatedAt: "2025-10-14T12:08:00Z",
    pools: [{ pool: "Gemini", window: "7 days", remaining: 0 }] };
  state.accounts = [{ email: "saved@example.test", isEligible: true, quota }];
  const p = page(state);
  const html = () => p.el("accountList").innerHTML;
  const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  assert(html().includes("刷新失败 · 上次数据 " + new Intl.DateTimeFormat("zh-CN", options).format(new Date(quota.updatedAt)).replace(", ", " ")));
  p.setLanguage("en");
  assert(html().includes("Refresh failed · Previous reading " + new Intl.DateTimeFormat("en", options).format(new Date(quota.updatedAt)).replace(", ", " ")));
  assert.match(html(), /aria-valuenow="0"/);
  quota.refreshError = null;
  p.render(state);
  assert.doesNotMatch(html(), /Previous reading|Updated/);
  quota.error = "Magpie 未能刷新这个账号的额度";
  quota.pools = [];
  p.render(state);
  assert.match(html(), />Refresh failed</);
  assert.doesNotMatch(html(), /Previous reading|No previous reading|aria-valuenow=/);
});

test("a delayed older snapshot cannot replace the latest quota result", () => {
  const state = { ...baseState(), generatedAt: "2026-11-21T01:00:00.000Z" };
  const p = page(state);
  p.render({ ...state, generatedAt: "2026-11-21T01:00:02.000Z",
    accounts: [{ email: "new@example.test", isEligible: true }] });
  p.render({ ...state, generatedAt: "2026-11-21T01:00:01.000Z",
    accounts: [{ email: "old@example.test", isEligible: true }] });
  assert.match(p.el("accountList").innerHTML, /new@example.test/);
  assert.doesNotMatch(p.el("accountList").innerHTML, /old@example.test/);
});

test("switch feedback belongs to the clicked account and header count follows the main list", async () => {
  const account = (email) => ({ email, isEligible: true, hasCredentials: true });
  const state = { ...baseState(), accounts: [account("one@example.test"), account("two@example.test"), { email: "off@example.test" }] };
  let complete;
  const p = page(state, "zh", (cmd) => new Promise(resolve => {
    complete = () => resolve({ ...state, accounts: [state.accounts[0], { ...state.accounts[1], savedDesktop: true, activeDesktopKeychain: true }],
      lastSwitch: { cmdId: cmd.id, ok: true, pageMessage: "已保存登录 · two@example.test · 桌面端重载中" } });
  }));
  p.clickSwitch("two@example.test");
  const list = () => p.el("accountList").innerHTML;
  assert.match(list(), />2 个账号</);
  assert.match(accountRow(list(), "two@example.test"), /is-busy" id="switch-all-two@example.test"/);
  assert.match(accountRow(list(), "two@example.test"), /id="switch-cli-two@example.test"\s+data-action="switch-cli"/);
  assert.doesNotMatch(accountRow(list(), "one@example.test"), /切换中/);
  complete();
  await new Promise(setImmediate);
  assert.match(accountRow(list(), "two@example.test"), /desktop-mark/);
  assert.match(accountRow(list(), "two@example.test"), /id="switch-all-two@example.test"\s+data-action="switch-all"/);
  assert.doesNotMatch(accountRow(list(), "one@example.test"), /重载中/);
  assert.equal(p.el("refreshLabel").textContent, "刷新");
  p.expireToast();
  assert.doesNotMatch(list(), /桌面端重载中/);
});

test("unverified switch feedback stays in the target row and a CLI-only success confirms just CLI", async () => {
  const email = "target@example.test";
  const account = { email, isEligible: true, hasCredentials: true };
  const state = { ...baseState(), accounts: [account] };
  const p = page(state, "zh", async (cmd) => ({
    ...state, current: { desktopRunning: true }, accounts: [{ ...account, activeCli: true, savedDesktop: true, activeDesktopKeychain: true }],
    lastSwitch: { cmdId: cmd.id, ok: true, pageMessage: `已保存登录 · ${email} · 桌面端账号待确认` }
  }));
  p.clickSwitch(email);
  await new Promise(setImmediate);
  const pending = accountRow(p.el("accountList").innerHTML, email);
  assert.match(pending, /icon-check/);
  assert.match(pending, /aria-label="桌面端已保存"/);
  assert.match(pending, /data-action="switch-all"/);
  assert.doesNotMatch(pending, />桌面端账号待确认<|应用到桌面/);
  p.expireToast();
  const saved = accountRow(p.el("accountList").innerHTML, email);
  assert.match(saved, /data-action="saved-login-detail"/);
  assert.match(saved, /icon-check/);
  assert.match(saved, /aria-label="桌面端已保存"/);
  p.clickSaved();
  assert.equal(p.el("feedbackDialog").open, true);
  assert.match(p.el("feedbackBody").textContent, /桌面会话.*账号菜单/);
  p.setLanguage("en");
  assert.match(p.el("accountList").innerHTML, /aria-label="Desktop saved"/);
  p.render({ ...state, current: { desktopRunning: true },
    accounts: [{ ...account, savedDesktop: true, activeDesktopKeychain: true, activeCli: false }] });
  const split = accountRow(p.el("accountList").innerHTML, email);
  assert.match(split, /data-action="saved-login-detail"/);
  assert.match(split, /data-action="switch-cli"/);
  const cli = page(state, "en", async cmd => ({
    ...state, accounts: [{ ...account, activeCli: true }],
    lastSwitch: { cmdId: cmd.id, ok: true, pageMessage: `新启动的 CLI 将使用 ${email}` }
  }));
  cli.clickSwitch(email, "switch-cli");
  assert.match(cli.el("accountList").innerHTML, /is-busy" id="switch-cli-target@example.test"/);
  await new Promise(setImmediate);
  const success = accountRow(cli.el("accountList").innerHTML, email);
  assert.match(success, /tag tag-cli" title="[^"]+">CLI</);
  assert.match(success, /data-action="switch-cli"/);
  assert.doesNotMatch(success, /icon-check/);
});

test("a switch error replaces only the clicked button and opens the failure details", async () => {
  const email = "target@example.test";
  const state = { ...baseState(), accounts: [{ email, isEligible: true, hasCredentials: true }] };
  const p = page(state, "zh", async cmd => ({
    ...state, lastSwitch: { cmdId: cmd.id, ok: false, message: "测试失败详情" }
  }));
  p.clickSwitch(email, "switch-cli");
  await new Promise(setImmediate);
  const row = accountRow(p.el("accountList").innerHTML, email);
  assert.match(row, /data-action="switch-all"/);
  assert.match(row, /id="switch-cli-target@example.test" data-action="feedback-detail"\s+aria-label="切换失败"/);
  p.clickFeedback();
  assert.equal(p.el("feedbackTitle").textContent, "切换失败");
  assert.equal(p.el("feedbackBody").textContent, "测试失败详情");
});

test("a desktop reload warning is shown in the clicked switch button and opens its details", async () => {
  const email = "target@example.test";
  const state = { ...baseState(), accounts: [{ email, isEligible: true, hasCredentials: true }] };
  const detail = "桌面端重载失败，请在 Antigravity 检查登录。";
  const p = page(state, "zh", async cmd => ({
    ...state, lastSwitch: { cmdId: cmd.id, ok: true, pageWarning: true, pageMessage: detail }
  }));
  p.clickSwitch(email);
  await new Promise(setImmediate);
  const row = accountRow(p.el("accountList").innerHTML, email);
  assert.doesNotMatch(row.split('class="account-actions"')[0], /待确认/);
  assert.match(row, /id="switch-all-target@example.test" data-action="feedback-detail"\s+aria-label="桌面端待确认"/);
  p.clickFeedback();
  assert.equal(p.el("feedbackBody").textContent, detail);
});

test("shared failures with different histories list each date in details and recover independently of account errors", () => {
  const row = (email, error, day) => ({ email, isEligible: true, quota: { refreshError: error,
    updatedAt: `2026-11-${day}T13:33:00Z`, pools: [{pool:"Gemini", window:"7 days", remaining:42}] } });
  const state = { ...baseState(), accounts: [row("a@example.test","context deadline exceeded",20),
    row("b@example.test","agy usage query timed out.",21),row("c@example.test","登录已失效，请在 Magpie 重新登录",22)] };
  const p = page(state);
  const details = p.el("quotaStatus").title;
  assert.equal(details.match(/agy 额度查询超时/g)?.length, 1);
  assert.match(details, /2 个账号/);
  assert.match(details, /a@example.test.*11.20/);
  assert.match(details, /b@example.test.*11.21/);
  assert.doesNotMatch(p.el("accountList").innerHTML, /额度查询超时/);
  assert.match(accountRow(p.el("accountList").innerHTML,"c@example.test"), /登录已失效/);
  p.render({ ...state, accounts: state.accounts.slice(2) });
  assert.equal(p.el("quotaStatus").hidden, true);
  assert.match(p.el("accountList").innerHTML, />1 个账号</);
});

test("sign-in renewal failures stay in the toolbar with a localized cause and cached quota", () => {
  const renewal = "agy's stored sign-in couldn't be renewed. Check the network or proxy.";
  const row = (email, refreshError) => ({ email, isEligible: true, hasCredentials: true, quota: {
    refreshError, updatedAt: "2026-11-24T17:17:00+08:00",
    pools: [{ pool: "Gemini", window: "7 days", remaining: 66 }]
  } });
  const account = row("renew@example.test", renewal);
  const state = { ...baseState(), accounts: [account, row("slow@example.test", "context deadline exceeded")] };
  const p = page(state);
  const status = p.el("quotaStatus");
  const list = p.el("accountList");
  assert.match(status.innerHTML, /额度异常 · 2 个账号 · 上次数据/);
  assert.doesNotMatch(list.innerHTML, /stored sign-in|续期失败|查询超时/);
  const rendered = accountRow(list.innerHTML, account.email);
  assert.match(rendered, />66%<\/strong>/);
  assert.match(rendered, /data-action="switch-all"/);
  p.clickQuotaStatus();
  const detail = p.el("feedbackBody").textContent;
  assert.match(detail, /登录续期失败/);
  assert.match(detail, /续期已保存的登录.*检查网络或代理/);
  assert.match(detail, /renew@example.test/);
  assert.match(detail, /slow@example.test/);
  assert.doesNotMatch(detail, /重新登录|stored sign-in/);
  p.render({ ...state, accounts: [account] });
  assert.match(status.innerHTML, /issue-long">登录续期失败/);
  assert.match(status.innerHTML, /issue-short">续期失败/);
  p.setLanguage("en");
  assert.match(status.title, /Sign-in renewal failed/);
  assert.match(status.title, /network or proxy/);
});

test("quota progress and account switching stay independent when their responses overlap", async () => {
  const email = "switch@example.test";
  const state = { ...baseState(), accounts: [{ email, isEligible: true, hasCredentials: true }] };
  const finish = {};
  const p = page(state, "zh", cmd => new Promise(resolve => {
    finish[cmd.type] = (message) => resolve({ ...state, lastSwitch: { cmdId: cmd.id, ok: true, pageMessage: message } });
  }));
  p.clickRefresh();
  p.render({ ...state, refreshProgress: { completed: 1, total: 4 } });
  assert.equal(p.el("refreshLabel").textContent, "刷新中 1/4");
  assert.doesNotMatch(accountRow(p.el("accountList").innerHTML, email), / disabled/);
  p.clickSwitch(email, "switch-cli");
  assert.match(accountRow(p.el("accountList").innerHTML, email), />切换中</);
  finish.switch("新启动的 CLI 将使用 " + email);
  await new Promise(setImmediate);
  assert.equal(p.el("operationStatus").textContent, `${email} · CLI 已切换`);
  assert.equal(p.el("btnRefresh").disabled, true);
  finish.refresh("已刷新");
  await new Promise(setImmediate);
  assert.equal(p.el("btnRefresh").disabled, false);
  assert.equal(p.el("operationStatus").textContent, `${email} · CLI 已切换`);
});


test("pending retries keep history in the toolbar, then expose final failures or disappear on recovery", () => {
  const state = baseState();
  const quota = { retryPending: true, refreshError: "context deadline exceeded",
    updatedAt: "2026-11-24T16:23:00+08:00", pools: [{ pool: "Gemini", window: "7 days", remaining: 40 }] };
  state.accounts = [{ email: "a@example.test", quota, isEligible: true }];
  const p = page(state);
  const notice = p.el("quotaStatus");
  assert.match(notice.innerHTML, /补查中.*上次数据/);
  assert.doesNotMatch(notice.innerHTML, /查询超时/);
  assert.match(notice.title, /查询超时/);
  assert(notice.classList.contains("is-retrying"));
  assert.doesNotMatch(p.el("accountList").innerHTML, /后台补查中/);
  quota.retryPending = false;
  p.render(state);
  assert.match(notice.innerHTML, /查询超时/);
  assert.match(notice.innerHTML, /issue-short">额度超时/);
  assert.match(notice.title, /a@example.test/);
  assert(!notice.classList.contains("is-retrying"));
  delete quota.refreshError;
  p.render(state);
  assert(notice.hidden);
});
