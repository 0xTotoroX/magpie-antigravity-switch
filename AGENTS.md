# magpie-antigravity-switch

产品显示名统一为「Antigravity Switch」，包名为 `magpie-antigravity-switch`，命令名为 `magpie-agy-switch`；社区仓库分发包名为 `@magpie-community/page-antigravity-switch`。

macOS 上的 Magpie 页面插件与 CLI，使用 JavaScript ES modules、Node.js/Bun 和原生 `security` 命令。

## 入口与目录

- `host.mjs`：Magpie v1 宿主入口，导入不启动服务；`server()` 才初始化后台与 Magpie 页面服务。
- `index.mjs`：Magpie 默认插件函数和 `magpie-agy-switch` CLI；导入模块不会执行 CLI。
- [src](src/AGENTS.md)：凭据、备份、账号状态、切换与后台监听。
- [page](page/AGENTS.md)：Magpie 沙箱入口、回环服务页面与经典脚本。
- [test](test/AGENTS.md)：使用假凭据、内存文件系统与子进程替身的回归测试。
- `package.json`：插件页面、CLI 入口、发布文件范围与 `npm test`。
- [publish-npm.yml](.github/workflows/publish-npm.yml) 仅供手动验证 npm 授权或发布。用户审核发布说明及产物后，从正式 Release tag 触发发布，上传前核对 GitHub Release 附件的 SHA-256。

## 数据与验证边界

- 真实凭据、备份、`page/.runtime/` 与旧版 `page/state.js` 不提交到 Git。写回账号配置前必须严格解析；只允许缺失文件使用默认值。
- 钥匙串更新不删除原条目，不使用 `-A`。已有条目保留访问权限，只在新建条目时设置有限的可信应用；不要每次切号重复提交 `-T`。需要 macOS 授权时遵循系统提示，不通过降低访问保护绕过。
- 桌面运行状态按主程序的可执行文件名识别，保存的账号取自 `desktopSavedEmail`。无法检查进程时保留未知状态。快照为旧调用方保留 `desktopRuntimeEmail: null` 与 `desktopPending: false`。
- 套餐与配额通过 Magpie 的 `quota refresh agy-cli` 与本地配额缓存读取；不使用旧保险库的 `plan` / `liveQuota` 分类或补额度。旧资料保留。同池推荐分数取各有效窗口的最小剩余量，缺失与过期读数不补满。
- 页面按会员、免费与套餐未知分组，不可用账号默认折叠。额度从左到右展示 Gemini、按需出现的 Carbon 和 GPT / Claude；常规窗口为 5h、7d，Gemini 4 Carbon 仅展示有有效独立读数的窗口。Argon 旧数据不计入配额投影和推荐。缺失保留列位，视觉用「—」，辅助技术仍读为未知。页面简写已知套餐名并保留 Ultra 倍数，agy-cli 缺失套餐名时可按邮箱使用 Magpie 保存的 Antigravity 登录套餐；明确识别 Pro、Ultra 和 Enterprise，只有已识别免费套餐计入免费版。未知名称不自动纳管。`isPro`、`counts.pro` 和 `onlyPro` 为旧版本兼容字段，会员判断使用 `isPaid`。
- `npm test` 是隔离回归验证；真实账号切换与系统授权交互需另外说明实际验证范围。
- npm 包的根目录 `README.md` 使用英文，顶部链接到 `docs/README.zh-CN.md`，两份一同打包。安装命令、环境要求和用法写在各自的 README。
- GitHub Release 正文按 `## 中文`、`## English` 的顺序写同一组更新，安装说明放在 README。个人开发、本机版本和验收过程留在私有 Runbook。
- 源码可能由已安装插件直接使用，修改 `core.mjs` 或 `daemon.mjs` 会触发后台进程自动重载。先在隔离副本验证，再同步。
- 功能修复先更新本机实际使用的插件并检查 Magpie 页面生效，再考虑远端发布。保留插件标识、选项及登录账号；本地开发版用开发版本标识，不把源码 commit 当作已安装或已发布。
