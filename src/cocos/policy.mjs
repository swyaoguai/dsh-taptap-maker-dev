/**
 * 注入给模型的 Cocos 守则（order 305，仅在 `cocos` MCP 服务已登记时出现）。
 *
 * 这段文字不解释「怎么装」，只讲三件事：
 *  1. 先去加载 `cocos-creator-mcp` skill —— 完整的操作流程与验收纪律在那边；
 *  2. 多项目并行时怎么不写错工程（工具签名拦不住「传错项目」）；
 *  3. 上游工具缺档时走 `cocos_exec` 兜底、别手改工程文件。
 *
 * 为什么必须点出 skill 名：只注入工具规则的话，模型会「有工具就直接用」，
 * 跳过 skill 里那套「保存 → 截图 → 看日志」的验收流程 —— 每个工具都调成功了，
 * 但场景改了没生效、或者改在了错误的对象上。
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
    'Cocos Creator（本机可能同时开着 2~3 个项目；工具命名空间统一是 `cocos`）：',
    '- 动手前先加载 `cocos-creator-mcp` skill：怎么选工具、改完怎么验收（保存 → 截图 → 看日志）都在里面；',
    '- 涉及场景/UI/玩法开发时，必须再加载 `cocos-scene-first-workflow`：先在编辑器里搭好节点树、挂组件、配好物理分组并保存验证，之后才规划代码；禁止用代码动态 new 节点拼 UI 或场景（运行期临时对象只能从 Prefab 实例化）；',
    '- 专题深入按需加载：`cocos-typescript-standards`（写组件）、`cocos-component-architecture`、`cocos-resource-prefabs`、`cocos-ui-layout`、`cocos-animation`、`cocos-physics`、`cocos-input`、`cocos-performance`、`cocos-audio`、`cocos-networking`、`cocos-build-release`、`cocos-editor-tooling`、`cocos-testing`、`cocos-project-structure`；完整对照见 `taptap-skill-router` 的「Cocos Creator 项目按需求加载」，一次只挑直接相关的 1~2 个，不要凭记忆写 3.x API；',
    '- 先 `cocos_projects` 看现状（slug / 路径 / 端口 / 是否在跑 / 构建槽位），再动手；',
    '- 需要项目的每个工具都必须带 `project`（slug、目录名或完整路径）。多个项目在跑时省略 `project` 会直接报错——工具不会替你猜是哪一个；',
    '- 同一项目同一时间只允许一个写操作（写锁），**构建期间该项目也被锁住**；构建全机串行。撞锁/排队时等它结束，不要换个项目「重试」；',
    '- 上游工具档位不够（常见：core 档没有 build/部分资源工具）时，用 `cocos_exec` 在 scene 或 editor 上下文跑 JS 达成，不要反复试不存在的工具；',
    '- 改完场景/预制体后要验证：保存场景 + 截图（`cocos_screenshot`）+ 看日志（`cocos_logs`），别只凭「调用成功」就宣布完成；',
    '- 不要绕过编辑器直接手改 `assets/` 里的场景与 `.meta`：编辑器开着时会被它覆盖回去。',
  ].join('\n')
}
