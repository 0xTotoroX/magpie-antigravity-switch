/**
 * [INPUT]: 本机页面服务的账号快照、i18n.js 文案与 Magpie 页面桥接。
 * [OUTPUT]: Gemini 与 GPT / Claude 共享额度、套餐简称、登录状态和账号操作区的原位反馈。
 * [POS]: 经典脚本页面渲染器；不持有 OAuth 凭据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
(() => {
  const QUOTA_GROUPS = [
    { pool: "Gemini", label: "Gemini", windows: ["5 hours", "7 days"] },
    { pool: "Claude & GPT", label: "GPT / Claude", windows: ["5 hours", "7 days"] }
  ];

  const CARBON_GROUP = { pool: "Gemini 4 Carbon", label: "Gemini 4 Carbon", windows: ["5 hours", "7 days"] };

  const i18n = globalThis.agySwitchI18n;
  const t = i18n.text;

  let currentState = globalThis.__AGY_SWITCH_STATE__ || null;
  let pendingCommand;
  let trackedCommand;
  let feedback;
  let feedbackTimer;
  let toolbarIssue;
  let detailFeedback;
  let readError = "";
  let visibleListMarkup;
  let shownRowOperation;

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function openDetails(title, detail) {
    document.getElementById("feedbackTitle").textContent = title;
    document.getElementById("feedbackBody").textContent = detail;
    document.getElementById("feedbackDialog").showModal();
  }

  function finishCommand(cmd, result) {
    const warning = result.ok === false || Boolean(result.pageWarning);
    const detail = result.pageMessage || result.message || "";
    let label;
    if (cmd.type === "refresh") {
      label = result.ok === false ? "refreshFailed" : warning ? "partialFailure" : "refreshed";
    } else if (cmd.type === "reload-desktop") {
      label = warning ? "reloadFailed" : "reloading";
    } else if (cmd.type === "switch") {
      label = result.ok === false ? "switchFailed" : warning ? "desktopWarning" : cmd.target === "cli" ? "cliSaved" : "saved";
    }
    // 保留后台给出的桌面端实际状态，只去掉本行已有的账号名。
    const prefix = `已保存登录 · ${cmd.email} · `;
    let status = "";
    if (!warning && cmd.type === "refresh") status = result.pageMessage || "";
    if (!warning && cmd.type === "switch" && detail.startsWith(prefix)) status = detail.slice(prefix.length);
    feedback = { cmd, label, status, detail, warning };
    clearTimeout(feedbackTimer);
    if (!warning) feedbackTimer = setTimeout(() => { feedback = null; render(currentState); }, 4500);
  }

  function feedbackLabel() {
    return feedback.status ? i18n.backend(feedback.status) : feedback.label ? t(feedback.label) : i18n.backend(feedback.detail);
  }

  function fillClass(remaining) {
    if (remaining <= 12) return "is-low";
    if (remaining <= 35) return "is-warn";
    return "";
  }

  function periodLabel(window) {
    return window === "5 hours" ? "5h" : "7d";
  }

  function shortPlan(label) {
    if (/^Antigravity Starter Quota$/i.test(label)) return "Starter";
    return label.replace(/^(?:Google AI|Antigravity) (?=(?:Pro|Ultra|Enterprise)\b)/i, "");
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
    const minutes = Math.ceil((resetAt - Date.now()) / 60000);
    const hasReset = known && minutes > 0;
    const resetTitle = hasReset ? escapeHtml(`${t("resetTime")}${i18n.separator()}${new Date(resetAt).toLocaleString(i18n.locale())}`) : "";
    return `<div class="quota-cell ${known ? fillClass(remaining) : stale ? "is-unknown is-stale" : "is-unknown"}" data-pool="${group.pool}" data-window="${window}" ${hasReset ? `tabindex="0" title="${resetTitle}"` : ""}>
      <span class="quota-period">${period}</span>
      <strong class="quota-value" aria-label="${label}${i18n.separator()}${accessibleValue}">${value}</strong>
      <span class="quota-bar" style="--remaining:${remaining}%" ${known ? `role="progressbar" aria-label="${label} ${t("remaining")}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"` : 'aria-hidden="true"'}>
        <span class="quota-fill"></span>
      </span>
      ${hasReset ? `<span class="quota-reset"><span class="reset-long">${i18n.reset(minutes)}</span><span class="reset-short">${i18n.reset(minutes, true)}</span></span>` : ""}
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
      ${quotaGroups.map((group) => `<div class="quota-group"${group.pool === CARBON_GROUP.pool ? " data-optional" : ""}>
        <span class="quota-group-label">${group.label}</span>
        <div class="quota-windows ${group.windows.length === 1 ? "is-single" : ""}">
          ${group.windows.map((window) => renderQuotaCell(group, window, pools)).join("")}
        </div>
      </div>`).join("")}
    </div>`;
  }

  function renderQuotaHeader(quotaGroups, count) {
    return `<div class="quota-header"><span class="account-count">${i18n.accountCount(count)}</span>
      <div ${quotaGridAttributes(quotaGroups)} aria-hidden="true">${quotaGroups.map((group) => `<div class="quota-group">
        <strong>${group.label}</strong>
        <div class="quota-windows ${group.windows.length === 1 ? "is-single" : ""}">${group.windows.map((window) => `<span>${periodLabel(window)}</span>`).join("")}</div>
      </div>`).join("")}</div><span></span></div>`;
  }

  function systemQuotaReason(error) {
    if (/^(?:agy usage query timed out\.?|context deadline exceeded|agy 额度查询超时|Magpie 额度刷新超时)$/i.test(error || "")) return t("quotaQueryTimeout");
    if (error === "找不到 Magpie 命令，无法刷新额度") return i18n.backend(error);
    return "";
  }

  function previousReading(quota, quotaGroups) {
    const hasReading = !quota.error && quota.pools?.some((pool) =>
      Number.isFinite(pool.remaining) && !isStale(pool) &&
      quotaGroups.some((group) => group.pool === pool.pool && group.windows.includes(pool.window)));
    if (!hasReading) return "";

    const date = new Date(quota.updatedAt ?? NaN);
    const updated = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(i18n.locale(), {
        ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(date).replace(", ", " ")
      : t("timeUnknown");
    return `${t("previousReading")} ${updated}`;
  }

  function quotaNotice(quota, quotaGroups) {
    if (!quota) return "";
    const error = quota.error || quota.refreshError;
    if (systemQuotaReason(error) || (!error && !quota.previousReading)) return "";
    const reason = error === "Magpie 未能刷新这个账号的额度" ? t("refreshFailed") : i18n.backend(error);
    return [reason, previousReading(quota, quotaGroups)].filter(Boolean).join(" · ");
  }

  function sharedQuotaIssue(accounts, quotaGroups) {
    const groups = new Map();
    for (const { email, quota } of accounts) {
      const reason = systemQuotaReason(quota?.error || quota?.refreshError);
      if (!reason) continue;
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason).push({ email, previous: previousReading(quota, quotaGroups) });
    }
    if (!groups.size) return null;
    const summaries = [];
    const details = [];
    for (const [reason, rows] of groups) {
      const all = rows.length === accounts.length;
      const same = rows.every((row) => row.previous === rows[0].previous);
      const scope = all ? "" : i18n.accountCount(rows.length);
      const history = same ? rows[0].previous : rows.some((row) => row.previous) ? t("previousReading") : "";
      const summary = [reason, scope, history].filter(Boolean).join(" · ");
      summaries.push(summary);
      const affected = rows.map(({ email, previous }) => [email, !same && previous].filter(Boolean).join(" · "));
      details.push(all && same ? summary : summary + "\n" + affected.join("\n"));
    }
    return { label: summaries.join(" · "), detail: details.join("\n\n") };
  }

  function showsDesktopCheck(account) {
    return account.isEligible && account.savedDesktop && account.activeCli &&
      currentState?.current?.desktopStatus === "unknown";
  }

  function renderActions(account) {
    const email = escapeHtml(account.email);
    const locked = pendingCommand || currentState?.error ? "disabled" : "";
    const pending = account.pendingDesktop && currentState?.current?.desktopStatus !== "unknown";
    const canSwitch = account.hasCredentials && account.isEligible;
    const busy = pendingCommand?.email === account.email && pendingCommand;
    const result = feedback?.cmd.email === account.email && feedback;
    const command = busy || result?.cmd;
    const origin = command?.type === "switch" ? ` data-origin="${command.target === "cli" ? "end" : "start"}"` : "";
    const clock = '<span class="action-icon icon-clock" aria-hidden="true"></span>';

    if (busy) {
      const label = busy.type === "reload-desktop" ? t(pending ? "applying" : "reloading") : t("switching");
      return `<span class="action-feedback is-busy"${origin} aria-busy="true"><span class="action-icon icon-spinner" aria-hidden="true"></span><span>${label}</span></span>`;
    }
    if (result?.warning) {
      return `<button type="button" class="btn action-feedback feedback-warning"${origin} data-action="feedback-detail"
        title="${escapeHtml(i18n.backend(result.detail))}"><span class="action-icon icon-info" aria-hidden="true">i</span><span>${escapeHtml(feedbackLabel())}</span></button>`;
    }
    // When the command leaves Desktop pending, offer the next action immediately.
    if (result && !(pending && result.status === "桌面端待生效" && canSwitch)) {
      const waiting = result.cmd.type === "reload-desktop" ||
        ["桌面端重载中", "桌面端待生效", "打开桌面端后生效", "桌面端账号待确认"].includes(result.status);
      const icon = waiting ? clock : '<span class="action-icon icon-check" aria-hidden="true"></span>';
      const label = result.status === "打开桌面端后生效" ? t("onLaunch") : feedbackLabel();
      return `<span class="action-feedback ${waiting ? "is-waiting" : "is-done"}"${origin}
        title="${escapeHtml(i18n.backend(result.detail))}">${icon}<span>${escapeHtml(label)}</span></span>`;
    }
    if (showsDesktopCheck(account)) return `<span class="action-feedback is-waiting" role="status">${t("desktopUnknown")}</span>`;
    if (!canSwitch) return pending ? `<span class="action-feedback is-waiting">${clock}${t("desktopPending")}</span>` : "";

    if (pending) {
      const hint = `${t("activateDesktop")} · ${t("desktopPending")}`;
      return `<button type="button" class="btn btn-ghost action-apply" data-action="reload-desktop" data-email="${email}"
        aria-label="${hint}" title="${hint}" ${locked}>${clock}${t("activateDesktop")}</button>`;
    }
    if (account.activeDesktop && account.activeCli && account.savedDesktop) {
      return `<button type="button" class="btn btn-ghost" data-action="reload-desktop" data-email="${email}" ${locked}>${t("refreshDesktop")}</button>`;
    }
    return `<button type="button" class="btn btn-primary" data-action="switch-all" data-email="${email}" ${locked}>${t("switch")}</button>
      <button type="button" class="btn btn-cli" data-action="switch-cli" data-email="${email}"
        title="${t(currentState?.current?.cliUsesSharedLogin ? "cliShared" : "cliNext")}" ${locked}>${t("cliOnly")}</button>`;
  }

  function renderAccountRow(account, quotaGroups = QUOTA_GROUPS) {
    const desktopSavedOffline = account.savedDesktop && currentState?.current?.desktopStatus === "stopped";
    const statusTags = [
      account.activeDesktop ? t("desktop") : desktopSavedOffline ? t("desktopSaved") : null,
      account.activeMagpieFirst ? t("magpiePreferred") : null
    ].filter(Boolean).map((label) => `<span class="tag tag-active">${label}</span>`).join("");

    const isPaid = account.isPaid ?? account.isPro;
    const tierClass = !account.isEligible ? "tag-bad" : isPaid ? "tag-pro" : account.isFree ? "tag-free" : "tag-unknown";
    const tierLabel = shortPlan((account.isEligible && account.plan) || i18n.stateLabel(account.tierLabel) || t(isPaid ? "member" : "planUnknown"));
    const quotaIssue = account.isEligible ? quotaNotice(account.quota, quotaGroups) : "";

    return `
      <div class="account-row">
        <div class="account-main">
          <div class="account-title-line">
            <span class="account-email">${escapeHtml(account.email)}</span>
            ${account.activeCli ? '<span class="cli-status">CLI</span>' : ""}
          </div>
          <div class="account-tags"><span class="tag ${tierClass}">${escapeHtml(tierLabel)}</span>${statusTags}</div>
          ${quotaIssue ? `<span class="account-issue">${escapeHtml(quotaIssue)}</span>` : ""}
        </div>
        ${renderQuotaGrid(account, quotaGroups)}
        <div class="account-actions" id="actions-${escapeHtml(account.email)}" tabindex="-1">
          ${renderActions(account)}
        </div>
      </div>
    `;
  }

  function visibleQuotaGroups(accounts) {
    const carbonWindows = CARBON_GROUP.windows.filter((window) => accounts.some(({ quota }) =>
      !quota?.error && !quota?.refreshError && !quota?.previousReading && quota?.pools?.some((pool) =>
        pool.pool === CARBON_GROUP.pool && pool.window === window &&
        Number.isFinite(pool.remaining) && !isStale(pool))));
    return carbonWindows.length
      ? [QUOTA_GROUPS[0], { ...CARBON_GROUP, windows: carbonWindows }, QUOTA_GROUPS[1]]
      : QUOTA_GROUPS;
  }

  function renderAccountGroups(accounts, quotaGroups) {
    const groups = [
      { label: t("members"), matches: (a) => a.isEligible && (a.isPaid ?? a.isPro) },
      { label: t("freeAccounts"), matches: (a) => a.isEligible && !(a.isPaid ?? a.isPro) && a.isFree },
      { label: t("planUnknown"), matches: (a) => a.isEligible && !(a.isPaid ?? a.isPro) && !a.isFree },
      { label: t("unavailableAccounts"), matches: (a) => !a.isEligible }
    ];
    return renderQuotaHeader(quotaGroups, accounts.length) + groups.map((group) => {
      const rows = accounts.filter(group.matches);
      return rows.length ? `<section class="account-group" aria-label="${group.label}">
        <h2>${group.label}<span>${rows.length}</span></h2>
        ${rows.map((account) => renderAccountRow(account, quotaGroups)).join("")}
      </section>` : "";
    }).join("");
  }

  function render(state) {
    const refreshing = pendingCommand?.type === "refresh";
    const btnRefresh = document.getElementById("btnRefresh");
    btnRefresh.disabled = Boolean(pendingCommand);
    btnRefresh.setAttribute("aria-busy", String(refreshing));
    const refreshResult = feedback?.cmd.type === "refresh" && feedback;
    document.getElementById("refreshLabel").textContent = refreshing ? t("refreshing")
      : refreshResult && !refreshResult.warning ? feedbackLabel() : t("refresh");
    document.getElementById("btnGitHubStar").disabled = Boolean(pendingCommand);

    const error = state?.error || readError || (feedback?.cmd.type === "open-github" && feedback.warning && feedback.detail);
    const toast = document.getElementById("toastBanner");
    toast.textContent = error ? i18n.backend(error) : "";
    toast.classList.toggle("hidden", !error);
    if (state) currentState = state;
    const cur = state?.current || {};

    const desktopNotice = document.getElementById("desktopNotice");
    const allAccounts = Array.isArray(state?.accounts) ? state.accounts : [];
    const visibleAccounts = allAccounts.filter((account) => account.isEligible);
    desktopNotice?.classList.toggle("hidden", Boolean(state?.error) || cur.desktopStatus !== "unknown" || visibleAccounts.some(showsDesktopCheck));
    const quotaGroups = visibleQuotaGroups(visibleAccounts);
    toolbarIssue = sharedQuotaIssue(visibleAccounts, quotaGroups);
    if (refreshResult?.warning) {
      const detail = i18n.backend(refreshResult.detail);
      if (!toolbarIssue) toolbarIssue = { label: feedbackLabel(), detail };
      else if (refreshResult.label === "refreshFailed" && !toolbarIssue.detail.includes(detail)) {
        toolbarIssue.detail = detail + "\n\n" + toolbarIssue.detail;
      }
    }
    const issueButton = document.getElementById("quotaStatus");
    issueButton.hidden = !toolbarIssue;
    issueButton.innerHTML = toolbarIssue
      ? `<span class="issue-long">${escapeHtml(toolbarIssue.label)}</span><span class="issue-short">${escapeHtml(toolbarIssue.label.includes(t("previousReading")) ? t("previousReading") : t("quotaProblem"))}</span>`
      : "";
    issueButton.title = toolbarIssue?.detail || "";
    issueButton.setAttribute("aria-label", issueButton.title);
    const status = pendingCommand?.email ? t(pendingCommand.type === "reload-desktop" ? "reloading" : "switching")
      : refreshing ? t("refreshing") : feedback?.label ? feedbackLabel() : "";
    const announcement = [pendingCommand?.email || feedback?.cmd.email, status].filter(Boolean).join(" · ");
    const live = document.getElementById("operationStatus");
    if (live.textContent !== announcement) live.textContent = announcement;

    if (!state) return;
    const inactiveAccounts = allAccounts.filter((account) => !account.isEligible);

    const listEl = document.getElementById("accountList");
    if (listEl) {
      const markup = visibleAccounts.length ? renderAccountGroups(visibleAccounts, quotaGroups)
        : `<div class="account-empty-state">${t(allAccounts.length ? "noAvailable" : "noAccounts")}</div>`;
      if (markup !== visibleListMarkup) {
        const focused = document.activeElement;
        const focusedSlot = focused?.closest(".account-actions");
        const originalAction = focused?.dataset.action;
        const restoreAction = originalAction && originalAction !== "feedback-detail" ? originalAction : focusedSlot?.dataset.returnAction;
        listEl.innerHTML = markup;
        visibleListMarkup = markup;
        if (focusedSlot) {
          const slot = document.getElementById(focusedSlot.id);
          if (slot && restoreAction) slot.dataset.returnAction = restoreAction;
          const buttons = Array.from(slot?.querySelectorAll("button:enabled") || []);
          const next = buttons.find(button => button.dataset.action === restoreAction) || buttons[0] || slot;
          next?.focus({ preventScroll: true });
        }
        // Animate only the row whose operation changed, including its return to idle.
        const operation = pendingCommand?.email ? pendingCommand : feedback?.cmd.email ? feedback : null;
        if (operation !== shownRowOperation) {
          const shown = operation || shownRowOperation;
          const email = shown?.cmd?.email || shown?.email;
          shownRowOperation = operation;
          const slot = email && document.getElementById("actions-" + email);
          if (slot?.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
            slot.animate([{ opacity: 0.45, transform: "translateY(2px)" }, { opacity: 1, transform: "none" }],
              { duration: 160, easing: "ease-out" });
          }
        }
      }
    }

    const inactiveEl = document.getElementById("unavailableAccounts");
    if (inactiveEl) {
      inactiveEl.hidden = inactiveAccounts.length === 0;
      document.getElementById("unavailableSummary").textContent = `${t("unavailableAccounts")} · ${inactiveAccounts.length}`;
      document.getElementById("unavailableList").innerHTML = inactiveAccounts
        .map((account) => renderAccountRow(account)).join("");
    }
  }

  function receiveState(state) {
    if (!state) return;
    if (state.generatedAt && currentState?.generatedAt && state.generatedAt < currentState.generatedAt) return;
    readError = "";
    if (trackedCommand && state.lastSwitch?.cmdId === trackedCommand.id) {
      finishCommand(trackedCommand, state.lastSwitch);
      trackedCommand = null;
    }
    render(state);
  }

  async function updateState() {
    try {
      receiveState(await globalThis.agyPage.state());
    } catch (err) {
      if (!currentState || err.message === t("reopen")) {
        readError = err.message;
        render(currentState);
      }
    }
  }

  async function sendPluginCommand(cmdPayload) {
    if (pendingCommand) return;
    const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fullCmd = { ...cmdPayload, id: cmdId, ts: Date.now(), language: i18n.locale() };

    pendingCommand = fullCmd;
    trackedCommand = fullCmd;
    clearTimeout(feedbackTimer);
    feedback = null;
    render(currentState);
    try {
      const state = await globalThis.agyPage.command(fullCmd);
      if (state?.lastSwitch?.cmdId !== cmdId) throw Error(t("commandTimeout"));
      if (trackedCommand) {
        finishCommand(fullCmd, state.lastSwitch);
        trackedCommand = null;
      }
      receiveState(state);
    } catch (err) {
      if (trackedCommand) {
        const detail = err.name === "TimeoutError" ? t(fullCmd.type === "refresh" ? "refreshTimeout" : "commandTimeout") : err.message;
        finishCommand(fullCmd, { ok: false, message: detail });
      }
    } finally {
      pendingCommand = null;
      render(currentState);
    }
  }

  document.getElementById("feedbackDialog").addEventListener("close", () => {
    if (detailFeedback && detailFeedback === feedback) {
      feedback = null;
      render(currentState);
    }
    detailFeedback = null;
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    if (target.closest("#closeFeedback")) {
      document.getElementById("feedbackDialog").close();
      return;
    }
    if (target.closest("#quotaStatus") && toolbarIssue) {
      openDetails(t("quota"), toolbarIssue.detail);
      return;
    }
    if (target.closest('[data-action="feedback-detail"]') && feedback) {
      detailFeedback = feedback;
      openDetails(feedbackLabel(), i18n.backend(feedback.detail));
      return;
    }
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
        type: "reload-desktop", email
      });
    }
  });

  globalThis.__AGY_SWITCH_ON_STATE__ = receiveState;

  function applyLanguage(value) {
    if (!value || !i18n.setLanguage(value)) return;
    i18n.apply();
    render(currentState);
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
