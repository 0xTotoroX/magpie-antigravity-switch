/**
 * [INPUT]: state.js 的账号快照与 Magpie 页面桥接。
 * [OUTPUT]: 按账号类型分组的 Magpie 五窗口额度、原始档位、行内登录状态与用户操作指令。
 * [POS]: 经典脚本页面渲染器；不持有 OAuth 凭据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
(() => {
  const PLUGIN_NAME = "magpie-antigravity-switch";
  const QUOTA_GROUPS = [
    { pool: "Claude & GPT", label: "GPT / Claude", windows: ["5 hours", "7 days"] },
    { pool: "Gemini", label: "Gemini", windows: ["5 hours", "7 days"] },
    { pool: "Gemini 4 Argon", label: "Gemini 4 Argon", windows: ["7 days"] }
  ];

  let currentState = globalThis.__AGY_SWITCH_STATE__ || null;
  let lastHandledSwitchId = currentState?.lastSwitch?.cmdId || currentState?.lastSwitch?.id || null;
  let isBusy = false;

  async function ensureMagpieBridge() {
    if (globalThis.magpie?.options?.set || typeof globalThis.magpie?.saveOptions === "function") {
      if (globalThis.magpie.ready) {
        try {
          await globalThis.magpie.ready;
        } catch {
          // ignore
        }
      }
      return globalThis.magpie;
    }
    const candidates = ["_magpie/bridge.js", "./_magpie/bridge.js", "/_magpie/bridge.js"];
    for (const src of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = src;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        if (globalThis.magpie?.options?.set || typeof globalThis.magpie?.saveOptions === "function") {
          if (globalThis.magpie.ready) {
            try {
              await globalThis.magpie.ready;
            } catch {
              // ignore
            }
          }
          return globalThis.magpie;
        }
      } catch {
        // try next
      }
    }
    return globalThis.magpie || null;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showToast(message, isOk = true) {
    const el = document.getElementById("toastBanner");
    if (!el || !message) return;
    const clean = String(message).slice(0, 180);
    el.textContent = clean;
    el.className = `toast ${isOk ? "is-ok" : "is-error"}`;
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
    if (minutes >= 1440) return `${Math.floor(minutes / 1440)}天后重置`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}小时后重置`;
    return `${minutes}分后重置`;
  }

  function renderQuotaCell(group, window, pools) {
    const reading = pools.find((p) => p.pool === group.pool && p.window === window);
    const period = periodLabel(window);
    const resetAt = Date.parse(reading?.resetsAt);
    const expired = resetAt <= Date.now();
    const stale = Boolean(reading?.stale || expired);
    const known = Number.isFinite(reading?.remaining) && !stale;
    const remaining = known ? Math.max(0, Math.min(100, Math.round(reading.remaining))) : 0;
    const value = known ? `${remaining}%` : stale ? "待刷新" : "未知";
    const label = `${group.label} ${period}`;
    return `<div class="quota-cell ${known ? fillClass(remaining) : "is-unknown"}" data-pool="${group.pool}" data-window="${window}">
      <span class="quota-period">${period}</span>
      <strong class="quota-value" aria-label="${label}：${value}">${value}</strong>
      <span class="quota-bar" ${known ? `role="progressbar" aria-label="${label} 剩余" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"` : 'aria-hidden="true"'}>
        <span class="quota-fill" style="width:${known ? remaining : 0}%"></span>
      </span>
      <span class="quota-reset" title="${known && Number.isFinite(resetAt) ? escapeHtml(`重置时间：${new Date(resetAt).toLocaleString("zh-CN")}`) : ""}">${known ? resetLabel(reading.resetsAt) : ""}</span>
    </div>`;
  }

  function renderQuotaGrid(account) {
    if (!account.isEligible) return `<div class="account-unavailable">账号需验证或地区受限</div>`;
    const pools = account.quota?.error ? [] : account.quota?.pools || [];
    return `<div class="account-quotas" aria-label="Magpie 配额">
      ${QUOTA_GROUPS.map((group) => `<div class="quota-group">
        <span class="quota-group-label">${group.label}</span>
        <div class="quota-windows ${group.windows.length === 1 ? "is-single" : ""}">
          ${group.windows.map((window) => renderQuotaCell(group, window, pools)).join("")}
        </div>
      </div>`).join("")}
    </div>`;
  }

  function renderQuotaHeader() {
    return `<div class="quota-header" aria-hidden="true"><span>账号</span>
      <div class="account-quotas">${QUOTA_GROUPS.map((group) => `<div class="quota-group">
        <strong>${group.label}</strong>
        <div class="quota-windows ${group.windows.length === 1 ? "is-single" : ""}">${group.windows.map((window) => `<span>${periodLabel(window)}</span>`).join("")}</div>
      </div>`).join("")}</div><span class="actions-heading">操作</span></div>`;
  }

  function renderAccountRow(account) {
    const isCurrentAll = account.activeDesktop && account.activeCli && account.savedDesktop;
    const desktopSavedOffline = account.savedDesktop && currentState?.current?.desktopStatus === "stopped";
    const statusTags = [
      account.activeDesktop ? "桌面端" : desktopSavedOffline ? "桌面端已保存" : null,
      account.activeCli ? "CLI" : null,
      account.activeMagpieFirst ? "Magpie 首选" : null,
      account.pendingDesktop ? "桌面端待生效" : null
    ].filter(Boolean).map((label) => `<span class="tag tag-active">${label}</span>`).join("");

    const isPaid = account.isPaid ?? account.isPro;
    const tierClass = !account.isEligible ? "tag-bad" : isPaid ? "tag-pro" : account.isFree ? "tag-free" : "tag-unknown";
    const tierLabel = account.tierLabel || account.plan || (isPaid ? "会员" : "套餐未知");
    const quotaIssue = account.isEligible && (account.quota?.error || account.quota?.refreshError);

    const canSwitch = account.hasCredentials && account.isEligible;
    const disabled = isBusy || Boolean(currentState?.error);
    const cliSwitchHint = currentState?.current?.cliUsesSharedLogin
      ? "新启动的 CLI 和桌面端共用此登录"
      : "供新启动的 CLI 使用";

    let actionButtons = "";
    if (canSwitch) {
      if (isCurrentAll || account.pendingDesktop) {
        actionButtons = `
          <button type="button" class="btn btn-ghost" data-action="reload-desktop" ${disabled ? "disabled" : ""}>
            ${account.pendingDesktop ? "应用桌面端" : "刷新窗口"}
          </button>
        `;
      } else {
        actionButtons = `
          <button type="button" class="btn btn-primary" data-action="switch-all" data-email="${escapeHtml(account.email)}" ${disabled ? "disabled" : ""}>
            切换
          </button>
          <button type="button" class="btn btn-ghost" data-action="switch-cli" data-email="${escapeHtml(account.email)}" title="${cliSwitchHint}" ${disabled ? "disabled" : ""}>
            仅 CLI
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
          <div class="account-tags"><span class="tag ${tierClass}">${escapeHtml(tierLabel)}</span></div>
          ${quotaIssue ? `<span class="account-issue">${escapeHtml(quotaIssue)}</span>` : ""}
        </div>
        ${renderQuotaGrid(account)}
        <div class="account-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }

  function renderAccountGroups(accounts) {
    const groups = [
      { label: "会员账号", matches: (a) => a.isEligible && (a.isPaid ?? a.isPro) },
      { label: "免费账号", matches: (a) => a.isEligible && !(a.isPaid ?? a.isPro) && a.isFree },
      { label: "套餐未知", matches: (a) => a.isEligible && !(a.isPaid ?? a.isPro) && !a.isFree },
      { label: "不可用账号", matches: (a) => !a.isEligible }
    ];
    return renderQuotaHeader() + groups.map((group) => {
      const rows = accounts.filter(group.matches);
      return rows.length ? `<section class="account-group" aria-label="${group.label}">
        <h2>${group.label}<span>${rows.length}</span></h2>
        ${rows.map(renderAccountRow).join("")}
      </section>` : "";
    }).join("");
  }

  function render(state) {
    if (!state) return;
    const hadStateError = Boolean(currentState?.error);
    currentState = state;
    const unavailable = isBusy || Boolean(state.error);
    if (state.error) showToast(state.error, false);
    else if (hadStateError) document.getElementById("toastBanner")?.classList.add("hidden");

    const cur = state.current || {};
    const onlyPro = Boolean(state.preferences?.onlyPro);

    const desktopNotice = document.getElementById("desktopNotice");
    desktopNotice?.classList.toggle("hidden", Boolean(state.error) || cur.desktopStatus !== "unknown");

    const btnTogglePro = document.getElementById("btnTogglePro");
    if (btnTogglePro) {
      btnTogglePro.classList.toggle("is-active", onlyPro);
      btnTogglePro.textContent = onlyPro ? "显示全部" : "隐藏非会员";
      btnTogglePro.disabled = unavailable;
    }

    const btnOrganize = document.getElementById("btnOrganize");
    if (btnOrganize) btnOrganize.disabled = unavailable;

    const btnRefresh = document.getElementById("btnRefresh");
    if (btnRefresh) btnRefresh.disabled = isBusy;

    const allAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    const visibleAccounts = allAccounts.filter((acc) => {
      if (acc.activeDesktop || acc.pendingDesktop || acc.activeCli || acc.activeMagpieFirst ||
          (cur.desktopStatus === "stopped" && acc.savedDesktop)) return true;
      if (!acc.isEligible) return false;
      if (onlyPro && !(acc.isPaid ?? acc.isPro)) return false;
      return true;
    });

    const inactiveAccounts = allAccounts.filter((a) => !a.isEligible && !visibleAccounts.includes(a));

    const listEl = document.getElementById("accountList");
    if (listEl) {
      if (visibleAccounts.length === 0) {
        listEl.innerHTML = `<div class="account-empty-state">${onlyPro ? "没有会员账号" : "没有可用账号"}</div>`;
      } else {
        listEl.innerHTML = renderAccountGroups(visibleAccounts);
      }
    }

    const inactiveEl = document.getElementById("unavailableAccounts");
    if (inactiveEl) {
      inactiveEl.hidden = inactiveAccounts.length === 0;
      document.getElementById("unavailableSummary").textContent = `不可用账号 · ${inactiveAccounts.length}`;
      document.getElementById("unavailableList").innerHTML = inactiveAccounts
        .map(renderAccountRow).join("");
    }

    const incomingSwitchId = state.lastSwitch?.cmdId || state.lastSwitch?.id || null;
    if (!state.error && incomingSwitchId && incomingSwitchId !== lastHandledSwitchId) {
      lastHandledSwitchId = incomingSwitchId;
      isBusy = false;
      showToast(state.lastSwitch.message, state.lastSwitch.ok !== false);
    }
  }

  async function pollStateScript() {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `state.js?t=${Date.now()}`;
      script.onload = () => {
        script.remove();
        if (globalThis.__AGY_SWITCH_STATE__) {
          render(globalThis.__AGY_SWITCH_STATE__);
        }
        resolve();
      };
      script.onerror = () => {
        script.remove();
        resolve();
      };
      document.body.appendChild(script);
    });
  }

  async function sendPluginCommand(cmdPayload) {
    const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fullCmd = { ...cmdPayload, id: cmdId, ts: Date.now() };

    isBusy = true;
    render(currentState);

    try {
      const bridge = await ensureMagpieBridge();
      if (typeof bridge?.options?.set === "function") {
        await bridge.options.set({ cmd: fullCmd });
      } else if (typeof bridge?.saveOptions === "function") {
        await bridge.saveOptions(PLUGIN_NAME, { cmd: fullCmd });
      } else {
        showToast("未检测到 Magpie 页面桥接，请通过 Magpie 侧边栏打开", false);
        isBusy = false;
        render(currentState);
        return;
      }

      for (let i = 0; i < 18; i++) {
        await new Promise((r) => setTimeout(r, 250));
        await pollStateScript();
        if (lastHandledSwitchId === cmdId) {
          isBusy = false;
          render(currentState);
          return;
        }
      }
    } catch (err) {
      showToast(`指令发送失败: ${err.message || err}`, false);
    } finally {
      isBusy = false;
      render(currentState);
    }
  }

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    if (target.closest("#btnTogglePro")) {
      const nextOnlyPro = !Boolean(currentState?.preferences?.onlyPro);
      sendPluginCommand({
        type: "set-preferences",
        preferences: { onlyPro: nextOnlyPro }
      });
      return;
    }

    if (target.closest("#btnOrganize")) {
      sendPluginCommand({
        type: "organize"
      });
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

  globalThis.__AGY_SWITCH_ON_STATE__ = (newState) => {
    render(newState);
  };

  if (currentState) {
    render(currentState);
  } else {
    pollStateScript().then(() => {
      if (!currentState) {
        sendPluginCommand({ type: "refresh" });
      }
    });
  }

  setInterval(() => {
    pollStateScript();
  }, 2500);
})();
