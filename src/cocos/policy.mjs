/**
 * 注入给模型的 Cocos 守则（order 305，仅在 `cocos` MCP 服务已登记时出现）。
 *
 * 这段文字不解释「怎么装」，只讲**多项目并行时怎么不写错工程**：
 * 这是纯靠工具签名拦不住的部分（签名能强制传参数，但拦不住「传错项目」）。
 *
 * @module src/cocos/policy.mjs
 */
import { mcpRowStatus } from './register.mjs'

/** 返回守则文本；没登记 MCP 服务时返回空串（调用方据此跳过注入）。 */
export function cocosPolicyText(dshHome) {
  let registered = false
  try {
    registered = mcpRowStatus({ dshHome }).registered
  } catch {
    return ''
  }
  if (!registered) return ''
  return [
    'Cocos Creator 集成（本机可能同时开着 2~3 个项目，工具命名空间统一是 `cocos`）：',
    '- 先 `cocos_projects` 看现状（slug / 路径 / 端口 / 是否在跑 / 构建槽位），再动手；',
    '- 需要项目的每个工具都必须带 `project`（slug、目录名或完整路径）。多个项目在跑时省略 `project` 会直接报错——工具不会替你猜是哪一个；',
    '- 同一项目同一时间只允许一个写操作（写锁），构建全机串行。撞锁/排队时等它结束，不要换个项目「重试」；',
    '- 上游工具档位不够（常见：core 档没有 build/部分资源工具）时，用 `cocos_exec` 在 scene 或 editor 上下文跑 JS 达成，不要反复试不存在的工具；',
    '- 改完场景/预制体后要验证：保存场景 + 截图（`cocos_screenshot`）+ 看日志（`cocos_logs`），别只凭「调用成功」就宣布完成。',
  ].join('\n')
}
