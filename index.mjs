#!/usr/bin/env node
/**
 * [INPUT]: core.mjs、daemon.mjs，以及 CLI 参数或 Magpie 插件加载。
 * [OUTPUT]: 默认插件函数与 magpie-agy-switch 命令。
 * [POS]: 包入口；仅直接执行或通过 bin 软链接执行时运行 CLI。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
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
  if (state.error) throw new Error(state.error);
  const daemonInfo = ensureBackgroundWatcher();
  console.log("=== Antigravity 账号状态 ===");
  console.log(`桌面端 (Antigravity.app): ${state.current.desktopEmail || (state.current.desktopRunning ? "账号待确认" : "未登录")}${state.current.desktopRunning ? " [运行中]" : " [未运行]"}`);
  if (state.current.desktopPending) console.log(`桌面端待生效           : ${state.current.desktopSavedEmail}`);
  console.log(`CLI (agy)               : ${state.current.cliEmail || "未登录"}`);
  console.log(`Magpie 网关首选         : ${state.current.magpieFirstEmail || "未设置"}`);
  console.log(`推荐充裕账号            : ${state.recommendedEmail || "无"}`);
  console.log(`会员统计                : 会员 ${state.counts.paid ?? state.counts.pro} 个 / 免费版 ${state.counts.free} 个 / 套餐未知 ${state.counts.unknown} 个 / 异常 ${state.counts.ineligible} 个`);
  console.log(`筛选模式                : ${state.preferences?.onlyPro ? "仅显示已识别会员" : "显示全部可用账号"}`);
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
      .map((p) => `${p.label}:${p.stale ? "待刷新" : `剩余${p.remaining}%`}`)
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
    const onlyPro = (args.includes("--members-only") || args.includes("--only-pro")) ? true : args.includes("--all") ? false : undefined;
    const res = organizeAccounts({ onlyPro });
    console.log(res.message);
    return;
  }

  if (cmd === "members-only" || cmd === "pro-only") {
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
    const res = reloadDesktopLanguageServer(getFullState().current.desktopSavedEmail || "");
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
  console.log("  node index.mjs organize [--members-only|--all]");
  console.log("  node index.mjs members-only [on|off]（兼容 pro-only）");
  console.log("  node index.mjs import <email>");
  console.log("  node index.mjs reload");
}

let isDirectRun = false;
try {
  isDirectRun = Boolean(process.argv[1]) &&
    fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]) &&
    !process.argv.includes("--daemon");
} catch {
  // Plugin imports need no CLI entrypoint.
}

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("执行失败:", err.message || err);
    process.exit(1);
  });
}
