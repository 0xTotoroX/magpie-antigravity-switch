# src

> L2 | 父级：[项目地图](../AGENTS.md)

- `core.mjs`：兼容 `plugin:agy-cli`（主源）、`plugin:antigravity`、legacy `antigravity`、`plugin-auth.json` 与 `agyHome` 隔离令牌；通过 Magpie 的 `quota refresh agy-cli … --json` 分两路按账号读取原始套餐与额度并写入 `antigravity-switch-cli-cache.json`；逐账号写入读数，合并同一登录的并发查询，近期实读沿用原时间；页面首轮超时的账号在缓存中登记，向页面投影同一有效登录的补查状态，后台在宿主冷却后补查一次，结合 Magpie 配额缓存完成会员分类、桌面主程序运行状态与已保存的登录、严格配置读取、保留已有授权的钥匙串更新与失败恢复、带摘要清单的备份和账号命令。旧本地套餐及额度快照保留但不参与状态聚合。
- `page-service.mjs`：仅监听回环地址；静态界面使用资源白名单，状态读取与命令均需本次后台签发的凭证。将 CLI 按钮可见性和会员筛选保存在独立的本机界面偏好文件。
- `daemon.mjs`：独立包与社区包的指令解析、兼容旧版设置指令；账号写入命令串行执行；页面额度首轮独立调度，当前 CLI 优先、并发上限为二，重复刷新共享结果；文件监听（含 `plugin-auth.json` 与 `cli-cache`）、周期同步/后台按 TTL 刷新和源码签名热重载。macOS 内核文件锁保证单实例，PID 记录仅供诊断。完成队列中的命令后再重载，安装目录改变时交接给当前 Magpie 页面。状态读写失败不得造成后续同步永久停止。

macOS 本地 agy 1.5+ 的 CLI 启动身份来自共享钥匙串，状态通过 `cliUsesSharedLogin` 告知页面。旧 CLI 与 SSH 会话沿用登录文件。更新后回读目标账号。

核心将 Magpie agy-cli 供应商名单与额度投影到 `page/.runtime/state.js`，快照及其原子写入临时文件均避开 Magpie 的本地源码重载，按登录记录与凭据登记交叉核对，识别移除、停用与登录失效。刷新只查询已启用的供应商账号。agy-cli 读数缺少套餐名时可按邮箱从 Antigravity 登录记录取名，快照用 `planFromLoginRecord` 标记来源。页面骨架由 `page/index.html` 提供，账号渲染由 `page/app.js` 负责，不保留第二套 HTML 生成逻辑。

备份 `manifest.json` 逐项记录 SHA-256 或明确不存在；所有文件校验完成后才保存 `initialBackupPath`。切换 Magpie 首选时用与 Magpie 共用的 logins.json 文件锁，锁内重读账号列表并合并首选。旧备份保留，通过新清单的 `previousBackupPath` 回溯。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
