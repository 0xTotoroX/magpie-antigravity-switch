# test

> L2 | 父级：[项目地图](../AGENTS.md)

- `fixture.mjs`：生产模块的隔离 VM；文件操作只写内存，外部命令按白名单模拟。
- `core.test.mjs`：凭据保护、钥匙串授权边界、配置读取、备份、运行身份、Magpie 五窗口与周限制、本地历史套餐及额度不再参与的回归。
- `cli.test.mjs`：真实 Node 子进程中的帮助命令、软链接与只导入行为，不启动账号操作。
- `distribution.test.mjs`：v1 宿主入口、两种包名的页面指令与沙箱能力边界。
- `page.test.mjs`：模拟 DOM 中的待生效、五窗口固定排序、0% / 未知 / 待刷新、账号类型分组、不可用折叠与错误恢复显示。

使用 `npm test`；不要用真实用户目录或真实凭据替代 fixture。

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
