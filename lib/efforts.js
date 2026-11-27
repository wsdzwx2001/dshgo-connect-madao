// 思考档位：由内置规则表决定每个模型给哪些档位，不依赖运行时"学习"和人工重置。
//
// 三档来源（优先级从高到低）：
//   1. 规则表（EFFORTS_RULES）：按模型 id 写死，实测得出的结论；
//   2. 网关声明的档位（thinking-variants 的 strengths）；
//   3. 默认三档：不思考 / 高 / 最高 —— 判断不了或有争议时就用这一组。
//
// 以前是"运行时自动学习 + 面板手动恢复"，学习结果会持久化并改写 provider，
// 一旦误判就得人工清；现在档位是纯函数结果，重启和重装都一样。

/** DSH / llm-pi-ai 认的档位白名单，顺序即升档顺序。 */
export const VALID_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 判断不了时给的三档：不思考 / 高 / 最高。 */
export const DEFAULT_EFFORTS = Object.freeze({ off: 'none', high: 'high', max: 'max' })

/**
 * 规则表（顺序匹配，先命中先用）。
 *
 * - `off: false`：网关不接受"关闭思考"，不要给 off 档；
 * - `levels`：写死该模型的思考档位（覆盖网关声明），用于已知只认某几档的模型；
 * - `thinking: false`：该模型没有思考档，provider 里写 `reasoningEfforts: false`；
 * - `note`：为什么这么写，方便后人核对。
 */
export const EFFORTS_RULES = Object.freeze([
  { id: /^glm-5\.3(-flash)?$/i, off: false, note: '实测始终思考、不接受 none' },
  { id: /^glm-5\.2(-sft-harmony)?$/i, levels: ['high', 'max'], note: '网关只认 high / max' },
])

function ruleFor(id) {
  const text = String(id ?? '')
  return EFFORTS_RULES.find((rule) => rule.id.test(text))
}

const cleanLevels = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x !== 'off' && VALID_EFFORTS.has(x)))]

/**
 * 算一个模型的 reasoningEfforts。
 *
 * @param id 模型 id
 * @param declared 网关声明的档位（不含 off）
 * @param known 网关是否真的声明过（false = 判断不了，走默认三档）
 * @returns `false`（无思考档）或 `{ off?: 'none', high: 'high', … }`
 */
export function effortsFor(id, declared = [], known = false) {
  const rule = ruleFor(id)
  if (rule?.thinking === false) return false
  const declaredLevels = cleanLevels(declared)
  // 规则表写死的档位优先；已知的模型信网关声明；判断不了的用默认三档。
  // 「已知但没有思考档」= 这个模型本来就不思考，返回 false。
  let thinking
  if (rule?.levels) thinking = cleanLevels(rule.levels)
  else if (known) thinking = declaredLevels
  else thinking = cleanLevels(Object.keys(DEFAULT_EFFORTS))
  if (thinking.length === 0) return false
  const out = {}
  if (rule?.off !== false) out.off = DEFAULT_EFFORTS.off
  for (const level of thinking) out[level] = level
  return out
}

/** 给面板/日志用的一句话说明。 */
export function describeEfforts(id, declared = [], known = false) {
  const efforts = effortsFor(id, declared, known)
  if (!efforts) return '无思考档'
  const names = { off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
  return Object.keys(efforts).map((level) => names[level] ?? level).join('/')
}