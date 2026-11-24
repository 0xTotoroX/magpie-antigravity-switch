/**
 * [INPUT]: 本机页面服务的账号快照、i18n.js 文案与 Magpie 页面桥接。
 * [OUTPUT]: Gemini 与 GPT / Claude 共享额度、套餐简称、邮箱旁的桌面登录标记、原位切换反馈与工具栏额度补查。
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
  let pendingRefresh = false;
  let refreshFeedback;
  let refreshFeedbackTimer;
  let toolbarIssue;
  let detailFeedback;
  let readError = "";
  let visibleListMarkup;

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
    if (cmd.type === "refresh") {
      const label = result.ok === false ? "refreshFailed" : warning ? "partialFailure" : "refreshed";
      refreshFeedback = { label, detail, warning, status: warning ? "" : result.pageMessage,
        accountErrors: result.failedAccounts || [] };
      clearTimeout(refreshFeedbackTimer);
      if (!warning) refreshFeedbackTimer = setTimeout(() => { refreshFeedback = null; render(currentState); }, 3500);
      return;
    }
    const label = cmd.type === "switch"
      ? result.ok === false ? "switchFailed" : warning ? "desktopWarning" : cmd.target === "cli" ? "cliSaved" : "saved"
      : null;
    feedback = { cmd, label, detail, warning };
    clearTimeout(feedbackTimer);
    if (!warning) feedbackTimer = setTimeout(() => { feedback = null; render(currentState); }, 2400);
  }

  function feedbackLabel(item = feedback) {
    return item.status ? i18n.backend(item.status) : item.label ? t(item.label) : i18n.backend(item.detail);
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
    if (quota.retryPending || systemQuotaReason(error) || (!error && !quota.previousReading)) return "";
    const reason = error === "Magpie 未能刷新这个账号的额度" ? t("refreshFailed") : i18n.backend(error);
    return [reason, previousReading(quota, quotaGroups)].filter(Boolean).join(" · ");
  }

  function sharedQuotaIssue(accounts, quotaGroups) {
    const groups = new Map();
    for (const { email, quota } of accounts) {
      const error = quota?.error || quota?.refreshError;
      const retrying = Boolean(error && quota.retryPending);
      const reason = retrying ? t("quotaRetry") : systemQuotaReason(error);
      if (!reason) continue;
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason).push({ email, cause: retrying ? i18n.backend(error) : "", previous: previousReading(quota, quotaGroups) });
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
      const affected = rows.map(({ email, cause, previous }) => [email, cause, !same && previous].filter(Boolean).join(" · "));
      details.push(summary + "\n" + affected.join("\n"));
    }
    const onlyReason = groups.size === 1 ? groups.keys().next().value : null;
    const retryOnly = onlyReason === t("quotaRetry");
    const shortLabel = retryOnly ? t("quotaRetry") : onlyReason === t("quotaQueryTimeout") ? t("quotaTimedOut") : t("quotaProblem");
    return { label: summaries.join(" · "), detail: details.join("\n\n"), retryOnly, shortLabel };
  }

  function desktopNeedsConfirmation(current) {
    return current?.desktopRunning === true || current?.desktopStatus === "unknown";
  }

  function renderDesktopMark(account) {
    if (!account.isEligible || !account.savedDesktop) return "";
    if (!account.activeDesktopKeychain) {
      return `<span class="desktop-pending" title="${t("desktopUnknown")}">${t("desktopPendingShort")}</span>`;
    }
    return `<button type="button" class="desktop-mark" id="desktop-${escapeHtml(account.email)}"
      data-action="saved-login-detail" data-email="${escapeHtml(account.email)}"
      aria-label="${t("desktopSaved")}" title="${t("desktopSaved")}">
      <span class="action-icon icon-check" aria-hidden="true"></span></button>`;
  }

  function renderSwitchButton(account, target) {
    const cli = target === "cli";
    const action = cli ? "switch-cli" : "switch-all";
    const attrs = `id="${action}-${escapeHtml(account.email)}"`;
    const busy = pendingCommand?.email === account.email && pendingCommand.target === target;
    const warning = feedback?.warning && feedback.cmd.email === account.email && feedback.cmd.target === target ? feedback : null;
    if (busy) {
      return `<button type="button" class="btn switch-status is-busy" ${attrs} aria-disabled="true" aria-busy="true">
        <span class="action-icon icon-spinner" aria-hidden="true"></span><span>${t("switchingShort")}</span></button>`;
    }
    if (warning) {
      const label = t(warning.label);
      const shortLabel = t(warning.label === "desktopWarning" ? "desktopPendingShort" : "switchFailedShort");
      return `<button type="button" class="btn switch-status feedback-warning" ${attrs} data-action="feedback-detail"
        aria-label="${label}" title="${escapeHtml(i18n.backend(warning.detail))}">
        <span class="action-icon icon-info" aria-hidden="true">i</span><span>${shortLabel}</span></button>`;
    }
    const title = cli ? `title="${t(currentState?.current?.cliUsesSharedLogin ? "cliShared" : "cliNext")}"` : "";
    const locked = pendingCommand || currentState?.error || !account.hasCredentials ? "disabled" : "";
    return `<button type="button" class="btn ${cli ? "btn-cli" : "btn-primary"}" ${attrs}
      data-action="${action}" data-email="${escapeHtml(account.email)}" ${title} ${locked}>${t(cli ? "cliOnly" : "switch")}</button>`;
  }

  function renderAccountRow(account, quotaGroups = QUOTA_GROUPS) {
    const magpieTag = account.activeMagpieFirst ? `<span class="tag tag-active">${t("magpiePreferred")}</span>` : "";

    const isPaid = account.isPaid ?? account.isPro;
    const tierClass = !account.isEligible ? "tag-bad" : isPaid ? "tag-pro" : account.isFree ? "tag-free" : "tag-unknown";
    const tierLabel = shortPlan((account.isEligible && account.plan) || i18n.stateLabel(account.tierLabel) || t(isPaid ? "member" : "planUnknown"));
    const quotaIssue = account.isEligible ? quotaNotice(account.quota, quotaGroups) : "";
    const showActions = account.isEligible && (account.hasCredentials || pendingCommand?.email === account.email || feedback?.cmd.email === account.email);

    return `
      <div class="account-row">
        <div class="account-main">
          <div class="account-title-line">
            <span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span>${renderDesktopMark(account)}
            ${account.activeCli ? `<span class="cli-status" title="${t("cliNext")}">CLI</span>` : ""}
          </div>
          <div class="account-tags"><span class="tag ${tierClass}">${escapeHtml(tierLabel)}</span>${magpieTag}</div>
          ${quotaIssue ? `<span class="account-issue">${escapeHtml(quotaIssue)}</span>` : ""}
        </div>
        ${renderQuotaGrid(account, quotaGroups)}
        ${showActions ? `<div class="account-actions" id="actions-${escapeHtml(account.email)}" tabindex="-1">
          ${renderSwitchButton(account, "all")}${renderSwitchButton(account, "cli")}
        </div>` : ""}
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
    const refreshing = pendingRefresh;
    const progress = refreshing && state?.refreshProgress;
    const btnRefresh = document.getElementById("btnRefresh");
    btnRefresh.disabled = refreshing;
    btnRefresh.setAttribute("aria-busy", String(refreshing));
    if (refreshFeedback?.accountErrors.length && state?.accounts && !state.error &&
        !state.accounts.some(a => refreshFeedback.accountErrors.includes(a.email) && (a.quota?.refreshError || a.quota?.error))) {
      refreshFeedback = null;
    }
    const refreshResult = refreshFeedback;
    document.getElementById("refreshLabel").textContent = progress?.total ? `${t("refreshProgress")} ${progress.completed}/${progress.total}`
      : refreshing ? t("refreshing") : refreshResult && !refreshResult.warning ? feedbackLabel(refreshResult) : t("refresh");
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
    desktopNotice?.classList.toggle("hidden", Boolean(state?.error) || !desktopNeedsConfirmation(cur) || visibleAccounts.some(account => account.savedDesktop));
    const quotaGroups = visibleQuotaGroups(visibleAccounts);
    toolbarIssue = sharedQuotaIssue(visibleAccounts, quotaGroups);
    if (refreshResult?.warning) {
      const detail = i18n.backend(refreshResult.detail);
      if (!toolbarIssue) toolbarIssue = { label: feedbackLabel(refreshResult), detail };
      else if (refreshResult.label === "refreshFailed" && !toolbarIssue.detail.includes(detail)) {
        toolbarIssue.detail = detail + "\n\n" + toolbarIssue.detail;
      }
    }
    const issueButton = document.getElementById("quotaStatus");
    issueButton.hidden = !toolbarIssue;
    issueButton.classList.toggle("is-retrying", Boolean(toolbarIssue?.retryOnly));
    issueButton.innerHTML = toolbarIssue
      ? `<span class="issue-long">${escapeHtml(toolbarIssue.label)}</span><span class="issue-short">${escapeHtml(toolbarIssue.shortLabel || t("quotaProblem"))}</span>`
      : "";
    issueButton.title = toolbarIssue?.detail || "";
    issueButton.setAttribute("aria-label", issueButton.title);
    const switchEmail = pendingCommand?.email || feedback?.cmd.email;
    const status = pendingCommand?.email ? t("switching")
      : switchEmail ? feedbackLabel() : refreshing ? t("refreshing") : "";
    const announcement = [switchEmail, status].filter(Boolean).join(" · ");
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
        const focusedId = listEl.contains?.(focused) && focused?.id;
        const focusedSlotId = focused?.closest(".account-actions")?.id;
        listEl.innerHTML = markup;
        visibleListMarkup = markup;
        if (focusedId) {
          const next = document.getElementById(focusedId);
          const fallback = focusedSlotId ? document.getElementById(focusedSlotId) : null;
          (next && !next.disabled ? next : fallback)?.focus({ preventScroll: true });
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
    const refresh = cmdPayload.type === "refresh";
    if (refresh ? pendingRefresh : pendingCommand) return;
    const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fullCmd = { ...cmdPayload, id: cmdId, ts: Date.now(), language: i18n.locale() };

    if (refresh) {
      pendingRefresh = true;
      clearTimeout(refreshFeedbackTimer);
      refreshFeedback = null;
    } else {
      pendingCommand = fullCmd;
      trackedCommand = fullCmd;
      clearTimeout(feedbackTimer);
      feedback = null;
    }
    render(currentState);
    try {
      const state = await globalThis.agyPage.command(fullCmd);
      if (state?.lastSwitch?.cmdId !== cmdId) throw Error(t("commandTimeout"));
      if (refresh || trackedCommand) {
        finishCommand(fullCmd, state.lastSwitch);
        if (!refresh) trackedCommand = null;
      }
      receiveState(state);
    } catch (err) {
      if (refresh || trackedCommand) {
        const detail = err.name === "TimeoutError" ? t(fullCmd.type === "refresh" ? "refreshTimeout" : "commandTimeout") : err.message;
        finishCommand(fullCmd, { ok: false, message: detail });
      }
    } finally {
      if (refresh) pendingRefresh = false;
      else { pendingCommand = null; trackedCommand = null; }
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
    const saved = target.closest('[data-action="saved-login-detail"]');
    if (saved) {
      const switchDetails = feedback && feedback.cmd.email === saved.getAttribute("data-email") &&
        feedback.cmd.target === "all" && !feedback.warning ? i18n.backend(feedback.detail) : "";
      openDetails(t("desktopSaved"), [switchDetails, t("savedDesktopDetail")].filter(Boolean).join("\n\n"));
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
