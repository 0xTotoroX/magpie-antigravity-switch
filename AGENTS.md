# magpie-antigravity-switch

产品显示名统一为「Antigravity Switch」，包名为 `magpie-antigravity-switch`，命令名为 `magpie-agy-switch`；社区仓库分发包名为 `@magpie-community/page-antigravity-switch`。

macOS 上的 Magpie 页面插件与 CLI，使用 JavaScript ES modules、Node.js/Bun 和原生 `security` 命令。

## 入口与目录

- `host.mjs`：Magpie v1 宿主入口，导入不启动服务；`server()` 才初始化状态与监听。
- `index.mjs`：Magpie 默认插件函数和 `magpie-agy-switch` CLI；导入模块不会执行 CLI。
- [src](src/AGENTS.md)：凭据、备份、账号状态、切换与后台监听。
- [page](page/AGENTS.md)：Magpie 沙箱中的经典脚本页面。
- [test](test/AGENTS.md)：使用假凭据、内存文件系统与子进程替身的回归测试。
- `package.json`：插件页面、CLI 入口、发布文件范围与 `npm test`。

## 数据与验证边界

- 真实凭据、备份与 `page/state.js` 不提交到 Git。写回账号配置前必须严格解析；只允许缺失文件使用默认值。
- 钥匙串更新不删除原条目，不使用 `-A`。已有条目保留访问权限，只在新建条目时设置有限的可信应用；不要每次切号重复提交 `-T`。需要 macOS 授权时遵循系统提示，不通过降低访问保护绕过。
- `current.desktopRuntimeEmail` 是已查询到的运行身份；`desktopSavedEmail` 是保存的凭据身份。`desktopPending` 不等于切换已完成，查询失败不猜测运行身份。
- 配额按池和窗口比较时间；同池的限制取最小剩余量。无套餐证据时保留未知，不自动纳管为 Pro。
- `npm test` 是隔离回归验证；真实账号切换与系统授权交互需另外说明实际验证范围。
- 源码可能由已安装插件直接使用，修改 `core.mjs` 或 `daemon.mjs` 会触发后台进程自动重载。先在隔离副本验证，再同步。
