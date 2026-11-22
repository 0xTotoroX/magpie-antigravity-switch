/**
 * [INPUT]: Magpie 的 v1 宿主初始化。
 * [OUTPUT]: 启动独立后台，提供本机状态与回环页面服务。
 * [POS]: 发布包的 Magpie 入口；CLI 仍通过 index.mjs 执行。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { AntigravitySwitchPlugin } from "./index.mjs";

export default {
  id: "antigravity-switch",
  async server() {
    return AntigravitySwitchPlugin();
  }
};
