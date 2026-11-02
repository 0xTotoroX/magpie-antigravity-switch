# src

> L2 | 父级：[项目地图](../AGENTS.md)

- `core.mjs`：状态聚合、严格配置读取、保留已有授权的钥匙串更新与失败恢复、带摘要清单的备份、按窗口合并配额和账号命令。保留已有大型桌面恢复逻辑，本轮不拆分其行为。
- `daemon.mjs`：插件指令去重、文件监听、周期同步和源码签名热重载。状态读写失败不得造成后续同步永久停止。

核心只生成 `page/state.js` 状态数据；页面骨架由 `page/index.html` 提供，账号渲染由 `page/app.js` 负责，不保留第二套 HTML 生成逻辑。

备份 `manifest.json` 逐项记录 SHA-256 或明确不存在；所有文件校验完成后才保存 `initialBackupPath`。旧备份保留，通过新清单的 `previousBackupPath` 回溯。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
