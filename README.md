# magpie-antigravity-switch

[![GitHub Topic](https://img.shields.io/badge/topic-magpie--plugin-blue)](https://github.com/topics/magpie-plugin)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://apple.com/macos)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 **Magpie** 侧边栏可视化切换 **Antigravity 桌面端 (`Antigravity.app`)**、**命令行 (`agy` CLI)** 与 **Magpie 网关** 的登录账号，并展示已查询到的订阅等级与模型配额池（Claude & GPT 5h/7d、Gemini 4 Argon 7d、Gemini 5h）。

---

## 核心特性

1. **三端状态联动与一键切换**：
   - **桌面端 (`Antigravity.app`)**：更新 macOS Keychain（`service="gemini"`, `account="antigravity"`）及客户端配置；页面分别显示运行账号和保存后待生效的账号。
   - **命令行 (`agy` CLI)**：同步更新 `~/.gemini/antigravity-cli/antigravity-oauth-token` 与 `jetski-standalone-oauth-token`。
   - **Magpie 网关首选**：可选同步更新 `logins.json` 中的 `first: true` 标记，使网关与桌面端/CLI 保持统一。
2. **多池实时配额看板**：
   - 当前运行账号的额度来自本地 `language_server`，其他账号使用 Magpie 或本地保险库中的最近读数；按池和窗口合并，保留未被新读数覆盖的周额度限制。
   - 推荐评分使用同一池各窗口的最小剩余额度；过期读数显示「待刷新」，未知额度不当作满额。
3. **账号整理与一键隐藏非会员**：
   - **隐藏非会员**：一键收起免费版与受限账号，界面只保留 Pro 会员。
   - **整理账号**：自动纳管已识别为 Pro 的本地账号、停用缺少资格信息的账号并将会员置顶排序。套餐未知的账号保持未知，不自动纳管为会员。
4. **桌面端平滑重载（防黑屏）**：
   - 切换账号时，通过 CDP 注入平滑过渡遮罩，向后台 `language_server` 发送安全重启信号，并轮询新端口 HTTP 200 就绪，防止 Electron 触发连接失败与 60 秒 3 次崩溃熔断。
5. **本地凭据保险库与客户端账号保护**：
   - 首次运行自动将当前客户端凭据备份至 `~/Documents/Backups-archive/antigravity/`（权限 `0700`/`0600`），用清单和 SHA-256 校验完整性；旧备份保留。
   - 客户端内独立登录的新账号自动纳入本地保险库。读取、备份或配置解析失败时停止替换，不以空配置覆盖原件。
   - 钥匙串使用原位更新，不删除旧条目或开放给所有应用；部分更新失败时恢复旧凭据。macOS 可能要求访问授权；拒绝授权会中止操作。

---

## 安装方法

### 方式 1：通过 Magpie 图形界面安装
1. 打开 `Magpie.app`，点击左侧菜单栏的「**插件**」。
2. 在搜索框或添加输入框中输入：
   ```text
   github:your-username/magpie-antigravity-switch
   ```
3. 点击安装，完成后左侧边栏即刻出现「**Antigravity 切号**」页面。

### 方式 2：通过 Magpie 终端命令安装
```bash
magpie plugin add github:your-username/magpie-antigravity-switch
```

---

## 终端 CLI 用法

本插件同时内置了独立的命令行工具，支持在终端无界面快速调用：

```bash
# 查看当前三端账号状态与配额
magpie-agy-switch status

# 自动切换到配额最充裕的账号并重载桌面端
magpie-agy-switch switch best

# 切换到指定账号（同时切换桌面端、CLI 与 Magpie）
magpie-agy-switch switch user@example.com

# 仅切换 CLI 账号（不打扰桌面端窗口）
magpie-agy-switch switch user@example.com --target=cli

# 整理账号（置顶 Pro 会员并收起失效账号）
magpie-agy-switch organize

# 仅显示 Pro 会员（开启/关闭）
magpie-agy-switch pro-only on
```

---

## 系统要求

- **操作系统**：macOS 12+ (Apple Silicon / Intel)
- **环境依赖**：[Magpie](https://github.com/yetone/magpie) 0.1.2500+，[Antigravity](https://antigravity.google) 桌面端 / `agy` CLI

## 开发验证

在源码目录执行 `npm test`。测试使用内存文件系统、假凭据和模拟外部命令；CLI 测试实际启动 Node.js 检查帮助与软链接入口，不读写真实账号。生产状态读取失败时，页面会显示错误，修复配置后可重新同步。

钥匙串更新的系统授权提示、实际客户端切号和重启效果需要单独实测，隔离测试不能替代这些验收。代码结构与数据约定见 [AGENTS.md](AGENTS.md)。

---

## License

[MIT](LICENSE)
