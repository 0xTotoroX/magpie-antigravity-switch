/**
 * [INPUT]: 本机页面服务的账号快照、i18n.js 文案与 Magpie 页面桥接。
 * [OUTPUT]: GPT / Claude 与 Gemini 共享额度、套餐来源、登录状态和操作反馈。
 * [POS]: 经典脚本页面渲染器；不持有 OAuth 凭据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
(() => {
  const QUOTA_GROUPS = [
    { pool: "Claude & GPT", label: "GPT / Claude", windows: ["5 hours", "7 days"] },
    { pool: "Gemini", label: "Gemini", windows: ["5 hours", "7 days"] }
  ];

  const CARBON_GROUP = { pool: "Gemini 4 Carbon", label: "Gemini 4 Carbon", windows: ["5 hours", "7 days"] };

  const i18n = globalThis.agySwitchI18n;
  const t = i18n.text;

  let currentState = globalThis.__AGY_SWITCH_STATE__ || null;
  let lastHandledSwitchId = currentState?.lastSwitch?.cmdId || currentState?.lastSwitch?.id || null;
  let pendingCommandType = null;
  let lastToast = "";
  let toastTimer;

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hideToast() {
    clearTimeout(toastTimer);
    lastToast = "";
    document.getElementById("toastBanner")?.classList.add("hidden");
  }

  function showToast(message, isOk = true) {
    const el = document.getElementById("toastBanner");
    if (!el || !message) return;
    clearTimeout(toastTimer);
    lastToast = message;
    el.textContent = i18n.backend(message).slice(0, 180);
    el.className = `toast ${isOk ? "is-ok" : "is-error"}`;
    if (isOk) toastTimer = setTimeout(hideToast, 4500);
  }

  function showCommandResult(result) {
    showToast(result.pageMessage ?? result.message, result.ok !== false && !result.pageWarning);
  }

  function fillClass(remaining) {
    if (remaining <= 12) return "is-low";
    if (remaining <= 35) return "is-warn";
    return "";
  }

  function periodLabel(window) {
    return window === "5 hours" ? "5h" : "7d";
  }

  function resetLabel(resetsAt) {
    const minutes = Math.ceil((Date.parse(resetsAt) - Date.now()) / 60000);
    if (!Number.isFinite(minutes) || minutes <= 0) return "";
    return i18n.reset(minutes);
  }

  function isStale(reading) {
    return Boolean(reading?.stale) || Date.parse(reading?.resetsAt) <= Date.now();
  }

  function renderQuotaCell(group, window, pools) {
    const reading = pools.find((p) => p.pool === group.pool && p.window === window);
    const period = periodLabel(window);
    const resetAt = Date.parse(reading?.resetsAt);
    const stale = isStale(reading);
    const known = Number.isFinite(reading?.remaining) && !stale;
    const remaining = known ? Math.max(0, Math.min(100, Math.round(reading.remaining))) : 0;
    const value = known ? `${remaining}%` : stale ? t("quotaWait") : "—";
    const accessibleValue = known || stale ? value : t("unknown");
    const label = `${group.label} ${period}`;
    return `<div class="quota-cell ${known ? fillClass(remaining) : "is-unknown"}" data-pool="${group.pool}" data-window="${window}">
      <span class="quota-period">${period}</span>
      <strong class="quota-value" aria-label="${label}${i18n.separator()}${accessibleValue}">${value}</strong>
      <span class="quota-bar" ${known ? `role="progressbar" aria-label="${label} ${t("remaining")}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"` : 'aria-hidden="true"'}>
        <span class="quota-fill" style="width:${known ? remaining : 0}%"></span>
      </span>
      <span class="quota-reset" title="${known && Number.isFinite(resetAt) ? escapeHtml(`${t("resetTime")}${i18n.separator()}${new Date(resetAt).toLocaleString(i18n.locale())}`) : ""}">${known ? resetLabel(reading.resetsAt) : ""}</span>
    </div>`;
  }

  function quotaGridAttributes(quotaGroups) {
    const carbon = quotaGroups.find((group) => group.pool === CARBON_GROUP.pool);
    if (!carbon) return 'class="account-quotas"';
    return `class="account-quotas has-carbon" style="--carbon-width: ${carbon.windows.length}fr"`;
  }

  function renderQuotaGrid(account, quotaGroups) {
    if (!account.isEligible) {
      if (account.tierLabel === "已停用" && account.ineligibleReason === "已在 Magpie 停用") {
        return '<div class="account-unavailable"></div>';
      }
      return `<div class="account-unavailable">${escapeHtml(i18n.backend(account.ineligibleReason) || t("verifyAccount"))}</div>`;
    }
    const pools = account.quota?.error ? [] : account.quota?.pools || [];
    return `<div ${quotaGridAttributes(quotaGroups)} aria-label="${t("quota")}">
      ${quotaGroups.map((group) => `<div class="quota-group">
        <span class="quota-group-label">${group.label}</span>
        <div class="quota-windows ${group.windows.length === 1 ? "is-single" : ""}">
          ${group.windows.map((window) => renderQuotaCell(group, window, pools)).join("")}
        </div>
      </div>`).join("")}
    </div>`;
  }

  function renderQuotaHeader(quotaGroups) {
    return `<div class="quota-header" aria-hidden="true"><span></span>
      <div ${quotaGridAttributes(quotaGroups)}>${quotaGroups.map((group) => `<div class="quota-group">
        <strong>${group.label}</strong>
        <div class="quota-windows ${group.windows.length === 1 ? "is-single" : ""}">${group.windows.map((window) => `<span>${periodLabel(window)}</span>`).join("")}</div>
      </div>`).join("")}</div><span></span></div>`;
  }

  function quotaNotice(quota, quotaGroups) {
    if (!quota) return "";
    const error = quota.error || quota.refreshError;
    if (!error && !quota.previousReading) return "";
    const reason = error === "Magpie 未能刷新这个账号的额度" ? t("refreshFailed") : i18n.backend(error);
    const hasReading = !quota.error && quota.pools?.some((pool) =>
      Number.isFinite(pool.remaining) && !isStale(pool) &&
      quotaGroups.some((group) => group.pool === pool.pool && group.windows.includes(pool.window)));
    if (!hasReading) return reason;

    const date = new Date(quota.updatedAt ?? NaN);
    const updated = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(i18n.locale(), {
        ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(date).replace(", ", " ")
      : t("timeUnknown");
    return [reason, `${t("previousReading")} ${updated}`].filter(Boolean).join(" · ");
  }

  function renderAccountRow(account, quotaGroups = QUOTA_GROUPS) {
    const isCurrentAll = account.activeDesktop && account.activeCli && account.savedDesktop;
    const desktopSavedOffline = account.savedDesktop && currentState?.current?.desktopStatus === "stopped";
    const statusTags = [
      account.activeDesktop ? t("desktop") : desktopSavedOffline ? t("desktopSaved") : null,
      account.activeCli ? "CLI" : null,
      account.activeMagpieFirst ? t("magpiePreferred") : null,
      account.pendingDesktop ? t("desktopPending") : null
    ].filter(Boolean).map((label) => `<span class="tag tag-active">${label}</span>`).join("");

    const isPaid = account.isPaid ?? account.isPro;
    const tierClass = !account.isEligible ? "tag-bad" : isPaid ? "tag-pro" : account.isFree ? "tag-free" : "tag-unknown";
    const tierLabel = account.isEligible && account.plan
      ? account.plan
      : i18n.stateLabel(account.tierLabel) || t(isPaid ? "member" : "planUnknown");
    const planNote = account.isEligible && account.plan && account.planFromLoginRecord
      ? " · " + t("lastRecordedPlan") : "";
    const quotaIssue = account.isEligible ? quotaNotice(account.quota, quotaGroups) : "";

    const canSwitch = account.hasCredentials && account.isEligible;
    const disabled = pendingCommandType !== null || Boolean(currentState?.error);
    const cliSwitchHint = currentState?.current?.cliUsesSharedLogin
      ? t("cliShared")
      : t("cliNext");

    let actionButtons = "";
    if (canSwitch) {
      if (isCurrentAll || account.pendingDesktop) {
        actionButtons = `
          <button type="button" class="btn btn-ghost" data-action="reload-desktop" ${disabled ? "disabled" : ""}>
            ${t(account.pendingDesktop ? "activateDesktop" : "refreshDesktop")}
          </button>
        `;
      } else {
        actionButtons = `
          <button type="button" class="btn btn-primary" data-action="switch-all" data-email="${escapeHtml(account.email)}" ${disabled ? "disabled" : ""}>
            ${t("switch")}
          </button>
          <button type="button" class="btn btn-ghost" data-action="switch-cli" data-email="${escapeHtml(account.email)}" title="${cliSwitchHint}" ${disabled ? "disabled" : ""}>
            ${t("cliOnly")}
          </button>
        `;
      }
    }

    return `
      <div class="account-row">
        <div class="account-main">
          <div class="account-title-line">
            <span class="account-email">${escapeHtml(account.email)}</span>
            ${statusTags}
          </div>
          <div class="account-tags"><span class="tag ${tierClass}">${escapeHtml(tierLabel + planNote)}</span></div>
          ${quotaIssue ? `<span class="account-issue">${escapeHtml(quotaIssue)}</span>` : ""}
        </div>
        ${renderQuotaGrid(account, quotaGroups)}
        <div class="account-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }

  function renderAccountGroups(accounts) {
    const carbonWindows = CARBON_GROUP.windows.filter((window) => accounts.some(({ quota }) =>
      !quota?.error && !quota?.refreshError && !quota?.previousReading && quota?.pools?.some((pool) =>
        pool.pool === CARBON_GROUP.pool && pool.window === window &&
        Number.isFinite(pool.remaining) && !isStale(pool))));
    const quotaGroups = carbonWindows.length
      ? [...QUOTA_GROUPS, { ...CARBON_GROUP, windows: carbonWindows }]
      : QUOTA_GROUPS;
    const groups = [
      { label: t("members"), matches: (a) => a.isEligible && (a.isPaid ?? a.isPro) },
      { label: t("freeAccounts"), matches: (a) => a.isEligible && !(a.isPaid ?? a.isPro) && a.isFree },
      { label: t("planUnknown"), matches: (a) => a.isEligible && !(a.isPaid ?? a.isPro) && !a.isFree },
      { label: t("unavailableAccounts"), matches: (a) => !a.isEligible }
    ];
    return renderQuotaHeader(quotaGroups) + groups.map((group) => {
      const rows = accounts.filter(group.matches);
      return rows.length ? `<section class="account-group" aria-label="${group.label}">
        <h2>${group.label}<span>${rows.length}</span></h2>
        ${rows.map((account) => renderAccountRow(account, quotaGroups)).join("")}
      </section>` : "";
    }).join("");
  }

  function render(state) {
    const btnRefresh = document.getElementById("btnRefresh");
    if (btnRefresh) {
      const isRefreshing = pendingCommandType === "refresh";
      btnRefresh.disabled = pendingCommandType !== null;
      btnRefresh.setAttribute("aria-busy", String(isRefreshing));
      document.getElementById("refreshLabel").textContent = t(isRefreshing ? "refreshing" : "refresh");
    }

    if (!state) return;
    const hadStateError = Boolean(currentState?.error);
    currentState = state;
    if (state.error) showToast(state.error, false);
    else if (hadStateError) hideToast();

    const cur = state.current || {};

    const desktopNotice = document.getElementById("desktopNotice");
    desktopNotice?.classList.toggle("hidden", Boolean(state.error) || cur.desktopStatus !== "unknown");

    const allAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    const visibleAccounts = allAccounts.filter((account) => account.isEligible);
    const inactiveAccounts = allAccounts.filter((account) => !account.isEligible);

    const listEl = document.getElementById("accountList");
    if (listEl) {
      if (visibleAccounts.length === 0) {
        listEl.innerHTML = `<div class="account-empty-state">${t(allAccounts.length ? "noAvailable" : "noAccounts")}</div>`;
      } else {
        listEl.innerHTML = renderAccountGroups(visibleAccounts);
      }
    }

    const inactiveEl = document.getElementById("unavailableAccounts");
    if (inactiveEl) {
      inactiveEl.hidden = inactiveAccounts.length === 0;
      document.getElementById("unavailableSummary").textContent = `${t("unavailableAccounts")} · ${inactiveAccounts.length}`;
      document.getElementById("unavailableList").innerHTML = inactiveAccounts
        .map((account) => renderAccountRow(account)).join("");
    }

    const incomingSwitchId = state.lastSwitch?.cmdId || state.lastSwitch?.id || null;
    if (!state.error && incomingSwitchId && incomingSwitchId !== lastHandledSwitchId) {
      lastHandledSwitchId = incomingSwitchId;
      showCommandResult(state.lastSwitch);
    }
  }

  function receiveState(state) {
    if (!state || (state.generatedAt && state === currentState)) return;
    if (state.generatedAt && currentState?.generatedAt && state.generatedAt < currentState.generatedAt) return;
    if (!currentState && !pendingCommandType) lastHandledSwitchId = state.lastSwitch?.cmdId || state.lastSwitch?.id || null;
    render(state);
  }

  async function updateState() {
    try {
      receiveState(await globalThis.agyPage.state());
    } catch (err) {
      if (!currentState || err.message === t("reopen")) showToast(t("commandFailed") + i18n.separator() + err.message, false);
    }
  }

  async function sendPluginCommand(cmdPayload) {
    if (pendingCommandType !== null) return;
    const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fullCmd = { ...cmdPayload, id: cmdId, ts: Date.now(), language: i18n.locale() };

    pendingCommandType = cmdPayload.type;
    const isRefreshing = pendingCommandType === "refresh";
    if (isRefreshing) hideToast();
    render(currentState);

    try {
      const state = await globalThis.agyPage.command(fullCmd);
      receiveState(state);
      const result = state?.lastSwitch;
      if (result?.cmdId !== cmdId) throw Error(t("commandTimeout"));
      if (lastHandledSwitchId !== cmdId) showCommandResult(result);
    } catch (err) {
      const message = err.name === "TimeoutError" ? t(isRefreshing ? "refreshTimeout" : "commandTimeout")
        : `${t("commandFailed")}${i18n.separator()}${err.message || err}`;
      showToast(message, false);
    } finally {
      pendingCommandType = null;
      render(currentState);
    }
  }

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    if (target.closest("#btnGitHubStar")) {
      sendPluginCommand({ type: "open-github" });
      return;
    }

    if (target.closest("#btnRefresh")) {
      sendPluginCommand({ type: "refresh" });
      return;
    }

    const actionBtn = target.closest("[data-action]");
    if (!actionBtn) return;

    const action = actionBtn.getAttribute("data-action");
    const email = actionBtn.getAttribute("data-email");

    if (action === "switch-all" && email) {
      sendPluginCommand({
        type: "switch",
        email,
        target: "all",
        reloadDesktop: true,
        syncMagpie: true
      });
    } else if (action === "switch-cli" && email) {
      sendPluginCommand({
        type: "switch",
        email,
        target: "cli",
        reloadDesktop: false,
        syncMagpie: true
      });
    } else if (action === "reload-desktop") {
      sendPluginCommand({
        type: "reload-desktop"
      });
    }
  });

  globalThis.__AGY_SWITCH_ON_STATE__ = receiveState;

  function applyLanguage(value) {
    if (!value || !i18n.setLanguage(value)) return;
    i18n.apply();
    render(currentState);
    const toast = document.getElementById("toastBanner");
    if (lastToast && toast && !toast.classList.contains("hidden")) {
      toast.textContent = i18n.backend(lastToast).slice(0, 180);
    }
  }

  const magpie = globalThis.magpie;
  applyLanguage(magpie?.theme?.lang || globalThis.navigator?.language);
  magpie?.onTheme?.((theme) => applyLanguage(theme?.lang));
  magpie?.ready?.then((theme) => applyLanguage(theme?.lang)).catch(() => {});

  if (currentState) {
    render(currentState);
  } else {
    updateState();
  }

  setInterval(updateState, 2500);
})();
