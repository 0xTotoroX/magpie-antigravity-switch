/**
 * [INPUT]: state.js 的账号快照与 Magpie 页面桥接。
 * [OUTPUT]: 账号列表、待生效/未知/错误状态及用户操作指令。
 * [POS]: 经典脚本页面渲染器；不持有 OAuth 凭据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
(() => {
  const PLUGIN_NAME = "magpie-antigravity-switch";

  let currentState = globalThis.__AGY_SWITCH_STATE__ || null;
  let lastHandledSwitchId = currentState?.lastSwitch?.cmdId || currentState?.lastSwitch?.id || null;
  let isBusy = false;
  let showIneligibleTemp = false;

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

  function renderQuotaLine(account) {
    const pools = account.quota?.pools || [];
    if (pools.length === 0) {
      if (!account.isEligible) {
        return `<div class="quota-line"><span class="quota-pill">账号需验证或地区受限</span></div>`;
      }
      return `<div class="quota-line"><span class="quota-pill">配额未知</span></div>`;
    }

    const items = pools.slice(0, 4).map((p) => {
      if (p.stale) return `<span class="quota-pill">${escapeHtml(p.label)}：待刷新</span>`;
      const rem = Math.round(p.remaining);
      const cls = fillClass(rem);
      return `
        <span class="quota-pill">
          <span>${escapeHtml(p.label)}</span>
          <span class="quota-mini-bar"><span class="quota-mini-fill ${cls}" style="width:${Math.max(4, rem)}%"></span></span>
          <strong>${rem}%</strong>
        </span>
      `;
    });

    return `<div class="quota-line">${items.join("")}</div>`;
  }

  function renderAccountRow(account, recommendedEmail) {
    const isCurrentAll = account.activeDesktop && account.activeCli && account.savedDesktop;
    const isRecommended = account.email === recommendedEmail && !account.activeDesktop;

    const tierClass = !account.isEligible ? "tag-bad" : account.isPro ? "tag-pro" : "tag-free";
    const tags = [
      `<span class="tag ${tierClass}">${escapeHtml(account.tierLabel || (account.isPro ? "Pro 会员" : "免费版"))}</span>`
    ];

    if (isCurrentAll) {
      tags.push(`<span class="tag tag-active">当前使用中</span>`);
    } else {
      if (account.activeDesktop) tags.push(`<span class="tag tag-active">桌面端</span>`);
      if (account.activeCli) tags.push(`<span class="tag tag-active">CLI</span>`);
    }
    if (account.pendingDesktop) tags.push(`<span class="tag tag-active">桌面端待生效</span>`);

    if (isRecommended) {
      tags.push(`<span class="tag tag-pro">推荐</span>`);
    }

    const canSwitch = account.hasCredentials && account.isEligible;

    let actionButtons = "";
    if (canSwitch) {
      if (isCurrentAll || account.pendingDesktop) {
        actionButtons = `
          <button type="button" class="btn btn-ghost" data-action="reload-desktop" ${isBusy ? "disabled" : ""}>
            ${account.pendingDesktop ? "应用桌面端" : "刷新窗口"}
          </button>
        `;
      } else {
        actionButtons = `
          <button type="button" class="btn btn-primary" data-action="switch-all" data-email="${escapeHtml(account.email)}" ${isBusy ? "disabled" : ""}>
            切换
          </button>
          <button type="button" class="btn btn-ghost" data-action="switch-cli" data-email="${escapeHtml(account.email)}" title="仅切换 CLI，不打断桌面端窗口" ${isBusy ? "disabled" : ""}>
            仅 CLI
          </button>
        `;
      }
    } else {
      actionButtons = `<span class="subtitle">不可用</span>`;
    }

    return `
      <div class="account-row ${account.activeDesktop ? "is-current" : ""}">
        <div class="account-main">
          <div class="account-title-line">
            <span class="account-email">${escapeHtml(account.email)}</span>
            ${tags.join("")}
          </div>
          ${renderQuotaLine(account)}
        </div>
        <div class="account-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }

  function render(state) {
    if (!state) return;
    const hadStateError = Boolean(currentState?.error);
    currentState = state;
    const unavailable = isBusy || Boolean(state.error);
    if (state.error) showToast(state.error, false);
    else if (hadStateError) document.getElementById("toastBanner")?.classList.add("hidden");

    const cur = state.current || {};
    const counts = state.counts || { pro: 0, free: 0, ineligible: 0 };
    const onlyPro = Boolean(state.preferences?.onlyPro);

    const subtitleEl = document.getElementById("subtitleText");
    if (subtitleEl) {
      subtitleEl.textContent = `Pro 会员 ${counts.pro} 个 · 免费版 ${counts.free} 个${counts.unknown ? ` · 套餐未知 ${counts.unknown} 个` : ""}${onlyPro ? "（当前仅显示 Pro 会员）" : ""}`;
    }

    const btnTogglePro = document.getElementById("btnTogglePro");
    if (btnTogglePro) {
      btnTogglePro.classList.toggle("is-active", onlyPro);
      btnTogglePro.textContent = onlyPro ? "已隐藏非会员" : "隐藏非会员";
      btnTogglePro.disabled = unavailable;
    }

    const btnOrganize = document.getElementById("btnOrganize");
    if (btnOrganize) btnOrganize.disabled = unavailable;

    const btnRefresh = document.getElementById("btnRefresh");
    if (btnRefresh) btnRefresh.disabled = isBusy;

    const desktopEmailEl = document.getElementById("curDesktopEmail");
    if (desktopEmailEl) {
      const account = cur.desktopEmail || (cur.desktopRunning ? "账号待确认" : "未登录");
      desktopEmailEl.textContent = cur.desktopPending
        ? `${account} → ${cur.desktopSavedEmail}（待生效）`
        : `${account}${cur.desktopStatus === "stopped" && cur.desktopSavedEmail ? "（已保存，未运行）" : ""}`;
      desktopEmailEl.title = desktopEmailEl.textContent;
    }

    const desktopDotEl = document.getElementById("curDesktopDot");
    if (desktopDotEl) {
      desktopDotEl.className = `status-dot ${cur.desktopRunning ? "is-online" : ""}`;
      desktopDotEl.title = cur.desktopRunning ? "Antigravity 桌面端运行中" : "Antigravity 桌面端未运行";
    }

    const cliEmailEl = document.getElementById("curCliEmail");
    if (cliEmailEl) cliEmailEl.textContent = cur.cliEmail || "未登录";

    const magpieEmailEl = document.getElementById("curMagpieEmail");
    if (magpieEmailEl) magpieEmailEl.textContent = cur.magpieFirstEmail || "未设置";

    const allAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    const visibleAccounts = allAccounts.filter((acc) => {
      if (acc.activeDesktop || acc.pendingDesktop) return true;
      if (!acc.isEligible && !showIneligibleTemp) return false;
      if (onlyPro && !acc.isPro) return false;
      return true;
    });

    const hiddenCount = allAccounts.length - visibleAccounts.length;

    const listEl = document.getElementById("accountList");
    if (listEl) {
      if (visibleAccounts.length === 0) {
        listEl.innerHTML = `<div class="account-empty-state">未发现可用账号或已按筛选规则全部隐藏</div>`;
      } else {
        listEl.innerHTML = visibleAccounts
          .map((acc) => renderAccountRow(acc, state.recommendedEmail))
          .join("");
      }
    }

    const footerEl = document.getElementById("hiddenFooter");
    if (footerEl) {
      if (hiddenCount > 0) {
        footerEl.classList.remove("hidden");
        footerEl.innerHTML = `已隐藏 ${hiddenCount} 个非会员或异常账号 · <button type="button" class="link-btn" id="btnShowHidden">显示全部</button>`;
      } else if (showIneligibleTemp && counts.ineligible > 0) {
        footerEl.classList.remove("hidden");
        footerEl.innerHTML = `<button type="button" class="link-btn" id="btnHideIneligible">收起异常账号</button>`;
      } else {
        footerEl.classList.add("hidden");
        footerEl.innerHTML = "";
      }
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
      showIneligibleTemp = false;
      sendPluginCommand({
        type: "set-preferences",
        preferences: { onlyPro: nextOnlyPro }
      });
      return;
    }

    if (target.closest("#btnOrganize")) {
      showIneligibleTemp = false;
      sendPluginCommand({
        type: "organize"
      });
      return;
    }

    if (target.closest("#btnRefresh")) {
      sendPluginCommand({ type: "refresh" });
      return;
    }

    if (target.closest("#btnShowHidden")) {
      showIneligibleTemp = true;
      sendPluginCommand({
        type: "set-preferences",
        preferences: { onlyPro: false }
      });
      return;
    }

    if (target.closest("#btnHideIneligible")) {
      showIneligibleTemp = false;
      render(currentState);
      return;
    }

    const actionBtn = target.closest("[data-action]");
    if (!actionBtn) return;

    const action = actionBtn.getAttribute("data-action");
    const email = actionBtn.getAttribute("data-email");

    if (action === "switch-all" && email) {
      showIneligibleTemp = false;
      sendPluginCommand({
        type: "switch",
        email,
        target: "all",
        reloadDesktop: true,
        syncMagpie: true
      });
    } else if (action === "switch-cli" && email) {
      showIneligibleTemp = false;
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
