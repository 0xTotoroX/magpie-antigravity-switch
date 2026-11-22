/**
 * [INPUT]: Magpie 页面桥接与后台生成的私有连接信息。
 * [OUTPUT]: 打开本机或 Magpie 代理的 Switch 页面服务。
 * [POS]: 插件启动页；不发送账号操作。
 */
// Open the official Magpie page service. The URL fragment stays in this frame.
(async () => {
  const theme = await globalThis.magpie.ready;
  const english = theme.lang?.startsWith("en");
  const status = document.getElementById("status");
  status.textContent = english ? "Connecting to Antigravity Switch…" : "正在连接 Antigravity Switch…";
  let attempts = 0;
  const connect = () => {
    const script = document.createElement("script");
    script.src = ".runtime/connection.js?t=" + Date.now();
    script.onload = script.onerror = () => {
      script.remove();
      const conn = globalThis.agyConnection;
      if (conn?.key && Number.isInteger(conn.port)) {
        const url = new URL(globalThis.magpie.service || "http://127.0.0.1:" + conn.port + "/");
        url.hash = conn.key;
        location.replace(url.href);
      } else {
        if (conn?.unavailable) {
          status.textContent = english ? "The local Switch service cannot listen on port " + conn.port : "本机 Switch 服务无法监听端口 " + conn.port;
        } else if (++attempts === 6) status.textContent = english ? "Waiting for the local Switch service…" : "正在等待本机 Switch 服务…";
        setTimeout(connect, 1000);
      }
    };
    document.body.appendChild(script);
  };
  connect();
})();
