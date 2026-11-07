# Changelog

## Unreleased

- 套餐与额度统一读取 Magpie，本地只确认当前登录账号，旧本地额度快照不再覆盖周期读数。
- 固定 GPT / Claude、Gemini 的 5h / 7d 与 Gemini 4 Argon 的 7d 列位，补全 Gemini 周额度并显示更新时间。
- 按账号类型分组并默认折叠不可用账号；缺失、过期及真实 0% 分别显示，修复进度条填充。

## 0.1.3

- 保留接口返回的 Pro、Ultra、Enterprise 原始档位名称，不再统一标记为 Pro。
- 会员筛选和账号整理覆盖已识别会员，未知套餐不计入免费版。
- CLI 增加 members-only 名称，兼容原 pro-only 命令。
- 精简公开文档，保留功能、安装和使用说明。

## 0.1.2

- 首次公开发布 Antigravity Switch：查看并切换本机 Antigravity 桌面端、CLI 与 Magpie 账号。
- 提供运行身份、待生效状态、配额窗口和未知套餐的明确显示。
- 增加校验备份、严格配置读取与钥匙串失败恢复；已有凭据更新保留访问权限。
- 提供 Magpie v1 宿主入口，并兼容独立包与社区分发包的页面指令。
