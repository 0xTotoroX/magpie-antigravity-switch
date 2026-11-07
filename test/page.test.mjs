import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { project } from "./fixture.mjs";

function page(state) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        elements.set(id, { textContent: "", innerHTML: "", disabled: false, className: "", title: "",
          classList: { add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: c => classes.has(c) }
        });
      }
      return elements.get(id);
    },
    addEventListener() {}
  };
  const context = vm.createContext({ document, setInterval() {}, __AGY_SWITCH_STATE__: state });
  vm.runInContext(fs.readFileSync(path.join(project, "page/app.js"), "utf8"), context);
  return { el: id => document.getElementById(id), render: state => context.__AGY_SWITCH_ON_STATE__(state) };
}
const baseState = () => ({ current: {}, counts: { pro: 0, free: 0, unknown: 0, ineligible: 0 }, accounts: [], preferences: { onlyPro: true } });

test("#5 page shows old runtime and pending target, including a hidden-tier target", () => {
  const state = baseState();
  state.current = { desktopEmail: "old@example.test", desktopSavedEmail: "next@example.test", desktopRunning: true, desktopPending: true };
  state.accounts = [{ email: "next@example.test", pendingDesktop: true, hasCredentials: true, isEligible: true, isPro: false, tierLabel: "套餐未知" }];
  const p = page(state);
  assert.match(p.el("curDesktopEmail").textContent, /old@example.test → next@example.test（待生效）/);
  assert.match(p.el("accountList").innerHTML, /桌面端待生效/);
  assert.match(p.el("accountList").innerHTML, /应用桌面端/);
  assert.doesNotMatch(p.el("accountList").innerHTML, /当前使用中/);
});
test("#5 page shows unknown runtime identity and saved offline identity distinctly", () => {
  const state = baseState();
  state.current = { desktopRunning: true, desktopStatus: "unknown" };
  const p = page(state);
  assert.equal(p.el("curDesktopEmail").textContent, "账号待确认");
  p.render({ ...state, current: { desktopEmail: "saved@example.test", desktopSavedEmail: "saved@example.test", desktopStatus: "stopped" } });
  assert.match(p.el("curDesktopEmail").textContent, /已保存，未运行/);
});
test("#8 page does not describe an unknown quota or plan as normal or free", () => {
  const state = baseState();
  state.preferences.onlyPro = false;
  state.counts.unknown = 1;
  state.accounts = [{ email: "unknown@example.test", isEligible: true, hasCredentials: true, tierLabel: "套餐未知" }];
  const p = page(state);
  assert.match(p.el("subtitleText").textContent, /套餐未知 1 个/);
  assert.match(p.el("accountList").innerHTML, /套餐未知/);
  assert.match(p.el("accountList").innerHTML, /GPT \/ Claude 5h：未知/);
  assert.doesNotMatch(p.el("accountList").innerHTML, /配额正常/);
});
test("#3 page surfaces read errors, disables writes and clears the recovered error", () => {
  const p = page({ ...baseState(), error: "logins.json 格式无效，已保留原文件" });
  assert.match(p.el("toastBanner").textContent, /保留原文件/);
  assert.equal(p.el("btnOrganize").disabled, true);
  assert.equal(p.el("btnTogglePro").disabled, true);
  p.render(baseState());
  assert.equal(p.el("btnOrganize").disabled, false);
  assert.equal(p.el("toastBanner").classList.contains("hidden"), true);
});

test("member filtering includes Ultra and Enterprise and preserves every plan label", () => {
  const state = baseState();
  state.counts = { paid: 4, pro: 1, free: 1, unknown: 1, ineligible: 0 };
  state.accounts = ["Google AI Pro", "Google AI Ultra (5x)", "Google AI Ultra (20x)", "Enterprise"].map((plan, i) => ({
    email: `paid-${i}@example.test`, tierLabel: plan, plan,
    isPaid: true, isPro: false, isEligible: true, hasCredentials: true
  }));
  state.accounts.push({ email: "free@example.test", tierLabel: "Starter", isPaid: false, isEligible: true });
  state.accounts.push({ email: "unknown@example.test", tierLabel: "Unrecognized plan", isPaid: false, isEligible: true });
  const p = page(state);
  assert.match(p.el("subtitleText").textContent, /会员 4 个/);
  assert.doesNotMatch(p.el("subtitleText").textContent, /Pro 会员/);
  const rows = p.el("accountList").innerHTML;
  for (const plan of ["Google AI Pro", "Google AI Ultra (5x)", "Google AI Ultra (20x)", "Enterprise"]) assert(rows.includes(plan));
  assert.doesNotMatch(rows, /free@example.test|unknown@example.test/);
  assert.match(p.el("hiddenFooter").innerHTML, /免费或套餐未知/);
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
    { email: "unavailable@example.test", isEligible: false }
  ];
  const p = page(state), html = p.el("accountList").innerHTML;
  assert(html.indexOf('aria-label="会员账号"') < html.indexOf('aria-label="免费账号"'));
  assert(html.indexOf('aria-label="免费账号"') < html.indexOf('aria-label="套餐未知"'));
  assert.match(html, /Google AI Ultra \(20x\)/);
  assert.doesNotMatch(html, /unavailable@example.test/);
  assert.match(p.el("unavailableList").innerHTML, /unavailable@example.test/);
  assert.equal(p.el("unavailableAccounts").hidden, false);
  p.el("unavailableAccounts").open = true;
  p.render(state);
  assert.equal(p.el("unavailableAccounts").open, true);
});
