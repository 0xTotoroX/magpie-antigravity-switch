/**
 * [INPUT]: 页面目录、Magpie 插件声明的本机端口、已脱敏的页面状态和串行指令处理器。
 * [OUTPUT]: 仅回环可达的页面服务和本机界面偏好；凭证只随 Magpie 的私有启动页交付。
 * [POS]: 守护进程内的页面传输层，不读取账号凭据或修改插件设置。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";

const assets = new Map([
  ["/", ["view.html", "text/html"]], ["/app.js", ["app.js", "text/javascript"]],
  ["/client.js", ["client.js", "text/javascript"]], ["/i18n.js", ["i18n.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]]
]);

function pageCommand(input) {
  if (!input || typeof input.id !== "string" || !/^cmd-[\w-]{1,80}$/.test(input.id)) return null;
  const cmd = { id: input.id, type: input.type, language: input.language === "en" ? "en" : "zh", ts: Date.now() };
  if (["refresh", "open-github", "reload-desktop"].includes(cmd.type)) return cmd;
  if (cmd.type === "set-cli-visibility") {
    return typeof input.hidden === "boolean" ? { ...cmd, hidden: input.hidden } : null;
  }
  if (cmd.type !== "switch" || !["all", "cli"].includes(input.target) ||
      typeof input.email !== "string" || !input.email || input.email.length > 320) return null;
  return { ...cmd, email: input.email, target: input.target, reloadDesktop: input.target === "all", syncMagpie: true };
}

export function startPageService({ pageDir, preferenceFile, port, getState, submit }) {
  const runtime = path.join(pageDir, ".runtime");
  const ready = path.join(runtime, "connection.js");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  let hideCliAction = true;
  try {
    hideCliAction = JSON.parse(fs.readFileSync(preferenceFile, "utf8"))?.hideCliAction !== false;
  } catch {
    // 首次打开或偏好无法读取时默认收起。
  }
  const withPreference = state => state && { ...state, hideCliAction };
  const publish = (connection) => {
    const temp = ready + ".tmp-" + process.pid;
    fs.writeFileSync(temp, "globalThis.agyConnection = " + JSON.stringify(connection) + ";\n", { mode: 0o600 });
    fs.renameSync(temp, ready);
  };
  // Never put the page key in a request URL or serve it as a service asset.
  const server = http.createServer(async (req, res) => {
    const local = "127.0.0.1:" + server.address().port;
    const { origin, host } = req.headers;
    const send = (status, body = "") => { res.statusCode = status; res.end(body); };
    if (host !== local || (origin && origin !== "null" && origin !== "http://" + local)) return send(403);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const own = "http://" + local;
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' " + own +
      "; style-src 'self' " + own + " 'unsafe-inline'; connect-src 'self' " + own + "; base-uri 'none'; form-action 'none'");
    const route = req.url.split("?")[0];
    try {
      const asset = assets.get(route);
      if (asset && req.method === "GET") {
        res.setHeader("Content-Type", asset[1] + "; charset=utf-8");
        return send(200, fs.readFileSync(path.join(pageDir, asset[0])));
      }
      if (route !== "/state" && route !== "/command") return send(404);
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        return send(204);
      }
      if (req.headers.authorization !== "Bearer " + key) return send(403);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (route === "/state" && req.method === "GET") return send(200, JSON.stringify(withPreference(getState())));
      if (route !== "/command" || req.method !== "POST") return send(405);
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") return send(415);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return send(413);
        chunks.push(chunk);
      }
      let cmd;
      try { cmd = pageCommand(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* malformed request */ }
      if (!cmd) return send(400);
      if (cmd.type === "set-cli-visibility") {
        const temp = preferenceFile + ".tmp-" + process.pid;
        try {
          fs.writeFileSync(temp, JSON.stringify({ hideCliAction: cmd.hidden }) + "\n", { mode: 0o600 });
          fs.renameSync(temp, preferenceFile);
        } finally {
          fs.rmSync(temp, { force: true });
        }
        hideCliAction = cmd.hidden;
        return send(200, JSON.stringify({ hideCliAction }));
      }
      const state = await submit(cmd);
      return send(200, JSON.stringify(withPreference(state)));
    } catch {
      return send(500);
    }
  });
  let retry;
  let stopped = false;
  server.on("error", () => {
    if (stopped) return;
    publish({ unavailable: true, port });
    retry = setTimeout(() => server.listen(port, "127.0.0.1"), 2000);
  });
  server.on("listening", () => publish({ port: server.address().port, key }));
  server.listen(port, "127.0.0.1");
  return () => {
    stopped = true;
    clearTimeout(retry);
    publish(null);
    server.close();
    server.closeIdleConnections?.();
  };
}
