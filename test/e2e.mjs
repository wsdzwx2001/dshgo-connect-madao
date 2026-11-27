// 端到端对拍：同一套模拟网关下，先跑原插件 dsh-connect-madao，再跑 dshgo-connect-madao。
// 两边都要能签名、协商、加解密、流式返回；最后比较网关侧记录到的请求差异。
import assert from 'node:assert/strict'
import { BRIDGE_TOKEN, createBridge } from '../lib/bridge.js'
import { startMock } from './mock-gateway.mjs'

const AK = 'TESTAKTESTAKTESTAK00'
const SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
const TOKEN = 'test-security-token'
process.env.MADAO_AK = AK
process.env.MADAO_SK = SK
process.env.MADAO_SECURITY_TOKEN = TOKEN

const MOCK = 8790
const payload = {
  model: 'mock-fast',
  max_tokens: 512,
  messages: [
    { role: 'developer', content: '你是助手。' },
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ],
  stream_options: { include_usage: true },
  reasoning_effort: 'max',
}

async function waitOk(base, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/healthz`)
      if (r.ok) return (await r.json())
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${base} 没起来`)
}

function sseText(body) {
  let text = ''
  let reasoning = ''
  let usage = null
  const calls = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice(6).trim()
    if (raw === '[DONE]') continue
    const obj = JSON.parse(raw)
    if (obj.error) throw new Error(`流里带错误：${JSON.stringify(obj.error)}`)
    const d = obj.choices?.[0]?.delta ?? {}
    if (d.content) text += d.content
    if (d.reasoning_content) reasoning += d.reasoning_content
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? calls.length
      calls[i] ??= { id: '', name: '', arguments: '' }
      if (tc.id) calls[i].id = tc.id
      if (tc.function?.name) calls[i].name += tc.function.name
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments
    }
    if (obj.usage) usage = obj.usage
  }
  return { text, reasoning, usage, calls }
}

async function chatStream(base, extra = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ ...payload, ...extra }),
  })
  const body = await res.text()
  assert.equal(res.status, 200, `${base} 流式状态 ${res.status}: ${body.slice(0, 200)}`)
  return sseText(body)
}

async function main() {
  const mock = await startMock(MOCK)
  const results = {}

  // ── 原插件（真实入口 index.js，不是 CLI 副本）────────────────
  const { apply: applyOriginal } = await import('/tmp/orig-madao/lib/index.js')
  const disposers = []
  const fakeCtx = { effect: (cb) => disposers.push(cb()), logger: { warn() {}, info() {} } }
  applyOriginal(fakeCtx, { port: 8793, gateway: `http://127.0.0.1:${MOCK}` })
  try {
    const health = await waitOk('http://127.0.0.1:8793')
    console.log('原插件 healthz:', JSON.stringify(health).slice(0, 120))
    const s = await chatStream('http://127.0.0.1:8793')
    assert.equal(s.text, '你好，mock-fast。第二段。')
    assert.equal(s.reasoning, '想一想。')
    assert.equal(s.usage.prompt_tokens_details.cached_tokens, 60)
    const tools = await chatStream('http://127.0.0.1:8793', {
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
    })
    assert.deepEqual(tools.calls[0], { id: 'call_1', name: 'read', arguments: '{"path":"a","x":1}' })
    results.original = { text: s.text }
    console.log('原插件：流式 + 工具调用通过；usage 明细', JSON.stringify(s.usage))
  } finally {
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  const before = mock.seen.length

  // ── 新插件 ────────────────────────────────────────────────
  const bridge = createBridge({ port: 8792, gateway: `http://127.0.0.1:${MOCK}`, onModels: async () => ({ changed: true }) })
  await bridge.listen()
  assert.equal(await bridge.connect(), true)
  const sync = await bridge.syncModels()
  assert.equal(sync.ok, true)
  assert.equal(sync.models, 2)
  const s = await chatStream('http://127.0.0.1:8792')
  assert.equal(s.text, '你好，mock-fast。第二段。')
  assert.equal(s.reasoning, '想一想。')
  assert.equal(s.usage.prompt_tokens_details.cached_tokens, 60)

  // 非流式
  const nonStream = await fetch('http://127.0.0.1:8792/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ ...payload, stream: false }),
  })
  const nonJson = await nonStream.json()
  assert.equal(nonJson.choices[0].message.content, '你好，mock-fast。第二段。')
  assert.equal(nonJson.choices[0].message.reasoning_content, '想一想。')

  // 工具调用
  const tools = await chatStream('http://127.0.0.1:8792', {
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
  })
  assert.deepEqual(tools.calls[0], { id: 'call_1', name: 'read', arguments: '{"path":"a","x":1}' })

  // 模型名带显示名也能解析；未知模型要有清晰报错
  const byShown = await chatStream('http://127.0.0.1:8792', { model: 'Mock-Fast · 0.1x' })
  assert.equal(byShown.text, '你好，mock-fast。第二段。')
  const unknown = await fetch('http://127.0.0.1:8792/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ ...payload, model: 'nope' }),
  })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error.message, /未知模型/)

  // 额度 + 自检
  await bridge.refreshCredit()
  const test = await bridge.test()
  assert.equal(test.ok, true, JSON.stringify(test.steps))
  const status = bridge.status()
  assert.equal(status.credit.remain, 380)
  console.log('新插件：流式/非流式/工具调用/模型名解析/额度/自检 均通过')

  // 比较两边发给网关的请求：模型、developer→system、思考强度
  const mine = mock.seen.slice(before).filter((r) => r.path === '/api/v2/chat/completions')
  const original = mock.seen.slice(0, before).filter((r) => r.path === '/api/v2/chat/completions')
  const pick = (r) => ({ model: r.model, roles: r.roles, reasoningEffort: r.reasoningEffort, maxTokens: r.maxTokens })
  console.log('原插件首个对话请求：', JSON.stringify(pick(original[0])))
  console.log('新插件首个对话请求：', JSON.stringify(pick(mine[0])))
  assert.deepEqual(pick(mine[0]), pick(original[0]))

  assert.equal(mock.seen.filter((r) => r.error).length, 0, JSON.stringify(mock.seen.find((r) => r.error)))
  console.log('\n✅ 等价性对拍通过：同一套模拟网关下，新插件与原插件发出的请求一致，签名与加解密互通。')
  await bridge.close()
  await mock.close()
}

main().catch(async (err) => {
  console.error('❌ 测试失败：', err)
  process.exit(1)
})