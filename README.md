# Antigravity Switch

[English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://apple.com/macos)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 Magpie 中管理本机已有的 Antigravity 账号，查看桌面端、`agy` CLI 和 Magpie 网关的登录状态与模型配额。

## 0.2.2 更新

- 添加账号等待授权码时，可以继续刷新额度或切换已有账号。
- 额度刷新失败时保留上次有效读数，并标出更新时间。
- agy-cli 未返回套餐名称时，按同一账号显示登录记录里的上次套餐。
- 修正深色模式的白底、提示与按钮对比度，减轻刷新按钮阴影，简化「支持 ☆」入口。

## 功能

- 界面跟随 Magpie 语言，提供中文和英文。
- 切换桌面端和 CLI 账号，并按需同步 Magpie 的首选账号。macOS 上本地 agy 1.5+ 的「仅 CLI」会更新新启动的 CLI 与桌面端共用的钥匙串登录。已打开的 CodexHost 会话需重新连接后读取新账号。
- 显示桌面端已保存的登录。从钥匙串确认保存后，账号行持续显示勾号；点击可查看说明。
- 页面同步 Magpie 的 agy-cli 供应商账号，邮箱旁标明 CLI 登录和 Magpie 首选。
- 从左到右展示 Gemini、GPT / Claude 的 5h 与 7d 额度。窄屏使用圆盘和短时间。仅在返回有效独立读数时显示 Gemini 4 Carbon。缺失显示「—」，过期显示「待刷新」。
- 已知套餐简写为 Pro、Ultra、Enterprise 或 Starter。
- 保留接口提供的 Ultra 倍数；未知档位不当作免费套餐。
- 操作前创建并校验本地凭据备份；配置损坏时保留原文件。
- 保留已有钥匙串访问权限，按系统提示完成授权。

## 安装

需要 macOS、Magpie 0.1.2670+，以及已登录的 Antigravity 桌面端或 `agy` CLI。

从 npm 安装：

```sh
magpie plugin add npm:magpie-antigravity-switch@0.2.3
```

也可以从 GitHub 安装：

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.2.3
```

也可以在 Magpie 的「插件 → 发现 → 非官方插件 · GitHub」中筛选 **Antigravity Switch**。安装后从侧边栏打开同名页面。

## 终端用法

独立 CLI 需要 Node.js 24+：

```sh
npm install --global magpie-antigravity-switch@0.2.2
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

添加账号时，可以在 Switch 页面刷新额度或切换已有账号，授权完成后继续回填。

页面的「刷新」同步 Magpie 的 agy-cli 供应商名单，并查询启用账号的套餐与额度。优先查询当前 CLI 账号，每个账号查完就更新该行。刷新期间可以切号，查询超时或暂时无法续期登录的账号由后台补查。失败提示可以点开查看受影响账号和上次读数时间。重置倒计时使用 `6h32min`、`32min`、`6d4h` 等格式。

工具栏的 CLI 开关控制账号旁的 CLI 标签和「仅 CLI」按钮。首次打开时两者收起，插件会记住之后的选择。账号数旁的「仅会员」只显示可用的会员账号。停用账号归入「不可用账号」，未返回的额度显示为横线，过期读数显示「待刷新」。

套餐优先取自 agy-cli。缺少套餐名时，插件按邮箱读取 Magpie 中保存的 Antigravity 登录记录。查看其他账号的记录无需切换登录。账号升级后若仍显示旧 Starter 标签，请参见 [Magpie 套餐刷新问题 #5621](https://github.com/yetone/magpie/issues/5621)；本插件不会自行推断或修改订阅档位。

账号凭据和备份保存在本机，不随插件发布。macOS 可能要求访问钥匙串；拒绝授权时操作停止。请只在自己有权使用的账号之间切换。

## License

[MIT](LICENSE)
