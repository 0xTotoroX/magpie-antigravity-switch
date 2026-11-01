#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  getFullState,
  importAccountToMagpie,
  organizeAccounts,
  reloadDesktopLanguageServer,
  setPreferences,
  switchAccount,
  syncStateFile
} from "./src/core.mjs";
import { ensureBackgroundWatcher } from "./src/daemon.mjs";

/**
 * Magpie / OpenCode Plugin Entrypoint
 */
export const AntigravitySwitchPlugin = async () => {
  try {
    syncStateFile();
    ensureBackgroundWatcher();
  } catch {
    // Non-fatal in plugin host
  }
  return {};
};

export default AntigravitySwitchPlugin;

function printStatus() {
  const state = syncStateFile();
  const daemonInfo = ensureBackgroundWatcher();
  console.log("=== Antigravity 账号状态 ===");
  console.log(`桌面端 (Antigravity.app): ${state.current.desktopEmail || "未登录"}${state.current.desktopRunning ? " [运行中]" : " [未运行]"}`);
  console.log(`CLI (agy)               : ${state.current.cliEmail || "未登录"}`);
  console.log(`Magpie 网关首选         : ${state.current.magpieFirstEmail || "未设置"}`);
  console.log(`推荐充裕账号            : ${state.recommendedEmail || "无"}`);
  console.log(`会员统计                : Pro 会员 ${state.counts.pro} 个 / 免费版 ${state.counts.free} 个 / 异常 ${state.counts.ineligible} 个`);
  console.log(`筛选模式                : ${state.preferences?.onlyPro ? "仅显示 Pro 会员" : "显示全部可用账号"}`);
  console.log(`后台同步守护进程        : PID ${daemonInfo.pid}`);
  console.log("\n账号列表:");
  for (const acc of state.accounts) {
    const badges = [
      acc.tierLabel,
      acc.activeDesktop ? "桌面端" : null,
      acc.activeCli ? "CLI" : null,
      acc.activeMagpieFirst ? "Magpie首选" : null
    ]
      .filter(Boolean)
      .join(", ");
    const poolText = (acc.quota?.pools || [])
      .map((p) => `${p.label}:剩余${p.remaining}%`)
      .join(" | ");
    console.log(
      `- ${acc.email} [${badges}] ${poolText ? `-> ${poolText}` : ""}`
    );
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";

  if (cmd === "status") {
    printStatus();
    return;
  }

  if (cmd === "switch") {
    const emailArg = args.find((a, idx) => idx > 0 && !a.startsWith("--"));
    const reloadDesktop = !args.includes("--no-reload");
    const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] || "all";
    const syncMagpie = !args.includes("--no-magpie");

    let targetEmail = emailArg;
    if (!targetEmail || targetEmail === "best" || targetEmail === "recommended") {
      const state = getFullState();
      targetEmail = state.recommendedEmail;
    }
    if (!targetEmail) {
      console.error("错误: 请提供要切换的邮箱，或使用 `best` 自动选择配额最充裕的账号。");
      process.exit(1);
    }

    const res = switchAccount({
      email: targetEmail,
      target: targetArg,
      reloadDesktop,
      syncMagpie
    });
    console.log(res.message);
    return;
  }

  if (cmd === "organize") {
    const onlyPro = args.includes("--only-pro") ? true : args.includes("--all") ? false : undefined;
    const res = organizeAccounts({ onlyPro });
    console.log(res.message);
    return;
  }

  if (cmd === "pro-only") {
    const val = args[1] !== "off" && args[1] !== "false";
    const res = setPreferences({ onlyPro: val });
    console.log(res.message);
    return;
  }

  if (cmd === "import") {
    const emailArg = args[1];
    if (!emailArg) {
      console.error("错误: 请指定要收入 Magpie 的邮箱账号。");
      process.exit(1);
    }
    const res = importAccountToMagpie(emailArg);
    console.log(res.message);
    return;
  }

  if (cmd === "reload") {
    const res = reloadDesktopLanguageServer(getFullState().current.desktopEmail || "");
    console.log(res.reason);
    return;
  }

  if (cmd === "daemon") {
    const info = ensureBackgroundWatcher();
    console.log(`守护进程运行中: PID ${info.pid}`);
    return;
  }

  console.log("用法:");
  console.log("  node index.mjs status");
  console.log("  node index.mjs switch <email|best> [--no-reload] [--target=all|desktop|cli] [--no-magpie]");
  console.log("  node index.mjs organize [--only-pro|--all]");
  console.log("  node index.mjs pro-only [on|off]");
  console.log("  node index.mjs import <email>");
  console.log("  node index.mjs reload");
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1] &&
  !process.argv.includes("--daemon");

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("执行失败:", err.message || err);
    process.exit(1);
  });
}
