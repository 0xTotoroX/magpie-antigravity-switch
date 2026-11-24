/**
 * [INPUT]: Magpie 主题语言与页面、后台状态文案。
 * [OUTPUT]: 中英文文案、操作反馈、读数时间与常见后台反馈翻译。
 * [POS]: Magpie 沙箱中的经典脚本，必须先于 app.js 加载。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
(() => {
  const messages = {
    support: ["支持", "Support"],
    supportTitle: ["打开 GitHub 仓库并点亮 Star 支持项目", "Open the GitHub repository and star the project"],
    close: ["关闭", "Close"],
    switching: ["切换中…", "Switching…"],
    switchingShort: ["切换中", "Switching"],
    saved: ["已保存", "Saved"],
    cliSaved: ["CLI 已切换", "CLI switched"],
    switchFailed: ["切换失败", "Switch failed"],
    switchFailedShort: ["失败", "Failed"],
    desktopWarning: ["桌面端待确认", "Check Desktop"],
    refreshed: ["已刷新", "Refreshed"],
    partialFailure: ["部分失败", "Partial failure"],
    quotaProblem: ["额度异常", "Quota issue"],
    refresh: ["刷新", "Refresh"],
    refreshProgress: ["刷新中", "Refreshing"],
    refreshing: ["刷新中…", "Refreshing…"],
    loading: ["正在读取账号…", "Loading accounts…"],
    savedDesktopDetail: ["登录已保存。当前桌面会话使用的账号可在 Antigravity 的账号菜单中查看。", "The desktop sign-in is saved. Check the account menu in Antigravity to see which account the open session is using."],
    quotaRetry: ["补查中", "Retrying"],
    desktopUnknown: ["桌面端账号待确认", "Desktop unverified"],
    desktopPendingShort: ["待确认", "Check"],
    unavailableAccounts: ["不可用账号", "Unavailable accounts"],
    noAvailable: ["没有可用账号", "No available accounts"],
    noAccounts: ["暂无 agy-cli 账号", "No agy-cli accounts"],
    desktopSaved: ["桌面端已保存", "Desktop saved"],
    magpiePreferred: ["Magpie 首选", "Magpie preferred"],
    member: ["会员", "Paid"],
    members: ["会员账号", "Paid accounts"],
    freeAccounts: ["免费账号", "Free accounts"],
    planUnknown: ["套餐未知", "Unknown plan"],
    unavailable: ["不可用", "Unavailable"],
    disabled: ["已停用", "Disabled"],
    switch: ["切换", "Switch"],
    cliOnly: ["仅 CLI", "CLI only"],
    cliShared: ["新启动的 CLI 和桌面端共用此登录", "New CLI processes and the desktop app share this sign-in"],
    cliNext: ["供新启动的 CLI 使用", "Use this account for new CLI processes"],
    previousReading: ["上次数据", "Previous reading"],
    timeUnknown: ["更新时间未知", "Update time unknown"],
    refreshFailed: ["刷新失败", "Refresh failed"],
    quotaWait: ["待刷新", "Needs refresh"],
    unknown: ["未知", "Unknown"],
    quota: ["Magpie 配额", "Magpie quota"],
    remaining: ["剩余", "remaining"],
    resetTime: ["重置时间", "Reset time"],
    verifyAccount: ["账号需验证或地区受限", "Account verification required or region unsupported"],
    reopen: ["请从 Magpie 重新打开 Antigravity Switch", "Reopen Antigravity Switch from Magpie"],
    noBridge: ["未检测到 Magpie 页面桥接，请通过 Magpie 侧边栏打开", "Open this plugin from the Magpie sidebar to connect it"],
    refreshTimeout: ["额度刷新暂未返回结果", "The quota refresh has not returned a result yet"],
    commandTimeout: ["操作暂未返回结果", "The operation has not returned a result yet"],
    quotaQueryTimeout: ["agy 额度查询超时", "The agy quota query timed out"],
    quotaTimedOut: ["额度超时", "Timed out"],
    commandFailed: ["指令发送失败", "Could not send the command"]
  };

  // Translate plugin-generated status strings, including older stored results.
  // Vendor messages and original plan names remain intact.
  const backendMessages = [
    [/^无法读取 (.+)，已停止写入$/, "Could not read $1. Writes were stopped."],
    [/^(.+) 在切换期间发生变化，请重试$/, "$1 changed while switching. Retry the operation."],
    [/ · 未能恢复 (.+)，请检查当前登录状态$/, " · Could not restore $1. Check the current sign-in."],
    [/^(.+) 格式无效，已保留原文件$/, "$1 has an invalid format. The original file was preserved."],
    [/^无法备份 (.+)，已停止凭据替换$/, "Could not back up $1. The existing credentials were preserved."],
    [/^无法读取 macOS 钥匙串，已停止备份和凭据替换，请检查访问权限$/, "Could not read the macOS Keychain. Check access permissions before retrying."],
    [/^钥匙串更新及旧凭据恢复失败，请从本地备份恢复后再切换账号$/, "The Keychain update and credential restoration failed. Restore your local backup before switching accounts."],
    [/^写入 macOS 钥匙串失败(?:，旧凭据已保留)?，请检查访问权限后重试$/, "Could not update the macOS Keychain. Check access permissions and retry."],
    [/^写入 macOS 钥匙串失败$/, "Could not update the macOS Keychain."],
    [/^macOS 钥匙串未确认目标账号，请检查登录状态后重试$/, "The macOS Keychain did not confirm the selected account. Check the sign-in and retry."],
    [/^未找到账号 (.+) 的(?:可用 OAuth 凭证|凭证)$/, "No usable sign-in was found for $1."],
    [/^已在 Magpie 停用$/, "Disabled in Magpie"],
    [/^登录已失效，请在 Magpie 重新登录$/, "Sign-in expired. Sign in again in Magpie."],
    [/^agy 登录凭证已失效，请重新登录$/, "agy sign-in expired. Sign in again."],
    [/^账号暂不可用或所在地区受限$/, "Account unavailable or region unsupported"],
    [/^OAuth 令牌刷新失败 \((.+)\)$/, "OAuth token refresh failed ($1)"],
    [/^找不到 Magpie 命令，无法刷新额度$/, "The Magpie command could not be found."],
    [/^Magpie 额度刷新超时$/, "Magpie quota refresh timed out."],
    [/^Magpie 未能刷新这个账号的额度$/, "Magpie could not refresh this account's quota."],
    [/^Magpie 返回了无效的额度数据$/, "Magpie returned invalid quota data."],
    [/^Magpie 未返回这个账号的额度$/, "Magpie did not return quotas for this account."],
    [/^Magpie 未返回可显示的额度读数$/, "Magpie did not return readable quota values."],
    [/^(Antigravity .+) 返回 HTTP (\d+)$/, "$1 returned HTTP $2"],
    [/^已在浏览器打开 GitHub 仓库，欢迎点亮 Star$/, "Opened the GitHub repository."],
    [/^已打开 GitHub 仓库$/, "Opened the GitHub repository."],
    [/^已刷新$/, "Refreshed"],
    [/^已沿用近期额度$/, "Showing recent quotas"],
    [/^没有可刷新的账号$/, "No accounts to refresh"],
    [/^已刷新 (\d+) 个，沿用 (\d+) 个$/, "Refreshed $1 · reused $2"],
    [/^刷新失败$/, "Refresh failed"],
    [/^(\d+) 个账号刷新失败$/, (_, count) => count === "1" ? "1 account failed to refresh" : `${count} accounts failed to refresh`],
    [/^已保存登录 · (.+)$/, "Sign-in saved · $1"],
    [/^新启动的 CLI 将使用 (.+)$/, "New CLI sessions will use $1"],
    [/打开桌面端后生效$/, "Applies the next time you open the desktop app"],
    [/桌面端重载中$/, "Reloading Desktop"],
    [/已重启桌面端$/, "Restarted Desktop"],
    [/^已读取 Magpie 配额与本地登录状态$/, "Magpie quotas and local sign-ins reloaded."],
    [/^未检测到 Magpie 页面桥接，请通过 Magpie 侧边栏打开$/, "Open this plugin from the Magpie sidebar to connect it"],
    [/^额度刷新暂未返回结果$/, "The quota refresh has not returned a result yet"],
    [/^操作完成$/, "Done"],
    [/^操作失败$/, "The operation failed"],
    [/^请指定要切换的目标邮箱账号$/, "Select an account to switch to."],
    [/^无效切换目标，请使用 all、desktop 或 cli$/, "Invalid switch target. Use all, desktop or cli."],
    [/^已保存 (.+) 的登录设置（([^）]+)）/, (_, email, targets) => `Saved sign-in for ${email} (${targets.replace("桌面端", "Desktop")})`],
    [/^已同步 (\d+) 个账号/, (_, count) => `Synced ${count} ${count === "1" ? "account" : "accounts"}`],
    [/，已刷新 (\d+) 个账号的额度/, (_, count) => `, refreshed quotas for ${count} ${count === "1" ? "account" : "accounts"}`],
    [/，(\d+) 个额度查询失败/, ", $1 quota refreshes failed"],
    [/，沿用 (\d+) 个账号的近期额度/, (_, count) => `, reused recent quotas for ${count} ${count === "1" ? "account" : "accounts"}`],
    [/，额度已是最新/, ", quotas already current"],
    [/新启动的 CLI 使用此账号/, "New CLI processes use this account"],
    [/桌面端账号待确认$/, "Desktop unverified"],
    [/检测到桌面端服务曾停止响应，已自动重启 Antigravity 恢复界面/, "Antigravity restarted to recover the desktop app."],
    [/桌面端当前未运行，凭证已就绪，打开即生效/, "The desktop app will use the saved sign-in when opened."],
    [/额度缓存正在更新，请重试/, "Quota data is being updated. Try again."],
    [/桌面端服务尚未就绪，请稍后重试/, "The desktop service is starting. Try again shortly."],
    [/凭证已切换。为避免桌面端黑屏保护，请隔 (\d+) 秒后再连续切号/, "Sign-in saved. Wait $1 seconds before switching the desktop account again."],
    [/桌面端平滑重载中（约 5 秒自动完成刷新）/, "Reloading the desktop app. This usually takes about five seconds."],
    [/桌面端重载失败:\s*/, "Could not reload the desktop app: "]
  ];

  let lang = "zh-CN";

  function setLanguage(value) {
    const next = /^zh(?:-|$)/i.test(value || "") ? "zh-CN" : "en";
    if (next === lang) return false;
    lang = next;
    return true;
  }

  const text = (key) => messages[key][lang === "en" ? 1 : 0];

  function apply() {
    if (document.documentElement) document.documentElement.lang = lang;
    for (const element of document.querySelectorAll?.("[data-i18n]") || []) {
      element.textContent = text(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll?.("[data-i18n-title]") || []) {
      element.title = text(element.dataset.i18nTitle);
    }
    for (const element of document.querySelectorAll?.("[data-i18n-label]") || []) {
      element.setAttribute("aria-label", text(element.dataset.i18nLabel));
    }
  }

  function backend(value) {
    const message = String(value ?? "");
    if (/^(?:agy usage query timed out\.?|context deadline exceeded)$/i.test(message.trim())) {
      return text("quotaQueryTimeout");
    }
    if (lang !== "en") return message;
    return backendMessages.reduce((result, [pattern, translation]) => result.replace(pattern, translation), message);
  }

  function reset(minutes, compact = false) {
    const [size, zh, en] = minutes >= 1440 ? [1440, "天", "d"] : minutes >= 60 ? [60, "小时", "h"] : [1, "分", "m"];
    const value = Math.floor(minutes / size);
    if (compact) return `${value}${en}`;
    return lang === "en" ? `in ${value}${en}` : `${value}${zh}后`;
  }

  const accountCount = (n) => lang === "en" ? `${n} account${n === 1 ? "" : "s"}` : `${n} 个账号`;

  const stateLabel = (label) => {
    const known = { "不可用": "unavailable", "已停用": "disabled", "套餐未知": "planUnknown" };
    return Object.hasOwn(known, label) ? text(known[label]) : label;
  };

  globalThis.agySwitchI18n = {
    setLanguage, apply, text, backend, reset, accountCount, stateLabel, locale: () => lang,
    separator: () => lang === "en" ? ": " : "："
  };
})();
