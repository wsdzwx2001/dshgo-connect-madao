// 回归：能在本机复现的修复项。
// 覆盖：额度 4xx 不再让自检变红、错误体可见、退避、签到保旧值、模型缓存、
//       流中途报错不重发、工具续传帧没 index、413、思考档位误判、未配置不写 provider、
//       凭证解析优先认字段名、损坏凭证回退旧路径、stale 后步骤表回绿、
//       max_tokens 收敛、图片能力校验、CRLF 分隔的 SSE、心跳失败记账、
//       手填令牌过期自动换 STS、缓存里的非法档位过滤。
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
delete process.env.MADAO_SECURITY_TOKEN_EXPIRES

const MOCK = 8825
const AK = 'TESTAKTESTAKTESTAK00'
const SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
const TOKEN = 'test-security-token'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const mock = await startMock(MOCK)
const realFetch = globalThis.fetch
let creditStatus = 200
let iamCalls = 0
let iamFail = 0
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input)
  // 拦掉真实 IAM：返回与模拟网关同一套临时凭证
  if (url.includes('iam.cn-north-4.myhuaweicloud.com')) {
    iamCalls++
    if (iamFail > 0) {
      iamFail--
      return new Response('{"error":"iam busy"}', { status: 500, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ credential: { access: AK, secret: SK, securitytoken: TOKEN, expires_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
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
    const recovered = await pullData(panels, 'madao')
    assert.equal(recovered.errorText, '-')
    assert.ok(recovered.steps.every((x) => x.status === 'done'), 'stale 后步骤表不该还挂红叉：' + JSON.stringify(recovered.steps))
    console.log('· 状态条：额度异常只提示，恢复后自动消失（步骤表也回绿）')
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

  // ── 13. max_tokens：不传按模型上限、超限压回上限 ───────────────
  {
    const upstream = () => mock.seen.filter((x) => x.path === '/api/v2/chat/completions').at(-1).maxTokens
    const call = (body) =>
      realFetch('http://127.0.0.1:8820/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
        body: JSON.stringify(body),
      })
    await (await call({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] })).text()
    assert.equal(upstream(), 32768, '不传时应按模型上限（mock-fast 声明 65536，但上限 32768）')
    await (await call({ model: 'mock-fast', stream: false, max_tokens: 999999, messages: [{ role: 'user', content: 'hi' }] })).text()
    assert.equal(upstream(), 32768, '超过模型上限应压回上限')
    await (await call({ model: 'mock-fast', stream: false, max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] })).text()
    assert.equal(upstream(), 512, '小于上限时保持客户端给的值')
    console.log('· max_tokens：不传按模型上限、超限压回')
  }

  // ── 14. 图片：模型不支持就提前 400，别丢给网关 ──────────────────
  {
    const call = (model) =>
      realFetch('http://127.0.0.1:8820/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }] }),
      })
    const bad = await call('mock-pro') // mock-pro 不支持图片
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error.message, /不支持图片输入/)
    const ok = await call('mock-fast')
    assert.equal(ok.status, 200, '支持图片的模型应照常转发')
    await ok.text()
    console.log('· 图片：不支持图片的模型提前 400')
  }

  // ── 15. SSE 用 \r\n 分隔也要能流式解析 ───────────────────────────
  {
    mock.control.crlfSse = true
    const r2 = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r2.status, 200)
    const text = await r2.text()
    assert.match(text, /你好，mock-fast。/, 'CRLF 分隔的 SSE 也要解出正文')
    assert.match(text, /\[DONE\]/, '应正常收尾')
    mock.control.crlfSse = false
    console.log('· SSE：\\r\\n 分隔也能流式解析')
  }

  // ── 16. 心跳失败不再静默：记账但不影响对话 ──────────────────────
  {
    mock.control.failHeartbeat = true
    bridge.state.heartbeatFailures = 0
    const r3 = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await r3.text()
    assert.equal(r3.status, 200, '心跳失败不该影响对话')
    assert.ok(bridge.status().heartbeatFailures > 0)
    assert.match(String(bridge.status().heartbeatError), /HTTP 500/)
    mock.control.failHeartbeat = false
    const r4 = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await r4.text()
    assert.equal(bridge.status().heartbeatFailures, 0, '心跳恢复后应清零')
    assert.equal(bridge.status().heartbeatError, null)
    console.log('· 心跳：失败有记账，恢复后清零')
  }

  // ── 17. 手填令牌运行中过期：自动改走 AK/SK 换 STS ───────────────
  {
    process.env.MADAO_AK = AK
    process.env.MADAO_SK = SK
    process.env.MADAO_SECURITY_TOKEN = TOKEN
    process.env.MADAO_SECURITY_TOKEN_EXPIRES = new Date(Date.now() + 3600e3).toISOString()
    const b5 = createBridge({ port: 8833, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
    bridges.push(b5)
    await b5.listen()
    assert.equal(await b5.connect(), true)
    assert.ok(b5.state.tokenOnly > 0, '应识别为临时令牌')
    assert.equal(b5.state.sts, null)
    // 把到期时间调到 1 分钟后，模拟"运行中过期"
    b5.state.tokenOnly = Date.now() + 30_000
    const iamBefore = iamCalls
    const r5 = await realFetch('http://127.0.0.1:8833/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await r5.text()
    assert.equal(r5.status, 200)
    assert.ok(iamCalls > iamBefore, '令牌将过期时应主动换 STS')
    assert.ok(b5.state.sts, '应已切换到 STS 模式')
    assert.equal(b5.state.tokenOnly, 0)
    delete process.env.MADAO_SECURITY_TOKEN_EXPIRES
    delete process.env.MADAO_SECURITY_TOKEN
    delete process.env.MADAO_AK
    delete process.env.MADAO_SK
    console.log('· 临时令牌过期：自动换 STS')
  }

  // ── 18. 缓存里的非法档位被过滤（否则整段 llm-pi-ai 配置会校验失败）──
  {
    msync: {
      const cachePath = `${HOME}/.config/dshgo-connect-madao/models-cache.json`
      const broken = { at: Date.now(), models: [{ id: 'glm-5.3', name: 'GLM-5.3', context: 1024, maxOutput: 512, strengths: ['bogus', 'off', 'high'], known: true }] }
      writeFileSync(cachePath, JSON.stringify(broken), 'utf8')
      const b6 = createBridge({ port: 8834, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
      bridges.push(b6)
      assert.deepEqual(b6.state.models[0].strengths, ['high'], '非法档位应从缓存里滤掉')
      console.log('· 模型缓存：非法档位被过滤')
    }
  }

  // ── 19. 旧缓存里的 maxOutput 超上限：读进来就压回，别绕过 max_tokens 收敛 ──
  {
    const cachePath = `${HOME}/.config/dshgo-connect-madao/models-cache-legacy.json`
    writeFileSync(
      cachePath,
      JSON.stringify({ at: Date.now(), models: [{ id: 'mock-fast', name: 'Mock-Fast', context: 202752, maxOutput: 65536, images: true, strengths: [], known: true }] }),
      'utf8',
    )
    const b7 = createBridge({ port: 8835, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0, modelCache: cachePath })
    assert.equal(b7.state.modelsSource, 'cache')
    assert.equal(b7.state.models[0].maxOutput, 32768, '旧缓存里的 65536 应压回上限')
    console.log('· 模型缓存：旧缓存里的超大 maxOutput 被压回上限')
  }

  // ── 20. 流式续传帧没 index：桥接要补上，别让客户端拆成两个调用 ──
  {
    mock.control.toolNoIndex = true
    const r6 = await realFetch('http://127.0.0.1:8820/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({
        model: 'mock-fast',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
      }),
    })
    assert.equal(r6.status, 200)
    const frames = (await r6.text())
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data:') && !block.includes('[DONE]'))
      .map((block) => JSON.parse(block.slice(5)))
    const calls = frames.filter((f) => f.choices?.[0]?.delta?.tool_calls).flatMap((f) => f.choices[0].delta.tool_calls)
    assert.equal(calls.length, 2, '两帧工具调用都应转发')
    assert.deepEqual(calls.map((c) => c.index), [0, 0], '续传帧缺 index 时应沿用上一个调用：' + JSON.stringify(calls))
    mock.control.toolNoIndex = false
    console.log('· 流式工具调用：缺 index 的续传帧补成同一个调用')
  }

  // ── 21. 令牌没有 expiresAt：上游 401 时换 STS 重试 ──────────────
  {
    process.env.MADAO_AK = AK
    process.env.MADAO_SK = SK
    process.env.MADAO_SECURITY_TOKEN = TOKEN
    delete process.env.MADAO_SECURITY_TOKEN_EXPIRES
    const b8 = createBridge({ port: 8836, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
    bridges.push(b8)
    await b8.listen()
    assert.equal(await b8.connect(), true)
    assert.equal(b8.state.tokenOnly, 0, '没有 expiresAt 时无法预判过期')
    assert.equal((await b8.syncModels()).ok, true)
    const iamBefore401 = iamCalls
    mock.control.auth401Once = true
    const r7 = await realFetch('http://127.0.0.1:8836/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r7.status, 200, '401 后应换 STS 重试成功：' + (await r7.text()))
    assert.equal(mock.control.auth401Once, false, '模拟网关的 401 只该发一次')
    assert.ok(iamCalls > iamBefore401, '应重新走 IAM 换 STS')
    assert.ok(b8.state.sts, '改走 STS 后要保留缓存以便续期')
    delete process.env.MADAO_SECURITY_TOKEN
    delete process.env.MADAO_AK
    delete process.env.MADAO_SK
    console.log('· 没有 expiresAt 的令牌：上游 401 后自动换 STS 重试')
  }

  // ── 22. 握手失败：自动退避重连，不用用户再点一次 ────────────────
  {
    process.env.MADAO_AK = AK
    process.env.MADAO_SK = SK
    delete process.env.MADAO_SECURITY_TOKEN
    iamFail = 1
    const b9 = createBridge({ port: 8837, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0, reconnectBaseMs: 200 })
    bridges.push(b9)
    await b9.listen()
    const first = await realFetch('http://127.0.0.1:8837/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(first.status, 503, 'IAM 失败时当次请求应是 503')
    assert.ok(b9.status().reconnectFailures >= 1, '应记下握手失败次数')
    assert.ok(b9.status().nextReconnectAt > 0, '应安排下一次自动重连')
    for (let i = 0; i < 60 && !b9.state.client; i++) await wait(50)
    assert.ok(b9.state.client, '应自动重连成功')
    for (let i = 0; i < 40 && !b9.state.models.some((m) => m.id === 'mock-fast'); i++) await wait(50)
    assert.equal(b9.status().reconnectFailures, 0)
    assert.equal(b9.status().nextReconnectAt, undefined)
    const second = await realFetch('http://127.0.0.1:8837/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(second.status, 200, '重连成功后对话应恢复')
    await second.text()
    delete process.env.MADAO_AK
    delete process.env.MADAO_SK
    console.log('· 握手失败：自动退避重连，恢复后对话可用')
  }

  // ── 23. 换账号：旧账号的额度 / 签到 / 心跳记录不能留在面板上 ────
  {
    process.env.MADAO_AK = AK
    process.env.MADAO_SK = SK
    process.env.MADAO_SECURITY_TOKEN = TOKEN
    process.env.MADAO_SECURITY_TOKEN_EXPIRES = new Date(Date.now() + 3600e3).toISOString()
    const b10 = createBridge({ port: 8838, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 0 })
    bridges.push(b10)
    await b10.listen()
    assert.equal(await b10.connect(), true)
    await b10.refreshCredit({ force: true })
    await b10.refreshCheckin({ force: true })
    assert.equal(b10.status().credit.remain, 380)
    assert.ok(b10.status().checkin)
    // 模拟「上一次连的是另一个账号」：把已加载的 AK 改掉，再走一次 connect
    b10.state.loaded = { ...b10.state.loaded, key: { ...b10.state.loaded.key, ak: 'ANOTHERAK0000000000' } }
    b10.state.heartbeatFailures = 3
    b10.state.heartbeatError = 'HTTP 500'
    assert.equal(await b10.connect(), true)
    assert.equal(b10.status().credit, null, '换账号后旧余额必须清掉')
    assert.equal(b10.status().creditError, null)
    assert.equal(b10.status().checkin, null, '换账号后旧签到状态必须清掉')
    assert.equal(b10.status().heartbeatFailures, 0, '换客户端后心跳失败应重新计数')
    assert.equal(b10.status().heartbeatError, null)
    // 同一账号重连不该清额度（额度刷新有 2 秒最小间隔）
    await wait(2100)
    await b10.refreshCredit({ force: true })
    assert.equal(b10.status().credit.remain, 380)
    assert.equal(await b10.connect(), true)
    assert.equal(b10.status().credit.remain, 380, '同一账号重连不该清额度')
    delete process.env.MADAO_SECURITY_TOKEN
    delete process.env.MADAO_SECURITY_TOKEN_EXPIRES
    delete process.env.MADAO_AK
    delete process.env.MADAO_SK
    console.log('· 换账号：旧额度 / 签到 / 心跳记录被清掉，同账号重连保留')
  }

  console.log('\n✅ 回归通过：额度容错 / 状态条 / 档位规则 / 工具调用 / 413 / 签到 / 缓存 / 凭证 / max_tokens / 图片 / CRLF / 心跳 / 401 自救 / 自动重连 / 换账号清旧状态')
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