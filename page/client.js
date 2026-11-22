/**
 * [INPUT]: 启动页交付的临时凭证与 Magpie 父窗口的主题。
 * [OUTPUT]: 主题通知、账号状态读取与手动操作结果。
 * [POS]: 页面服务的浏览器客户端。
 */
// This document is served by the local daemon. Magpie still owns its parent frame.
(() => {
  const key = location.hash.slice(1);
  const listeners = new Set();
  const themeBridge = {
    onTheme(fn) { listeners.add(fn); }
  };
  addEventListener("message", ({ source, data }) => {
    if (source !== parent || data?.magpie !== 1) return;
    const theme = data.event === "theme" ? data.data : data.id === "agy-theme" ? data.result : null;
    if (!theme || typeof theme.dark !== "boolean") return;
    themeBridge.theme = theme;
    const root = document.documentElement;
    root.dataset.theme = theme.dark ? "dark" : "light";
    root.lang = theme.lang || "en";
    for (const [name, value] of Object.entries(theme.tokens || {})) root.style.setProperty("--magpie-" + name, value);
    for (const fn of listeners) fn(theme);
  });
  globalThis.magpie = themeBridge;
  parent.postMessage({ magpie: 1, id: "agy-theme", method: "hello" }, "*");

  async function request(route, cmd) {
    const headers = { Authorization: "Bearer " + key };
    if (cmd) headers["Content-Type"] = "application/json";
    const timeout = cmd?.type === "refresh" ? 180_000 : cmd ? 30_000 : 8000;
    const response = await fetch(route, {
      method: cmd ? "POST" : "GET", headers, body: cmd ? JSON.stringify(cmd) : undefined,
      signal: AbortSignal.timeout(timeout), credentials: "omit", redirect: "error", cache: "no-store"
    });
    if (response.status === 403) throw Error(globalThis.agySwitchI18n.text("reopen"));
    if (!response.ok) throw Error("Switch HTTP " + response.status);
    return response.json();
  }
  globalThis.agyPage = { state: () => request("state"), command: (cmd) => request("command", cmd) };
})();
