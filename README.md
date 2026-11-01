# magpie-antigravity-switch

[![GitHub Topic](https://img.shields.io/badge/topic-magpie--plugin-blue)](https://github.com/topics/magpie-plugin)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://apple.com/macos)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 **Magpie** 侧边栏可视化切换 **Antigravity 桌面端 (`Antigravity.app`)**、**命令行 (`agy` CLI)** 与 **Magpie 网关** 的登录账号，并实时展示各账号的订阅等级与模型配额池（Claude & GPT 5h/7d、Gemini 4 Argon 7d、Gemini 5h）。

---

## 核心特性

1. **三端状态联动与一键切换**：
   - **桌面端 (`Antigravity.app`)**：安全读写 macOS Keychain（`service="gemini"`, `account="antigravity"`）及客户端配置，保证客户端重启与持久登录一致。
   - **命令行 (`agy` CLI)**：同步更新 `~/.gemini/antigravity-cli/antigravity-oauth-token` 与 `jetski-standalone-oauth-token`。
   - **Magpie 网关首选**：可选同步更新 `logins.json` 中的 `first: true` 标记，使网关与桌面端/CLI 保持统一。
2. **多池实时配额看板**：
   - 直接读取本地运行中的 `language_server` 与套餐配置，实时展现每个账号的 Claude、Argon、Gemini 剩余额度百分比及重置倒计时。
   - 自动推荐当前配额最充裕的账号。
3. **账号整理与一键隐藏非会员**：
   - **隐藏非会员**：一键收起免费版与受限账号，界面只保留 Pro 会员。
   - **整理账号**：自动纳管本地 Pro 账号、停用受限/过期账号并将会员置顶排序。
4. **桌面端平滑重载（防黑屏）**：
   - 切换账号时，通过 CDP 注入平滑过渡遮罩，向后台 `language_server` 发送安全重启信号，并轮询新端口 HTTP 200 就绪，防止 Electron 触发连接失败与 60 秒 3 次崩溃熔断。
5. **本地凭据保险库与客户端账号保护**：
   - 首次运行自动将当前客户端凭据备份至 `~/Documents/Backups-archive/antigravity/`（权限 `0700`/`0600`）。
   - 客户端内独立登录的新账号自动被捕获并纳入本地保险库，切换其他账号绝不丢失。

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

---

## License

[MIT](LICENSE)
