# test

> L2 | 父级：[项目地图](../AGENTS.md)

- `fixture.mjs`：生产模块的隔离 VM；文件操作只写内存，外部命令按白名单模拟。
- `core.test.mjs`：凭据保护、钥匙串授权边界、配置读取、`plugin-auth.json` 与 `agy-cli` 多账号隔离目录、`refreshCliAccounts`（模拟 Magpie 额度命令，覆盖逐行写入、去重及后台补查）、备份、桌面主程序识别与已保存的登录、五窗口与周限制、本地历史套餐及额度不再参与的回归。
- `cli.test.mjs`：真实 Node 子进程中的帮助命令、软链接与只导入行为，不启动账号操作。
- `daemon.test.mjs`：临时安装与假账号存储下验证 macOS 文件锁、PID 复用、并发启动、刷新期间切号与多窗口刷新回执、命令完成后重载及安装目录交接。
- `distribution.test.mjs`：v1 宿主入口、两种包名的页面指令、沙箱能力边界与额度快照在源码监听范围外的读写。
- `page-service.test.mjs`：验证回环服务、私有启动凭证、状态投影及两种按钮命令。
- `page.test.mjs`：模拟 DOM 中的未确认桌面账号与旧快照兼容、五窗口固定排序、0% / 未知 / 待刷新、账号类型分组、不可用折叠、错误恢复与 Magpie 中英文切换。

使用 `npm test`；不要用真实用户目录或真实凭据替代 fixture。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
