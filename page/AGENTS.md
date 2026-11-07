# page

> L2 | 父级：[项目地图](../AGENTS.md)

- `index.html`：页面骨架和 Magpie bridge、经典脚本入口。
- `app.js`：按会员、免费与套餐未知分组，折叠不可用账号；固定显示 Magpie 的 GPT / Claude、Gemini 与 Argon 五个 5h / 7d 窗口、更新时间、未知与过期状态，保留原始档位及桥接指令。
- `style.css`：沿用 Magpie 主题变量；宽屏共用额度列位，窄屏按模型组重新排列，0% 空条与未知状态分开显示。
- `icon.svg`：侧边栏图标。
- `state.js`：运行时生成的无凭据状态文件，已被 Git 忽略，不手工编辑或发布个人快照。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
