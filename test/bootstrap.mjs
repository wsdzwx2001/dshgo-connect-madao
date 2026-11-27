// 回归：启动阶段不写 provider；等 App 的 strip 请求到来后，再由 host 上下文补写一次，
// 这样既有升级迁移（off:null → off:none），又不会撞上 apply 的 HMR 事务。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { startMock } from './mock-gateway.mjs'

const HOME = '/tmp/bootstrap-madao'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
process.env.MADAO_AK = 'TESTAKTESTAKTESTAK00'
process.env.MADAO_SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
process.env.MADAO_SECURITY_TOKEN = 'test-security-token'

const mock = await startMock(8805)
const edits = []
const disposers = []
const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'custom-x': { displayName: '自定义', api: 'openai-completions' } } } } }
const editor = {
  entries: () => [entry],
  canWrite: () => true,
  edit: async (target, change) => {
    target.options.config = await change(structuredClone(target.options.config))
    edits.push(structuredClone(target.options.config))
  },
}
let stripDef
let hmrActive = true
const dshGo = {
  strip: (id, def) => {
    assert.equal(id, 'state')
    stripDef = def
  },
  panel: () => {},
  refresh: () => {},
  on: () => {},
}
const ctx = {
  effect: (cb) => disposers.push(cb()),
  get: (name) => (name === 'hmr' ? { executing: { getStore: () => (hmrActive ? true : undefined) } } : undefined),
  inject: (names, fn) => {
    const services = {}
    if (names.includes('dshGo')) services.dshGo = dshGo
    if (names.includes('configEditor')) services.configEditor = editor
    fn(services)
  },
}
const { apply } = await import('../lib/index.js')
const { bridge } = apply(ctx, { port: 8804, gateway: 'http://127.0.0.1:8805', refreshMs: 0 })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  for (let i = 0; i < 100 && bridge.state.modelsSource !== 'gateway'; i++) await wait(50)
  assert.equal(bridge.state.modelsSource, 'gateway', '启动同步应拿到网关清单')
  await wait(700) // 等 ensureProvider 的 400ms 去抖
  assert.equal(edits.length, 0, 'HMR 事务里启动写入应被跳过')
  assert.ok(stripDef, 'strip 应已注册')

  // 模拟 App 的 strip 请求：此时不在 HMR 事务里，定时器补写 provider。
  hmrActive = false
  const disposeStrip = stripDef({}, () => {}, { locale: 'zh-CN' })
  await wait(2_000)
  assert.ok(edits.length > 0, 'strip 请求后应补写 provider')
  const profile = edits.at(-1).providers['madao-go']
  assert.equal(profile.models.length, 2)
  assert.equal(profile.models.find((m) => m.id === 'mock-pro').reasoningEfforts.off, 'none')
  assert.equal(profile.models.find((m) => m.id === 'mock-fast').reasoningEfforts, false)
  console.log('\n✅ 启动迁移回归通过：HMR 中跳过；strip 请求后补写，且 off 为 none')
  disposeStrip?.()
} finally {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {}
  }
  await bridge.close().catch(() => {})
  await mock.close()
}