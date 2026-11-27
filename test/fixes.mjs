// 回归：0.1.4 修的 21 项里能在本机复现的部分。
// 覆盖：额度 4xx 不再让自检变红、错误体可见、退避、签到保旧值、模型缓存、
//       流中途报错不重发、工具续传帧没 index、413、思考档位误判、未配置不写 provider、
//       凭证解析优先认字段名、损坏凭证回退旧路径。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { startMock } from './mock-gateway.mjs'

const HOME = '/tmp/fixes-madao'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
delete process.env.MADAO_AK
delete process.env.MADAO_SK
delete process.env.MADAO_SECURITY_TOKEN

const MOCK = 8825
const AK = 'TESTAKTESTAKTESTAK00'
const SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
const TOKEN = 'test-security-token'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const mock = await startMock(MOCK)
const realFetch = globalThis.fetch
let creditStatus = 200
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input)
  if (url.includes('/snap-manager/v1/statistics/plugin') && creditStatus !== 200) {
    return new Response('{"code":"InvalidParameter","message":"missing start_date"}', {
      status: creditStatus,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(input, init)
}

const { createBridge, loadCredentials, BRIDGE_TOKEN, CRED_PATH } = await import('../lib/bridge.js')
const { apply } = await import('../lib/index.js')

const disposers = []
const bridges = []
const ctxOf = (dshGo, editor) => ({
  effect: (cb) => disposers.push(cb()),
  get: () => undefined,
  inject: (names, fn) => {
    const services = {}
    if (names.includes('dshGo')) services.dshGo = dshGo
    if (names.includes('configEditor')) services.configEditor = editor
    fn(services)
  },
})
const makeEditor = () => {
  const edits = []
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } } }
  return {
    edits,
    entry,
    service: {
      entries: () => [entry],
      canWrite: () => true,
      edit: async (target, change) => {
        target.options.config = await change(structuredClone(target.options.config), structuredClone(target.options.config))
        edits.push(structuredClone(target.options.config))
      },
    },
  }
}
const panelsOf = () => {
  const panels = new Map()
  const strips = []
  const dshGo = {
    strip: (id, def) => strips.push({ id, def }),
    panel: (id, def) => panels.set(id, def),
    refresh: () => {},
  }
  return { panels, strips, dshGo }
}
const pullData = (panels, id) =>
  new Promise((resolve) => {
    const def = panels.get(id)
    const off = def.data({}, resolve, { locale: 'zh-CN' })
    if (typeof off === 'function') setTimeout(off, 0)
  })

try {
  // ── 1. 未配置凭证：兜底清单不给改，也不写 provider ──────────────
  {
    const editor = makeEditor()
    const { panels, dshGo } = panelsOf()
    const { bridge } = apply(ctxOf(dshGo, editor.service), { port: 8831, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
    bridges.push(bridge)
    const panel = panels.get('madao')
    const view = panel.view({}, { locale: 'zh-CN' })
    assert.ok(view.children.at(-1).items.length > 1, '未配置时展示兜底模型')
    const row = view.children.at(-1).items[0]
    const out = await panel.actions[row.action]()
    assert.match(out.toast, /先填凭证/, '未配置凭证时应拒绝调整模型')
    await wait(600)
    assert.equal(editor.edits.length, 0, '未配置凭证时不应写 provider')
    console.log('· 未配置凭证：不写 provider，模型开关被拦住')
  }

  // 环境变量凭证：跳过 IAM，直接当临时令牌用
  process.env.MADAO_AK = AK
  process.env.MADAO_SK = SK
  process.env.MADAO_SECURITY_TOKEN = TOKEN

  // ── 2. 额度 400：自检只提示、不判死；错误体可见；退避 ───────────
  const bridge = createBridge({ port: 8820, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
  bridges.push(bridge)
  await bridge.listen()
  assert.equal(await bridge.connect(), true)
  assert.equal((await bridge.syncModels()).ok, true)

  creditStatus = 400
  const failedTest = await bridge.test()
  const creditStep = failedTest.steps.find((s) => s.name === '额度')
  assert.equal(failedTest.ok, true, '额度失败不应把整个自检判红')
  assert.equal(failedTest.warn, true, '应标记为软失败')
  assert.equal(creditStep.ok, false)
  assert.match(creditStep.detail, /HTTP 400/, '错误里要带上状态码')
  assert.match(creditStep.detail, /missing start_date/, '错误里要带上响应体')
  assert.equal(bridge.status().credit, null)
  assert.match(String(bridge.status().creditError), /missing start_date/)

  // 连续刷新只按退避重试，且失败次数在累加
  await bridge.refreshCredit()
  await bridge.refreshCredit()
  assert.ok(bridge.status().creditFailures >= 1)
  console.log('· 额度 400：自检仍算通过、错误体可见、进入退避')

  // ── 3. 额度恢复：数字回来，旧失败被标记 stale ────────────────────
  creditStatus = 200
  await wait(2100) // 最小间隔 2 秒，别让 force 被节流挡住
  await bridge.refreshCredit({ force: true })
  assert.equal(bridge.status().credit.remain, 380, '恢复后应拿到额度')
  assert.equal(bridge.status().creditError, null)
  assert.equal(bridge.status().test?.stale, true, '成功证据应把旧的自检失败压下去')
  console.log('· 额度恢复：数字回来、旧失败不再显示')

  // ── 4. 流中途报错：已吐内容后不重发，也不学 noOff ────────────────
  mock.control.errorAfterContent = true
  mock.control.rejectNoneWith = '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。'
  const chatsBefore = mock.seen.filter((r) => r.path === '/api/v2/chat/completions').length
  let r = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ model: 'mock-fast', stream: false, strength: 'off', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.status, 400, '上游错误帧应原样报错')
  const chatsAfter = mock.seen.filter((x) => x.path === '/api/v2/chat/completions').length
  assert.equal(chatsAfter - chatsBefore, 1, '已经吐出正文后不该再重发')
  assert.equal(bridge.state.noOff.has('mock-fast'), false, '不该因此学成“关不掉思考”')
  mock.control.errorAfterContent = false
  console.log('· 流中途报错：不重发、不误学 noOff')

  // ── 5. 思考档位：提到 reasoning_effort 但不是说 none 不支持 → 不学 ──
  mock.control.rejectNoneWith = "Invalid reasoning_effort: 'low'. Allowed values: high, max."
  r = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ model: 'mock-pro', stream: false, strength: 'off', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.status, 502, '无法关闭思考的其它错误不该被当成可重试')
  assert.equal(bridge.state.noOff.has('mock-pro'), false, '档位非法不该删掉 off 档')

  // 真正的“关不掉”仍要自动重试并记住
  mock.control.rejectNoneWith = '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。'
  r = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ model: 'mock-pro', stream: false, strength: 'off', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.status, 200, '真正的关不掉应去掉 off 重发成功')
  assert.equal(bridge.state.noOff.has('mock-pro'), true)
  mock.control.rejectNoneWith = null
  console.log('· 思考档位：误判不再删档，真关不掉仍会重试')

  // ── 6. 工具续传帧没 index：仍合成一个调用 ───────────────────────
  mock.control.toolNoIndex = true
  r = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({
      model: 'mock-fast',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
    }),
  })
  const toolBody = await r.json()
  assert.equal(toolBody.choices[0].message.tool_calls.length, 1, '续传帧不该拆成第二个调用')
  assert.equal(toolBody.choices[0].message.tool_calls[0].function.arguments, '{"path":"a","x":1}')
  mock.control.toolNoIndex = false
  console.log('· 工具调用：缺 index 的续传帧合并正确')

  // ── 7. 超限请求体：413 + 人话 ──────────────────────────────────
  r = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
    body: JSON.stringify({ model: 'mock-fast', messages: [{ role: 'user', content: 'x'.repeat(8_600_000) }] }),
  })
  assert.equal(r.status, 413, '超限应是 413')
  assert.match((await r.json()).error.message, /超过本机桥上限/)
  console.log('· 请求体超限：413 且提示清楚')

  // ── 8. 签到失败保留上一次结果 ──────────────────────────────────
  await bridge.refreshCheckin({ force: true })
  assert.equal(bridge.status().checkin?.available, true)
  mock.control.failDelivery = true
  await bridge.refreshCheckin({ force: true })
  assert.equal(bridge.status().checkin?.available, true, '一次失败不该把签到状态抹掉')
  assert.match(String(bridge.status().checkinError), /HTTP 500/)
  mock.control.failDelivery = false
  await bridge.refreshCheckin({ force: true })
  assert.equal(bridge.status().checkinError, null)
  console.log('· 签到：失败保留旧值，恢复后清空错误')

  // ── 9. 模型缓存：重启后仍能解析上次的清单 ──────────────────────
  await wait(150)
  const cached = JSON.parse(readFileSync(`${HOME}/.config/dshgo-connect-madao/models-cache.json`, 'utf8'))
  assert.equal(cached.models.length, 2, '同步成功后应写缓存')
  const bridge2 = createBridge({ port: 8821, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
  bridges.push(bridge2)
  assert.equal(bridge2.state.modelsSource, 'cache')
  assert.deepEqual(bridge2.state.models.map((m) => m.id).sort(), ['mock-fast', 'mock-pro'], '离线启动应沿用上次清单')
  await bridge2.listen()
  console.log('· 模型缓存：离线重启沿用上次清单')

  // ── 10. 状态条：额度异常只提示，自检失败不再粘住 ────────────────
  mock.control.noCheckin = true // 免得「可签到」优先占位
  creditStatus = 400
  {
    const editor = makeEditor()
    const { panels, strips, dshGo } = panelsOf()
    const { bridge: b3 } = apply(ctxOf(dshGo, editor.service), { port: 8830, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
    bridges.push(b3)
    for (let i = 0; i < 100 && b3.state.modelsSource !== 'gateway'; i++) await wait(50)
    const strip = strips[0].def
    let emitted
    strip({}, (v) => (emitted = v), { locale: 'zh-CN' })
    assert.equal(emitted.text, '码道 就绪 · 额度异常', JSON.stringify(emitted))
    assert.equal(emitted.tone, 'info')

    const panel = panels.get('madao')
    const pending = panel.actions.test()
    const effects = await pending.result(new AbortController().signal)
    assert.match(effects.toast, /额度异常，其余正常/, JSON.stringify(effects))
    const snap = await pullData(panels, 'madao')
    assert.equal(snap.statusText, '就绪', '额度失败不该让状态变“自检失败”')
    assert.match(String(snap.errorText), /额度：/)

    // 额度恢复后，状态条回到「剩 380」，面板错误清空
    creditStatus = 200
    await wait(2100)
    await b3.refreshCredit({ force: true })
    strip({}, (v) => (emitted = v), { locale: 'zh-CN' })
    assert.equal(emitted.text, '码道 剩 380', JSON.stringify(emitted))
    assert.equal((await pullData(panels, 'madao')).errorText, '-')
    console.log('· 状态条：额度异常只提示，恢复后自动消失')
  }

  // ── 11. 凭证解析：明确字段名优先，不被干扰串带跑 ────────────────
  {
    const editor = makeEditor()
    const { panels, dshGo } = panelsOf()
    const { bridge: b4 } = apply(ctxOf(dshGo, editor.service), { port: 8832, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
    bridges.push(b4)
    const save = panels.get('creds').actions.save
    const res = await save({}, { value: { note: 'z'.repeat(40), values: { akInput: AK, skInput: SK } } })
    assert.match(res.toast, /已保存/, JSON.stringify(res))
    const saved = JSON.parse(readFileSync(CRED_PATH, 'utf8'))
    assert.deepEqual(saved, { ak: AK, sk: SK }, '应只取 akInput / skInput')
    console.log('· 凭证解析：优先认字段名')
  }

  // ── 12. 损坏的 credentials.json 不挡住旧路径 ────────────────────
  {
    delete process.env.MADAO_AK
    delete process.env.MADAO_SK
    delete process.env.MADAO_SECURITY_TOKEN
    writeFileSync(CRED_PATH, '{not json', 'utf8')
    mkdirSync(`${HOME}/.dsh-connect-madao`, { recursive: true })
    writeFileSync(`${HOME}/.dsh-connect-madao/credentials.json`, JSON.stringify({ ak: 'LEGACYAKLEGACYAK0000', sk: 'legacySKlegacySKlegacySKlegacySK0000' }), 'utf8')
    const got = await loadCredentials()
    assert.equal(got.key.ak, 'LEGACYAKLEGACYAK0000', '坏文件不该挡住兼容路径')
    console.log('· 凭证文件损坏：仍能从旧路径读回来')
  }

  console.log('\n✅ 0.1.4 回归通过：额度容错 / 状态条 / 思考档位 / 工具调用 / 413 / 签到 / 缓存 / 凭证')
} finally {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {}
  }
  for (const b of bridges) await b.close().catch(() => {})
  globalThis.fetch = realFetch
  await mock.close()
}
process.exit(0)