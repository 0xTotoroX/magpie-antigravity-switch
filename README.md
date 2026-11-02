# Antigravity Switch

[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://apple.com/macos)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 Magpie 中管理本机已有的 Antigravity 账号，查看桌面端、`agy` CLI 和 Magpie 网关的登录状态与模型配额。

## 功能

- 切换桌面端和 CLI 账号，并按需同步 Magpie 的首选账号。
- 区分实际运行账号与已保存、待生效的账号。
- 查看接口返回的套餐及各配额窗口；过期和未知读数明确显示。
- 按接口原名显示 Pro、Ultra、Enterprise 档位，并按会员状态筛选、整理账号。
- 保留接口提供的 Ultra 倍数；未知档位不当作免费套餐。
- 操作前创建并校验本地凭据备份；配置损坏时保留原文件。
- 保留已有钥匙串访问权限，按系统提示完成授权。

## 安装

需要 macOS、Magpie 0.1.2670+，以及已登录的 Antigravity 桌面端或 `agy` CLI。

从 npm 安装：

```sh
magpie plugin add npm:magpie-antigravity-switch@0.1.3
```

也可以从 GitHub 安装：

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.1.3
```

也可以在 Magpie 的「插件 → 发现 → 非官方插件 · GitHub」中筛选 **Antigravity Switch**。安装后从侧边栏打开同名页面。

## 终端用法

独立 CLI 需要 Node.js 24+：

```sh
npm install --global magpie-antigravity-switch@0.1.3
magpie-agy-switch status
```

在源码目录中也可以使用 `node index.mjs`：

```sh
# 查看账号状态与配额
node index.mjs status

# 切换到推荐账号
node index.mjs switch best

# 切换到指定账号
node index.mjs switch user@example.com

# 仅切换 CLI
node index.mjs switch user@example.com --target=cli

# 整理账号
node index.mjs organize

# 仅显示已识别会员
node index.mjs members-only on
```

## 数据与权限

账号凭据和备份保存在本机，不随插件发布。macOS 可能要求访问钥匙串；拒绝授权时操作停止。请只在自己有权使用的账号之间切换。

## License

[MIT](LICENSE)
