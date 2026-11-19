import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { project } from "./fixture.mjs";

function page(state, language = "zh-CN", send) {
  const elements = new Map();
  let click;
  const timers = [];
  class Element {
    closest(selector) { return selector === "#btnRefresh" ? this : null; }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        const attributes = new Map();
        elements.set(id, { textContent: "", innerHTML: "", disabled: false, className: "", title: "",
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
  if (send) magpie.options = { set: send };
  const context = vm.createContext({
    document, magpie, Element,
    setInterval() {}, setTimeout: (fn) => timers.push(fn),
    __AGY_SWITCH_STATE__: state
  });
  vm.runInContext(fs.readFileSync(path.join(project, "page/i18n.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(project, "page/app.js"), "utf8"), context);
  return { el: id => document.getElementById(id), render: state => context.__AGY_SWITCH_ON_STATE__(state),
    setLanguage: (lang) => localeChanged({ lang }),
    clickRefresh: () => click({ target: new Element() }),
    poll: (state) => {
      context.__AGY_SWITCH_STATE__ = state;
      timers.shift()();
    }
  };
}
const baseState = () => ({ current: {}, counts: { pro: 0, free: 0, unknown: 0, ineligible: 0 }, accounts: [], preferences: { onlyPro: false } });

function accountRow(html, email) {
  return html.split('<div class="account-row">').find((row) => row.startsWith("\n") && row.includes(`class="account-email">${email}</span>`)) || "";
}

test("#5 page labels the running desktop and pending login on their own rows", () => {
  const state = baseState();
  state.current = { desktopEmail: "old@example.test", desktopSavedEmail: "next@example.test", desktopRunning: true, desktopPending: true };
  state.accounts = [
    { email: "old@example.test", activeDesktop: true, hasCredentials: true, isEligible: true, isPaid: true },
    { email: "next@example.test", pendingDesktop: true, activeCli: true, hasCredentials: true, isEligible: true, isPaid: false },
    { email: "magpie@example.test", activeMagpieFirst: true, hasCredentials: true, isEligible: true, isPaid: false }
  ];
  state.recommendedEmail = "next@example.test";
  const p = page(state), html = p.el("accountList").innerHTML;
  assert.match(accountRow(html, "old@example.test"), /tag-active">桌面端</);
  assert.match(accountRow(html, "next@example.test"), /tag-active">CLI</);
  assert.match(accountRow(html, "next@example.test"), /tag-active">桌面端待生效</);
  assert.match(accountRow(html, "next@example.test"), /应用桌面端/);
  assert.doesNotMatch(accountRow(html, "next@example.test"), /tag-active">桌面端</);
  assert.match(accountRow(html, "magpie@example.test"), /tag-active">Magpie 首选</);
  assert.doesNotMatch(html, /当前使用中|推荐|is-current/);
});

test("#5 page distinguishes unknown running identity from an offline saved login", () => {
  const state = baseState();
  state.current = { desktopRunning: true, desktopStatus: "unknown" };
  const p = page(state);
  assert.equal(p.el("desktopNotice").classList.contains("hidden"), false);
  p.render({ ...state, current: { desktopSavedEmail: "saved@example.test", desktopStatus: "stopped" },
    accounts: [{ email: "saved@example.test", savedDesktop: true, isEligible: true }] });
  const html = p.el("accountList").innerHTML;
  assert.match(html, /tag-active">桌面端已保存</);
  assert.doesNotMatch(html, /tag-active">桌面端</);
  assert.equal(p.el("desktopNotice").classList.contains("hidden"), true);
});

test("the CLI-only control describes the shared login for recent local agy", () => {
  const state = baseState();
  state.current = { cliEmail: "old@example.test", cliUsesSharedLogin: true };
  state.accounts = [{ email: "next@example.test", isPaid: true, isEligible: true, hasCredentials: true }];
  assert.match(page(state).el("accountList").innerHTML, /title="新启动的 CLI 和桌面端共用此登录"/);
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

test("the provider list preserves plan labels even with an older member-only preference", () => {
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
  for (const plan of ["Google AI Pro", "Google AI Ultra (5x)", "Google AI Ultra (20x)", "Enterprise"]) assert(rows.includes(plan));
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
    'aria-label="GPT / Claude 5h：100%"', 'aria-label="GPT / Claude 7d：0%"',
    'aria-label="Gemini 5h：86%"', 'aria-label="Gemini 7d：84%"', 'aria-label="Gemini 4 Argon 7d：30%"'
  ]);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /width:0%/);
  assert.doesNotMatch(html, /5 小时|7 天/);
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
    'aria-label="GPT / Claude 5h：0%"', 'aria-label="GPT / Claude 7d：待刷新"',
    'aria-label="Gemini 5h：未知"', 'aria-label="Gemini 7d：未知"', 'aria-label="Gemini 4 Argon 7d：未知"'
  ]);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 1);
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
  assert.match(html, /Google AI Ultra \(20x\)/);
  assert.doesNotMatch(html, /unavailable@example.test/);
  const disabledRow = p.el("unavailableList").innerHTML;
  assert.match(disabledRow, /unavailable@example.test/);
  assert.match(disabledRow, /已停用/);
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
  assert.match(html, /<strong>Gemini 4 Carbon<\/strong>/);
  assert.match(accountRow(html, ultra.email), /Gemini 4 Carbon 7d：0%/);
  assert.match(accountRow(html, pro.email), /Gemini 4 Carbon 7d：未知/);
  assert.doesNotMatch(html, /Gemini 4 Carbon 5h/);

  ultra.quota.pools.push({ pool: "Gemini 4 Carbon", window: "5 hours", remaining: 60 });
  p.render(state);
  html = p.el("accountList").innerHTML;
  assert.match(accountRow(html, ultra.email), /Gemini 4 Carbon 5h：60%/);
  assert.match(html, /--carbon-width: 2fr/);
});

test("the page follows Magpie language changes and leaves provider plans intact", () => {
  const state = baseState();
  state.accounts = [{
    email: "member@example.test", plan: "Google AI Ultra (20x)", isEligible: true, isPaid: true,
    hasCredentials: true, activeDesktop: true, activeMagpieFirst: true,
    quota: { pools: [{ pool: "Gemini", window: "5 hours", remaining: 75,
      resetsAt: new Date(Date.now()+7200_000).toISOString() }] }
  }];
  const p = page(state, "en-US");
  assert.equal(p.el("refreshLabel").textContent, "Refresh");
  let html = p.el("accountList").innerHTML;
  assert.match(html, /Paid accounts/);
  assert.match(html, /Magpie preferred/);
  assert.match(html, /Google AI Ultra \(20x\)/);
  assert.match(html, /Gemini 5h: 75%/);
  assert.match(html, /Reset time: /);
  assert.match(html, /Resets in 2h/);
  assert.match(html, /CLI only/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);

  p.render({ ...state, lastSwitch: { id: "refresh", message: "已同步 1 个账号，已刷新 1 个账号的额度", ok: true } });
  assert.equal(p.el("toastBanner").textContent, "Synced 1 account, refreshed quotas for 1 account");
  p.setLanguage("zh-CN");
  assert.equal(p.el("refreshLabel").textContent, "刷新");
  assert.match(p.el("accountList").innerHTML, /Magpie 首选/);
  assert.equal(p.el("toastBanner").textContent, "已同步 1 个账号，已刷新 1 个账号的额度");
});

test("English shows recoverable configuration errors and disabled provider status", () => {
  const p = page({ ...baseState(), error: "logins.json 格式无效，已保留原文件" }, "en");
  assert.equal(p.el("toastBanner").textContent, "logins.json has an invalid format. The original file was preserved.");
  p.render({ ...baseState(), accounts: [{ email: "disabled@example.test", isEligible: false,
    tierLabel: "已停用", ineligibleReason: "已在 Magpie 停用" }] });
  assert.match(p.el("unavailableSummary").textContent, /Unavailable accounts/);
  assert.match(p.el("unavailableList").innerHTML, /Disabled in Magpie/);
  assert.doesNotMatch(p.el("unavailableList").innerHTML, /\p{Script=Han}/u);
});


test("refresh stays busy across unrelated updates until its own result arrives", async () => {
  const state = baseState();
  const commands = [];
  const p = page(state, "en", ({ cmd }) => commands.push(cmd));
  const btn = p.el("btnRefresh");

  p.clickRefresh();
  p.clickRefresh();
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.equal(btn.disabled, true);
  assert.equal(p.el("refreshLabel").textContent, "Refreshing…");

  await new Promise(setImmediate);
  assert.equal(commands.length, 1);
  p.poll({ ...state, lastSwitch: { id: "other", message: "Another result" } });
  await new Promise(setImmediate);
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.equal(btn.disabled, true);

  p.poll({ ...state, lastSwitch: { cmdId: commands[0].id, message: "额度查询失败", ok: false } });
  await new Promise(setImmediate);
  assert.equal(btn.getAttribute("aria-busy"), "false");
  assert.equal(btn.disabled, false);
  assert.equal(p.el("refreshLabel").textContent, "Refresh");
  assert.equal(p.el("toastBanner").className, "toast is-error");
});
