// 思考档位规则表：纯函数，不需要网关。
// 规则：规则表 → 网关声明 → 默认「不思考 / 高 / 最高」。
import assert from 'node:assert/strict'
import { DEFAULT_EFFORTS, EFFORTS_RULES, VALID_EFFORTS, describeEfforts, effortsFor, effortsSource } from '../lib/efforts.js'
import { FALLBACK_MODELS } from '../lib/bridge.js'

const DEFAULT = { off: 'none', high: 'high', max: 'max' }
/** 码道 26.11 全部 12 个可拉取模型在 2026-11-27 实测得到的档位。 */
const MATRIX = {
  'GLM-5.2': DEFAULT,
  'glm-5.2-sft-harmony': DEFAULT,
  'glm-5.3': { low: 'low', high: 'high', max: 'max' },
  'glm-5.3-flash': { low: 'low', high: 'high', max: 'max' },
  'deepseek-v4.1-flash': { off: 'none', low: 'low', high: 'high', max: 'max' },
  'deepseek-v4.1-flash-1017': { off: 'none', low: 'low', high: 'high', max: 'max' },
  'kimi-k3': { off: 'none', low: 'low', high: 'high', max: 'max' },
  'kimi-k3.1-pro': { off: 'none', low: 'low', high: 'high', max: 'max' },
  'openpangu-2.0-pro': false,
  'openpangu-2.0-flash': false,
  'openpangu-2.1-pro': false,
  speed: false,
}

// 1. 每个真实模型都在规则表里，且结果等于实测值（不随网关声明漂移）
for (const [id, expected] of Object.entries(MATRIX)) {
  assert.equal(effortsSource(id), 'rule', `${id} 应命中规则表`)
  assert.deepEqual(effortsFor(id, [], false), expected, `${id} 档位不对`)
  // 即使网关声明了别的档位，规则表也不动摇
  assert.deepEqual(effortsFor(id, ['minimal', 'medium', 'xhigh'], true), expected, `${id} 不该被网关声明带跑`)
}

// 2. 兜底清单里的模型一个都不能漏规则（否则离线启动档位又会漂）
for (const m of FALLBACK_MODELS) {
  assert.ok(m.id in MATRIX, `兜底清单里的 ${m.id} 没有实测档位记录`)
  assert.equal(effortsSource(m.id), 'rule', `兜底清单里的 ${m.id} 没有规则`)
}

// 3. 判断不了的新模型：默认三档，正是「不思考 / 高 / 最高」
assert.deepEqual(effortsFor('brand-new-model', [], false), DEFAULT)
assert.deepEqual(effortsFor('mock-fast', undefined, false), DEFAULT)
assert.equal(effortsSource('brand-new-model'), 'gateway')

// 4. 没有规则的已知模型仍信网关声明；已知但没声明 = 不思考
assert.deepEqual(effortsFor('some-known-model', ['minimal', 'low'], true), { off: 'none', minimal: 'minimal', low: 'low' })
assert.equal(effortsFor('some-known-model', [], true), false)

// 5. glm-5.3 系列永远没有 off（大小写都认）
for (const id of ['glm-5.3', 'GLM-5.3', 'glm-5.3-flash', 'GLM-5.3-Flash']) {
  assert.equal('off' in effortsFor(id, ['off', 'low', 'high', 'max'], true), false, `${id} 不该有 off`)
}

// 6. 声明里的 off / 非法值不会漏进 provider（llm-pi-ai 会因为非法档位整段校验失败）
const filtered = effortsFor('brand-new-model', ['off', 'high', 'bogus', 7], true)
assert.deepEqual(filtered, { off: 'none', high: 'high' })
for (const [level, wire] of Object.entries(filtered)) {
  assert.ok(VALID_EFFORTS.has(level), `档位名必须是 DSH 白名单里的：${level}`)
  // off 发的是 none；其余档位的 wire 值就是档位名本身
  assert.equal(wire, level === 'off' ? 'none' : level)
}

// 7. 每条规则都要能匹配到真实模型（别写永远不命中的死规则）
for (const rule of EFFORTS_RULES) {
  const hit = Object.keys(MATRIX).some((id) => rule.id.test(id))
  assert.ok(hit, `规则 ${rule.id} 匹配不到任何模型`)
  if (rule.thinking === false) {
    assert.ok(Object.keys(MATRIX).some((id) => rule.id.test(id) && MATRIX[id] === false), `规则 ${rule.id} 标了不思考但实测有档位`)
  }
}
assert.deepEqual(Object.keys(DEFAULT_EFFORTS), ['off', 'high', 'max'], '默认三档就这三档')

// 8. 面板说明
assert.equal(describeEfforts('glm-5.3'), '低/高/最高')
assert.equal(describeEfforts('GLM-5.2'), '关/高/最高')
assert.equal(describeEfforts('brand-new-model', [], false), '关/高/最高')
assert.equal(describeEfforts('openpangu-2.0-pro'), '无思考档')

console.log(`✅ 档位规则表通过：${Object.keys(MATRIX).length} 个模型全覆盖 / 默认三档 / 声明不受影响 / 非法值过滤`)