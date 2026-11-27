// 回归：本机桥的浏览器边界、鉴权、同步失败保留清单、静态 patch 不覆盖 provider。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// yaml 只是用来解析静态 patch；仓库不依赖它，装了就用，没装就退回文本检查。
let parse = null
try {
  ;({ parse } = await import('yaml'))
} catch {
  try {
    ;({ parse } = await import('/opt/dsh/node_modules/yaml/dist/index.js'))
  } catch {}
}
import { BRIDGE_TOKEN, PLUGIN_VERSION, createBridge } from '../lib/bridge.js'
import { startMock } from './mock-gateway.mjs'

process.env.MADAO_AK = 'TESTAKTESTAKTESTAK00'
process.env.MADAO_SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
process.env.MADAO_SECURITY_TOKEN = 'test-security-token'

const MOCK = 8802
const BASE = 8803
const auth = { authorization: `Bearer ${BRIDGE_TOKEN}` }
const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const patchBefore = readFileSync(patchPath, 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(PLUGIN_VERSION, pkg.version, '运行版本应与 package.json 一致')

const mock = await startMock(MOCK)
const bridge = createBridge({ port: BASE, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0, modelCache: false })
await bridge.listen()
assert.equal(await bridge.connect(), true)
await bridge.refreshCredit()

try {
  const url = (path) => `http://127.0.0.1:${BASE}${path}`

  // 1. 未带 token 的 healthz 只给存活信息
  let r = await fetch(url('/healthz'))
  assert.equal(r.status, 200)
  let body = await r.json()
  assert.equal(body.ok, true)
  assert.equal('credit' in body, false, '未鉴权不应泄露额度')
  assert.equal('ak' in body, false, '未鉴权不应泄露 AK')
  assert.equal(r.headers.get('access-control-allow-origin'), null)

  // 2. 带 token 的 healthz 才给完整状态
  r = await fetch(url('/healthz'), { headers: auth })
  assert.equal(r.status, 200)
  body = await r.json()
  assert.equal(body.credit.remain, 380)
  assert.match(String(body.ak), /^TEST…AK00$/)

  // 3. 浏览器 Origin 一律拒绝（即使带了 token）
  r = await fetch(url('/healthz'), { headers: { ...auth, origin: 'https://evil.example' } })
  assert.equal(r.status, 403)

  // 4. 模型 / 对话都必须鉴权
  assert.equal((await fetch(url('/v1/models'))).status, 401)
  assert.equal(
    (
      await fetch(url('/v1/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock-fast', messages: [{ role: 'user', content: 'hi' }] }),
      })
    ).status,
    401,
  )

  // 5. 浏览器可发的 text/plain 不能当 JSON 用
  assert.equal(
    (
      await fetch(url('/v1/chat/completions'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'text/plain' },
        body: JSON.stringify({ model: 'mock-fast', messages: [{ role: 'user', content: 'hi' }] }),
      })
    ).status,
    415,
  )

  // 6. 预检也不放行 CORS
  r = await fetch(url('/v1/chat/completions'), { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)

  // 7. 缺 context / 非法 strengths 不应写坏 provider
  mock.control.badModels = true
  mock.control.badStrengths = true
  const cleaned = await bridge.syncModels()
  assert.equal(cleaned.ok, true)
  assert.equal(bridge.state.models.some((m) => m.id === 'mock-bad-context'), false, '缺 context 的模型应被跳过')
  assert.deepEqual(bridge.state.models.find((m) => m.id === 'mock-pro')?.strengths, ['high'])
  mock.control.badModels = false
  mock.control.badStrengths = false

  // 8. messages 结构错误应是 400，而不是 500
  r = await fetch(url('/v1/chat/completions'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-fast', messages: 'oops' }),
  })
  assert.equal(r.status, 400)
  assert.match(await r.text(), /messages 必须是消息对象数组/)

  // 8. 网关接受 none 但 usage 仍有 reasoning_tokens：自动记住关不掉思考
  assert.equal((await bridge.syncModels()).ok, true, '先拿到 mock-fast 模型')
  mock.control.acceptNoneButThink = true
  r = await fetch(url('/v1/chat/completions'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-fast', stream: false, max_tokens: 16, reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.status, 200)
  const offBody = await r.json()
  assert.equal(offBody.usage?.completion_tokens_details?.reasoning_tokens, 5)
  assert.ok(bridge.state.noOff.has('mock-fast'), 'usage 仍有 reasoning_tokens 时应去掉 off 档')
  mock.control.acceptNoneButThink = false

  // 9. 没有签到活动时，自检不应变红
  mock.control.noCheckin = true
  const selfTest = await bridge.test()
  assert.equal(selfTest.ok, true, JSON.stringify(selfTest.steps))
  mock.control.noCheckin = false

  // 10. claimable 为 true 时，即使 status 不是 ELIGIBLE 也应尝试领取
  mock.control.checkinStatus = 'CLAIMED'
  const claim = await bridge.checkin()
  assert.equal(claim.claimed, true, JSON.stringify(claim))
  mock.control.checkinStatus = null

  // 11. 客户端断开 / 点停止时，上游请求也要被取消
  mock.control.slowChatMs = 3_000
  mock.control.chatClosed = 0
  const chatsBefore = mock.seen.filter((x) => x.path === '/api/v2/chat/completions').length
  const abort = new AbortController()
  const pendingChat = fetch(url('/v1/chat/completions'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-fast', messages: [{ role: 'user', content: 'hi' }] }),
    signal: abort.signal,
  }).catch((err) => err)
  for (let i = 0; i < 100 && mock.seen.filter((x) => x.path === '/api/v2/chat/completions').length === chatsBefore; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  abort.abort()
  assert.ok((await pendingChat) instanceof Error, '客户端请求应被中断')
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(mock.control.chatClosed > 0, '客户端断开后，上游连接应被取消')
  mock.control.slowChatMs = 0

  // 8. 同步失败保留原清单，不再静默回退
  const first = await bridge.syncModels()
  assert.equal(first.ok, true)
  const ids = bridge.state.models.map((m) => m.id)
  mock.control.failModels = true
  const failed = await bridge.syncModels()
  assert.equal(failed.ok, false)
  assert.match(String(failed.error), /503/)
  assert.deepEqual(bridge.state.models.map((m) => m.id), ids, '503 后清单不应被替换')
  mock.control.failModels = false

  // 8. 全部停用导致的空清单也保留原清单
  mock.control.disableAll = true
  const empty = await bridge.syncModels()
  assert.equal(empty.ok, false)
  assert.match(String(empty.error), /没有可用模型/)
  assert.deepEqual(bridge.state.models.map((m) => m.id), ids, '空清单不应把模型清空')
  mock.control.disableAll = false

  // 9. 静态 patch 只声明插件，不在 bundle 层写 llm-pi-ai provider
  const patchAfter = readFileSync(patchPath, 'utf8')
  assert.equal(patchAfter, patchBefore, '运行时不应改写包内 cordis.patch.yml')
  assert.doesNotMatch(patchAfter, /off:\s*null/)
  assert.doesNotMatch(patchAfter, /llm-pi-ai\s*:/, '静态 patch 不应整段替换 llm-pi-ai 配置')
  assert.doesNotMatch(patchAfter, /madao-go/, 'provider 只应写进 profile，不写 bundle patch')
  if (parse) {
    const patchRows = parse(patchAfter)
    assert.equal(patchRows.some((row) => row.id === 'llm-pi-ai'), false, '静态 patch 不应整段替换 llm-pi-ai 配置')
    assert.equal(JSON.stringify(patchRows).includes('madao-go'), false, 'provider 只应写进 profile，不写 bundle patch')
  }

  console.log('\n✅ 安全与同步回归通过：鉴权 / Origin / 415 / 同步失败保留清单 / 静态 patch 未改写')
} finally {
  await bridge.close().catch(() => {})
  await mock.close()
}