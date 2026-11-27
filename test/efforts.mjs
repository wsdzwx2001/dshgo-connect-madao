// 思考档位规则表：纯函数，不需要网关。
// 规则：规则表 → 网关声明 → 默认「不思考 / 高 / 最高」。
import assert from 'node:assert/strict'
import { DEFAULT_EFFORTS, EFFORTS_RULES, VALID_EFFORTS, describeEfforts, effortsFor } from '../lib/efforts.js'

const DEFAULT = { off: 'none', high: 'high', max: 'max' }

// 1. 判断不了的模型（网关没声明）：默认三档，正是用户要的「不思考 / 高 / 最高」
assert.deepEqual(effortsFor('brand-new-model', [], false), DEFAULT)
assert.deepEqual(effortsFor('mock-fast', undefined, false), DEFAULT)

// 2. 已知模型信网关声明：多出来的档位保留，off 仍由规则表决定
assert.deepEqual(effortsFor('deepseek-v4.1-flash', ['low', 'high', 'max'], true), { off: 'none', low: 'low', high: 'high', max: 'max' })

// 3. 已知但没有思考档 = 这个模型本来就不思考
assert.equal(effortsFor('speed', [], true), false)
assert.equal(effortsFor('speed', ['bogus', 'off', 42], true), false, '非法档位滤完为空也算不思考')

// 4. 规则表：glm-5.3 系列不接受关闭思考（大小写都认），思考档位仍信网关声明
for (const id of ['glm-5.3', 'GLM-5.3', 'glm-5.3-flash', 'GLM-5.3-Flash']) {
  const got = effortsFor(id, ['low', 'high', 'max'], true)
  assert.deepEqual(got, { low: 'low', high: 'high', max: 'max' }, `${id} 不该有 off：${JSON.stringify(got)}`)
  assert.equal('off' in got, false)
  // 网关没声明档位时，规则表也不该凭空给 off
  assert.equal('off' in effortsFor(id, [], false), false)
}

// 5. 规则表：GLM-5.2 系列只认 high / max，但 off 没证据说不能关，保留
assert.deepEqual(effortsFor('GLM-5.2', ['high', 'max'], true), { off: 'none', high: 'high', max: 'max' })
assert.deepEqual(effortsFor('glm-5.2-sft-harmony', [], true), { off: 'none', high: 'high', max: 'max' }, '规则写死档位时不看网关声明')

// 6. 声明里的 off / 非法值不会漏进 provider（llm-pi-ai 会因为非法档位整段校验失败）
const filtered = effortsFor('kimi-k3', ['off', 'high', 'bogus', 7], true)
assert.deepEqual(filtered, { off: 'none', high: 'high' })
for (const [level, wire] of Object.entries(filtered)) {
  assert.ok(VALID_EFFORTS.has(level), `档位名必须是 DSH 白名单里的：${level}`)
  // off 发的是 none；其余档位的 wire 值就是档位名本身
  assert.equal(wire, level === 'off' ? 'none' : level)
}

// 7. 结果至少有一个思考档，否则宁可不写（off 单独存在没有意义）
for (const rule of EFFORTS_RULES) {
  const got = effortsFor('x', [], false)
  assert.ok(Object.keys(got).some((k) => k !== 'off'))
}
assert.deepEqual(Object.keys(DEFAULT_EFFORTS), ['off', 'high', 'max'], '默认三档就这三档')

// 8. 面板说明
assert.equal(describeEfforts('glm-5.3', ['high', 'max'], true), '高/最高')
assert.equal(describeEfforts('brand-new-model', [], false), '关/高/最高')
assert.equal(describeEfforts('speed', [], true), '无思考档')

console.log('✅ 档位规则表通过：默认三档 / 声明优先 / glm-5.3 无 off / 非法值过滤')