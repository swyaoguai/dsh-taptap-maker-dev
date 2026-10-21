/**
 * 防呆护栏：把「会被能力不足的 agent 搞坏」的地方挡在命令层。
 *
 * 为什么需要这一层：注入的守则（system prompt）只是**建议**，弱模型不一定照做；
 * 而这套插件里不少动作是不可逆的 —— 覆盖掉已经花钱生成的视频、清空用户攒了
 * 很久的禁用表、把用户在设置页里精心选好的模型改掉。凡是这类动作，
 * 都不能只靠「守则里写了不要做」，必须在代码里**硬拦**。
 *
 * 两条规则：
 *
 * 1. **破坏性动作需要显式授权**：调用方必须传 `--yes`（或用户原话里明确说了要
 *    做），否则返回一段「需要你确认」的提示并停下 —— 不是执行，也不是默默跳过。
 *    宁可多问一次，也不要替用户毁掉东西。
 *
 * 2. **用户已定好的配置，AI 不得自行更改**：模型、通道顺序、通道开关、素材目录
 *    这些是用户在设置页里亲手选的。改了要么问用户，要么明确说明并征得同意。
 *
 * 本模块**不做任何 IO 决策**，只负责判定「这件事能不能自己做」。
 *
 * @module src/guards.mjs
 */

/**
 * 从命令原文里提取显式授权。
 *
 * ⚠️ 中文口语里的「确认」很可能是**别的意思**：「/taptap-video prompt 确认一下
 * 角色朝向」里的「确认」是提示词的一部分，绝不能当成用户授权了破坏性操作。
 * 所以只有当它**单独成句**（前面是行首或标点、后面是句尾或标点）时才算数。
 */
export function hasApproval(rawInput) {
  const s = String(rawInput ?? '')
  if (/(^|\s)(--yes|--force|-y)(\s|$)/i.test(s)) return true
  // 「确认」「确定」等必须是独立的一句，不能是提示词里的一个词。
  return /(^|[，。！？；、\n])\s*(确认|确定|就这样|执行吧|可以删|可以清|同意)\s*($|[，。！？；\n])/.test(s)
}

/**
 * 破坏性动作的统一入口。
 *
 * @param {object} p
 * @param {string} p.rawInput      原始命令文本（用来判断用户是否已授权）
 * @param {string} p.action        动作名，如 '清空 skill 禁用表'
 * @param {string} p.consequence   做了之后会发生什么（写给用户看）
 * @param {string} p.undo           怎么撤销（如「有备份，/taptap-skills restore」）
 * @returns {{ok: true} | {ok: false, text: string}}
 */
export function requireApproval({ rawInput, action, consequence, undo }) {
  if (hasApproval(rawInput)) return { ok: true }
  return {
    ok: false,
    text: [
      `⚠️ 这一步会${action}，而且**没法简单撤销**：`,
      `  ${consequence}`,
      undo ? `  想恢复：${undo}` : '',
      '',
      '这一步我不会替你做。确认要继续的话，请你自己说一声，或者在命令后加 `--yes`。',
    ].filter(Boolean).join('\n'),
  }
}

/**
 * 用户已选定的配置项清单。
 *
 * 列表里的都是「用户在设置页亲手挑过」的东西：换掉它们等于替用户重新做决定。
 * 通道开关和顺序尤其危险 —— 用户可能特意排了「先中转站后官方」，AI 一手拨乱
 * 就会让下一次调用走到**用户不想走的、要花钱的那条通道**。
 */
export const USER_OWNED_SETTINGS = {
  model: '视频模型',
  'lanes.order': '通道使用顺序',
  'lanes.enabled': '通道开关',
  'lanes.autoFallback': '额度不足自动换通道',
  'image.downloadDir': '图片保存目录',
  'video.downloadDir': '视频保存目录',
  'bgm.downloadDir': 'BGM 保存目录',
}

/**
 * 改这些配置前必须问用户。
 *
 * @param {string} key 形如 'model' / 'lanes.order'
 * @param {object} opts { rawInput, from, to } from/to 用于把「改了什么」讲清楚
 * @returns {{ok: true} | {ok: false, text: string}}
 */
export function guardUserSetting(key, { rawInput, from, to } = {}) {
  const label = USER_OWNED_SETTINGS[key]
  if (!label) return { ok: true } // 不在受保护清单里，放行
  if (hasApproval(rawInput)) return { ok: true }
  const fromText = from === undefined || from === '' ? '（空）' : String(from)
  const toText = to === undefined || to === '' ? '（空）' : String(to)
  return {
    ok: false,
    text: [
      `⚠️ ${label}是你自己在设置里定好的，我不替你改。`,
      `  现在：${fromText}`,
      `  想改成：${toText}`,
      '',
      '确实要改的话，你来说一声，或者在命令后加 `--yes`。',
      `（${label}是用户决策，不是能由我顺手优化的默认值）`,
    ].join('\n'),
  }
}

/**
 * 给 agent 看的固定清单：这些命令**永远不要**自己主动执行。
 *
 * 注入进 system prompt 比散落在各处更好维护，也让「守则」和「代码」能对照检查 ——
 * 凡是这里列出的，代码里都必须有对应的护栏。
 */
export const AGENT_DO_NOT_SELF_RUN = [
  '`/taptap-video run`（花钱，按秒计费）—— 必须用户明确要求才提交',
  '`/taptap-video set --model …`（改用户选定的模型）',
  '`/taptap-video lanes --order/--on/--off/--fallback`（改通道顺序与开关）',
  '`/taptap-video use <mp4>`（会覆盖已生成的视频）',
  '`/taptap-skills reset` / `disable`（改用户的 skill 禁用表）',
  '任何会删除文件的操作',
  '任何会覆盖已有素材 / 作业的操作',
]

/** 守则文本片段（注入 system prompt）。 */
export function guardrailLines() {
  return [
    '**🛡️ 防呆红线（宁可多问一次，也不要替用户做主）**：',
    '以下动作我**必须先问用户**、拿到明确同意才能执行，绝不自行触发，也绝不"顺手"做：',
    ...AGENT_DO_NOT_SELF_RUN.map((x) => `- ${x}`),
    '命令层面已加硬拦截：不带 `--yes` 就会停下来并把「会发生什么」讲清楚，'
      + '等用户自己决定。请不要试图绕过它（不要反复重试、不要换个说法绕过）。',
    '如果你认为当前配置不合理，**说出来即可**，由用户决定改不改；不要替他改。',
  ]
}