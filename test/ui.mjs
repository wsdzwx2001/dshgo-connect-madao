// 原生界面冒烟：用假的 dshGo / configEditor 加载插件，
// 检查状态条、面板数据、凭证表单解析、签到、STS 续期、provider 注册。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startMock } from './mock-gateway.mjs'

const MOCK = 8794
const AK = 'TESTAKTESTAKTESTAK00'
const SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const patchBackup = readFileSync(PATCH, 'utf8')
const FAKE_HOME = '/tmp/fakehome-madao'
const CREDS = `${FAKE_HOME}/.config/dshgo-connect-madao/credentials.json`
rmSync(FAKE_HOME, { recursive: true, force: true })
mkdirSync(FAKE_HOME, { recursive: true })
process.env.HOME = FAKE_HOME
delete process.env.MADAO_AK
delete process.env.MADAO_SK

// 拦掉真实 IAM：返回与模拟网关同一套临时凭证，顺便验证 STS 请求确实带了签名。
const realFetch = globalThis.fetch
let iamCalls = 0
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input)
  if (url.includes('iam.cn-north-4.myhuaweicloud.com')) {
    iamCalls++
    assert.match(String(init?.headers?.Authorization ?? ''), /^SDK-HMAC-SHA256 Access=/)
    assert.equal(JSON.parse(init.body).auth.identity.methods[0], 'token')
    return new Response(
      JSON.stringify({ credential: { access: AK, secret: SK, securitytoken: 'test-security-token', expires_at: new Date(Date.now() + 3600e3).toISOString() } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return realFetch(input, init)
}

const mock = await startMock(MOCK)
const regs = { strips: [], handlers: new Map(), panels: new Map() }
let cancelStrip
let emitted
const edits = []
const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'custom-x': { displayName: '自定义', api: 'openai-completions' } } } } }
const fakeEditor = {
  entries: () => [entry],
  canWrite: () => true,
  edit: async (target, change) => {
    const next = await change(structuredClone(target.options.config))
    target.options.config = next
    edits.push(next)
  },
}
const fakeCtx = {
  effect: () => {},
  inject: (names, fn) =>
    fn({
      dshGo: {
        strip: (id, def) => regs.strips.push({ id, def }),
        on: (id, fn2) => regs.handlers.set(id, fn2),
        panel: (id, def) => regs.panels.set(id, def),
      },
      configEditor: fakeEditor,
    }),
}

const { apply } = await import('../lib/index.js')
const { bridge } = apply(fakeCtx, { port: 8796, gateway: `http://127.0.0.1:${MOCK}`, refreshMs: 250 })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await wait(400)
  // 只保留状态条 + 面板，不再注册输入框胶囊
  assert.equal(regs.strips.length, 1)
  assert.equal(regs.handlers.size, 0, '不应再有胶囊处理器')
  const panel = regs.panels.get('madao')
  const credsPanel = regs.panels.get('creds')
  assert.ok(panel && credsPanel, '应有两个面板')
  const strip = regs.strips[0].def
  const snapshot = () => new Promise((resolve) => panel.data({}, resolve, { locale: 'zh-CN' }))
  const emitStrip = () => strip({}, (v) => (emitted = v), { locale: 'zh-CN' })

  // 主面板不再放凭证表单（表单在「码道凭证」页），只留入口按钮
  const mainView = JSON.stringify(panel.view({}, { locale: 'zh-CN' }))
  assert.ok(!mainView.includes('"form"'), '主面板不应再有凭证表单')
  const credsView = JSON.stringify(credsPanel.view)
  assert.ok(credsView.includes('"maxLength":128') && credsView.includes('"maxLength":256'), '凭证页保留长度提示')

  // 未配凭证：状态条说人话，面板数据不崩，也没有多余提示条
  emitStrip()
  assert.equal(emitted.text, '码道 未就绪')
  assert.equal(emitted.tone, 'warn')
  const empty = await snapshot()
  assert.equal(empty.statusText, '未配置凭证')
  assert.equal(empty.source, '未配置')
  assert.equal(empty.remain, '-')
  assert.ok(panel.view({}, { locale: 'zh-CN' }).children.at(-1).items.length >= 1, '模型清单要有兜底项')

  // 凭证表单：嵌套 / 扁平 / 再嵌套三种结构都要能读出来
  const save = (value) => credsPanel.actions.save({}, { value })
  let sr = await save({ values: { akInput: AK, skInput: SK } })
  assert.match(sr.toast, /已保存/)
  assert.deepEqual(JSON.parse(readFileSync(CREDS, 'utf8')), { ak: AK, sk: SK })
  sr = await save({ ak: AK, sk: SK })
  assert.match(sr.toast, /已保存/)
  sr = await save({ data: { akInput: AK, skInput: SK } })
  assert.match(sr.toast, /已保存/)
  sr = await save({ nonsense: 'x' })
  assert.match(sr.toast, /没读到 AK\/SK/)
  await wait(2200)

  // 状态条：已连上且今日可签到
  emitStrip()
  assert.match(emitted.text, /^码道 可签到( · 剩 380)?$/, JSON.stringify(emitted))
  assert.equal(emitted.tone, 'info')

  // provider 已写进 llm-pi-ai：原有自定义 provider 保留，码道模型来自网关
  assert.ok(edits.length >= 1, '应写过 provider 配置')
  const providers = edits.at(-1).providers
  assert.equal(providers['custom-x'].displayName, '自定义')
  assert.equal(providers['madao-go'].baseURL, 'http://127.0.0.1:8796/v1')
  assert.equal(providers['madao-go'].models.length, 2)
  assert.equal(providers['madao-go'].models[1].reasoningEfforts.high, 'high')

  // 模型开关：点行停用 / 启用，provider 与 patch 跟着变，至少留一个
  const viewNow = () => panel.view({}, { locale: 'zh-CN', protocol: 1 })
  let rows = viewNow().children.at(-1).items
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r.subtitle.startsWith('mock-fast')).trailing, '已启用')
  const act = (id) => panel.actions[`model:${id}`]
  let tr = await act('mock-fast')()
  assert.match(tr.toast, /已停用 Mock-Fast/)
  await wait(700)
  assert.equal(edits.at(-1).providers['madao-go'].models.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(`${FAKE_HOME}/.config/dshgo-connect-madao/models.json`, 'utf8')).disabled, ['mock-fast'])
  rows = viewNow().children.at(-1).items
  assert.equal(rows.find((r) => r.subtitle.startsWith('mock-fast')).trailing, '已停用')
  assert.match(await (async () => (await act('mock-pro')()).toast)(), /至少留一个/)
  tr = await act('mock-fast')()
  assert.match(tr.toast, /已启用 Mock-Fast/)
  await wait(700)
  assert.equal(edits.at(-1).providers['madao-go'].models.length, 2)
  console.log('模型开关：停用/启用/至少留一个 都正常')

  // 签到：可领 → 成功 → 再签提示已签
  let out = await panel.actions.checkin()
  assert.match(out.toast, /签到成功 \+10/, JSON.stringify(out))
  assert.equal(bridge.state.checkin.status, 'CONFIRMED')
  assert.equal(bridge.state.checkin.claimable, false, '签完不该再显示可签到')
  emitStrip()
  assert.doesNotMatch(emitted.text, /可签到/)
  out = await panel.actions.checkin()
  assert.match(out.toast, /今日已签到/, JSON.stringify(out))
  const after = await snapshot()
  assert.equal(after.source, '已配置')
  assert.equal(after.checkin, '已到账')
  assert.equal(after.checkinReward, '10 积分')
  emitStrip()
  assert.equal(emitted.text, '码道 剩 380', '签完应回到额度')
  assert.equal(emitted.tone, 'good')

  // 关思考被网关拒绝：自动去掉 off 档并用默认思考重发
  const off = await fetch('http://127.0.0.1:8796/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-fast', stream: false, strength: 'off', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(off.status, 200, '关思考被拒不等于对话失败')
  assert.equal((await off.json()).choices[0].message.content, '你好，mock-fast。第二段。')
  assert.ok(bridge.state.noOff.has('mock-fast'), '应记住该模型不支持关思考')
  await wait(700)
  assert.equal('off' in edits.at(-1).providers['madao-go'].models.find((m) => m.id === 'mock-pro')?.reasoningEfforts ?? {}, true)
  const fastPrefix = edits.at(-1).providers['madao-go'].models.find((m) => m.id === 'mock-fast')
  assert.equal(fastPrefix ? 'off' in (fastPrefix.reasoningEfforts || {}) : false, false, 'mock-fast 的 off 档应被移除')

  // 面板按钮（测试/同步会同时刷新两个面板，返回的是效果数组）
  const toastOf = (r) => (Array.isArray(r) ? r.find((x) => x.toast)?.toast : r.toast)
  const testEff = await panel.actions.test()
  assert.match(toastOf(testEff), /五项全绿/)
  assert.deepEqual(testEff.filter((x) => x.refresh).map((x) => x.refresh).sort(), ['creds', 'madao'])
  assert.equal((await panel.actions.openCreds()).open, 'panel:creds')
  assert.match(toastOf(await panel.actions.sync()), /2 个模型/)

  // 额度自动刷新：不再有按钮，靠桥接定时拉
  const creditCalls = () => mock.seen.filter((r) => r.path === '/snap-manager/v1/statistics/plugin').length
  await wait(300)
  const before = creditCalls()
  await wait(700)
  assert.ok(creditCalls() > before, `额度应自动刷新（${before} → ${creditCalls()}）`)
  assert.equal(bridge.status().credit.remain, 380)
  console.log('额度自动刷新：', before, '→', creditCalls(), '次')

  // STS 到期后自动续期并重建客户端
  bridge.state.sts.value.expiresAt = new Date(Date.now() - 1000).toISOString()
  const iamBefore = iamCalls
  const chat = await fetch('http://127.0.0.1:8796/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-fast', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(chat.status, 200)
  assert.equal((await chat.json()).choices[0].message.content, '你好，mock-fast。第二段。')
  assert.ok(iamCalls > iamBefore, 'STS 过期后应重新换一次')

  console.log('\n✅ 原生界面冒烟通过：状态条 / 面板 / 凭证表单 / 签到 / provider / STS 续期')
} finally {
  cancelStrip?.()
  writeFileSync(PATCH, patchBackup, 'utf8') // 同步 mock 模型清单会改 patch，跑完还原
  await bridge.close().catch(() => {})
  await mock.close()
}
cancelStrip = null
process.exit(0)