// dsh-go 原生插件：把码道（华为云 CodeArts Agent）接入 DSH。
// 宿主侧起一个本机 OpenAI 兼容桥，App 侧提供状态条、面板和输入框胶囊。
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BRIDGE_TOKEN, PORT, PROVIDER, createBridge, saveCredentials } from './bridge.js'
import { effortsFor } from './efforts.js'

export const name = 'dshgo-connect-madao'
export const inject = []

const CONFIG_DIR = join(homedir(), '.config', 'dshgo-connect-madao')
const MODEL_FILE = join(CONFIG_DIR, 'models.json')
const DEBUG_DIR = CONFIG_DIR

const zh = (locale) => !String(locale ?? '').startsWith('en')

const modelPrefs = (() => {
  try {
    const raw = JSON.parse(readFileSync(MODEL_FILE, 'utf8'))
    return {
      disabled: new Set(Array.isArray(raw?.disabled) ? raw.disabled : []),
      // 0.1.4 及以前存过"关不掉思考"的记录；现在由 lib/efforts.js 的规则表决定档位，
      // 这个字段只保留在文件里不删（不擅自清用户数据），但不再参与判断。
      legacy: raw && typeof raw === 'object' ? raw : {},
    }
  } catch {
    return { disabled: new Set(), legacy: {} }
  }
})()
/** 被停用的模型 id；默认全部启用。 */
const disabledModels = modelPrefs.disabled
const modelEnabled = (id) => !disabledModels.has(id)

function saveModelPrefs() {
  const tmp = `${MODEL_FILE}.tmp-${process.pid}`
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    const data = { ...modelPrefs.legacy, disabled: [...disabledModels] }
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, MODEL_FILE)
  } catch (err) {
    console.log(`[dshgo-connect-madao] 保存模型设置失败：${String(err?.message ?? err).slice(0, 120)}`)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
}

const statusText = (status, en) =>
  ({
    ELIGIBLE: en ? 'available' : '可领取',
    CLAIMED: en ? 'pending' : '待确认',
    CONFIRMED: en ? 'received' : '已到账',
    CONSUMED: en ? 'used' : '已用完',
  })[status] ?? (status ? String(status) : '-')

/** 只描述结构、不落密钥：字段名 + 值长度。 */
function describeShape(value, depth = 0) {
  if (value == null) return typeof value
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value !== 'object' || depth > 3) return typeof value
  if (Array.isArray(value)) return `array(${value.length})[${value.slice(0, 2).map((v) => describeShape(v, depth + 1)).join(',')}]`
  return `{${Object.entries(value).slice(0, 8).map(([k, v]) => `${k}:${describeShape(v, depth + 1)}`).join(',')}}`
}

/** 表单/回传结构对不上时留一份记录，方便排查；只记结构，不记密钥。 */
const DEBUG_LOG_MAX = 256 * 1024
function writeDebug(kind, payload) {
  const file = join(DEBUG_DIR, 'panel.log')
  try {
    mkdirSync(DEBUG_DIR, { recursive: true, mode: 0o700 })
    try {
      if (statSync(file).size > DEBUG_LOG_MAX) {
        // 只保留上一份，别把正在排查的记录整份清掉。
        renameSync(file, `${file}.1`)
      }
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${kind} ${JSON.stringify(payload).slice(0, 800)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

/** 同一个原因只打一行日志：启动补写失败时会循环几十次，别刷屏。 */
const loggedReasons = new Set()
function logOnce(key, message) {
  if (loggedReasons.has(key)) return
  loggedReasons.add(key)
  console.log(`[dshgo-connect-madao] ${message}`)
}

/** provider profile：llm-pi-ai 认的形状，和 cordis.patch.yml 里那段一致。 */
function providerProfile(models, port) {
  return {
    displayName: '码道 CodeArts',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${port}/v1`,
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    models: models
      .filter((m) => modelEnabled(m.id) && Number.isFinite(m.context) && m.context > 0 && Number.isFinite(m.maxOutput) && m.maxOutput > 0)
      .map((m) => ({
        id: m.id,
        name: m.ratio ? `${m.name} · ${m.ratio}` : m.name,
        contextWindow: m.context,
        maxTokens: m.maxOutput,
        input: m.images ? ['text', 'image'] : ['text'],
        // 档位由 lib/efforts.js 的规则表决定：规则表 → 网关声明 → 默认三档（不思考/高/最高）。
        reasoningEfforts: effortsFor(m.id, m.strengths, m.known),
      })),
  }
}

/**
 * 把 madao-go 注册进 llm-pi-ai 的配置。
 *
 * 只写 bundle patch 不够：profile 自己的 cordis.patch.yml 会整段替换 llm-pi-ai 的 config，
 * 把这个 provider 抹掉。所以走 configEditor（和网页「模型」页同一条写入路径）：
 * 合并进现有 providers，落盘一次，Loader 热重载后模型列表即出现。
 *
 * 返回的函数带 `.flush()`：立即写一次（启动补写用，不依赖状态条是否被渲染）。
 */
function registerProvider(ctx) {
  let editor = null
  let models = []
  let port = PORT
  // dsh-hmr 的 executing 是 AsyncLocalStorage：在 HMR 事务里调用 configEditor.edit
  // 会被 runExclusive 判为 nested。启动（干净 boot）和用户动作是安全的；热重载里跳过。
  const inHmrTransaction = () => {
    try {
      return Boolean(ctx.get?.('hmr')?.executing?.getStore?.())
    } catch {
      return false
    }
  }
  const run = async () => {
    if (!editor || models.length === 0 || inHmrTransaction()) return false
    try {
      return await writeProvider(editor, models, port)
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 160)
      logOnce(`run-failed:${message.slice(0, 60)}`, `更新 provider 失败：${message}`)
      return false
    }
  }
  ctx.inject(['configEditor'], (editorCtx) => {
    const service = editorCtx.configEditor
    if (!service || typeof service.edit !== 'function') return
    editor = service
  })
  // 连续切换模型开关时把写配置合并成一次，避免多次编辑互相踩。
  let timer = null
  let queue = Promise.resolve()
  const schedule = (next, nextPort) => {
    models = next ?? models
    port = nextPort ?? port
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      queue = queue.then(run).catch(() => {})
    }, 400)
  }
  schedule.flush = async (next, nextPort) => {
    models = next ?? models
    port = nextPort ?? port
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return run()
  }
  return schedule
}

/**
 * 写 provider；成功或已一致返回 true，被 HMR / 覆盖挡住或失败返回 false。
 * 回读不一致时重试一次。
 */
function writeProvider(editor, models, port, attempt = 0) {
  const entry = editor.entries().find((e) => e.options.id === 'llm-pi-ai')
  if (!entry) {
    logOnce('no-llm-pi-ai', '没找到 llm-pi-ai，模型不会出现在选择器里')
    return false
  }
  const want = providerProfile(models, port)
  if (want.models.length === 0) {
    logOnce('no-models', '没有可用的模型，暂不写 provider 配置')
    return false
  }
  const same = (value) => JSON.stringify(value) === JSON.stringify(want)
  if (same(entry.options.config?.providers?.[PROVIDER])) return true
  if (typeof editor.canWrite === 'function' && !editor.canWrite(entry)) {
    logOnce('overridden', 'profile 配置被更高层 patch 覆盖，需要在模型页手动添加 provider')
    return false
  }
  return editor
    .edit(entry, (current, inherited) => {
      // 注意：profile patch 的 config 是整段替换（不是深合并），所以这里必须把现有 providers
      // 一起带上，否则别人家的 provider 会被这一行抹掉；bundle 层新增的 provider 也顺手补进来。
      const bundled = (inherited && inherited.providers) || {}
      return { ...current, providers: { ...bundled, ...(current.providers ?? {}), [PROVIDER]: want } }
    })
    .then(() => {
      const ok = same(entry.options.config?.providers?.[PROVIDER])
      console.log(`[dshgo-connect-madao] 已把 ${PROVIDER} 写进 profile 配置（${want.models.length} 个模型${ok ? '' : '，回读未生效'}）`)
      if (!ok && attempt < 2) setTimeout(() => writeProvider(editor, models, port, attempt + 1), 1200 * (attempt + 1))
      return ok || attempt >= 2
    })
    .catch((err) => {
      const message = String(err?.message ?? err)
      // 竞态下仍可能撞进 HMR：静默跳过，用户动作/重启会补写。
      if (/HMR transactions cannot be nested/i.test(message)) return false
      logOnce(`write-failed:${message.slice(0, 60)}`, `写 provider 失败：${message.slice(0, 200)}`)
      if (attempt < 2) setTimeout(() => writeProvider(editor, models, port, attempt + 1), 1200 * (attempt + 1))
      return false
    })
}

export function apply(ctx, config = {}) {
  const bridge = createBridge({
    port: Number(config.port ?? process.env.MADAO_PORT ?? PORT),
    gateway: config.gateway ?? process.env.MADAO_GATEWAY,
    refreshMs: Number(config.refreshMs ?? 15_000),
    onChange: () => notify(),
  })

  // dshGo 就绪后由它接管：主动重取两个面板的数据（凭证页平时不推送）
  let refreshPanels = () => {}
  const listeners = new Set()
  const credsListeners = new Set()
  const notify = () => {
    for (const fn of listeners) {
      try {
        fn()
      } catch {}
    }
  }

  const ensureProvider = registerProvider(ctx)

  const started = (async () => {
    // 热重载时上一个实例可能还占着端口，退让重试几次再放弃。
    let ready = null
    for (let attempt = 0; attempt < 4 && ready === null; attempt++) {
      try {
        ready = await bridge.listen()
      } catch (err) {
        if (attempt === 3) {
          console.log(`[dshgo-connect-madao] 桥接未启动（端口 ${bridge.status().port}）：${err?.message ?? err}`)
          return
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      }
    }
    console.log(`[dshgo-connect-madao] 桥接已就绪 ${ready}/v1`)
    if (await bridge.connect()) {
      // 模型清单同步放到后台：拉网关可能几秒，不该拦着引擎启动。
      bridge
        .syncModels()
        .then((r) => {
          if (!r.ok) {
            console.log(`[dshgo-connect-madao] 模型清单同步失败（保留现有清单）：${r.error}`)
            return
          }
          console.log(`[dshgo-connect-madao] 模型清单 ${r.models} 个（${r.source}）`)
        })
        .catch(() => {})
        .finally(() => {
          void bridge.refreshCredit().finally(() => refreshPanels(false))
          void bridge.refreshCheckin()
          void bootstrapProvider()
        })
    }
  })()

  /**
   * 启动时补写 / 迁移 provider。
   *
   * 以前这段挂在状态条回调里：用户把输入框胶囊隐藏、或从不进聊天页，升级后 provider
   * 就永远不会被补写。现在改成独立的后台尝试，最多约 60 秒；HMR 事务里自动跳过，
   * 有缓存清单也能写。
   */
  let providerBootstrapped = false
  async function bootstrapProvider() {
    for (let i = 0; i < 30 && !providerBootstrapped && !disposed; i++) {
      if (bridge.state.modelsSource === 'fallback' || bridge.state.models.length === 0) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      if (await ensureProvider.flush(bridge.state.models, bridge.status().port)) {
        providerBootstrapped = true
        return
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    // 具体原因上面已经各打了一次；这里只说明"放弃了"，避免 60 秒里刷 30 行。
    if (!providerBootstrapped && !disposed) {
      logOnce('provider-give-up', '启动补写 provider 未成功（原因见上一条）；保存凭证或点「同步模型」会重试')
    }
  }

  let disposed = false
  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => () => {
        disposed = true
        void bridge.close().catch(() => {})
      },
      'dshgo-connect-madao: 本机 OpenAI 兼容桥',
    )
  }

  /** 保存凭证 → 重连 → 拉模型 → 注册 provider → 自检。 */
  const saveCreds = async (ak, sk) => {
    await saveCredentials(ak, sk)
    void bridge
      .reload()
      .then(async (ok) => {
        if (!ok) return
        const synced = await bridge.syncModels()
        if (synced.ok) ensureProvider(bridge.state.models, bridge.status().port)
        await bridge.test()
      })
      .finally(() => refreshPanels())
  }

  /** 从表单提交的 value 里尽量捞出 AK / SK（不同 App 版本可能包一层）。 */
  function readCreds(value) {
    const found = []
    const walk = (v, depth, key) => {
      if (v == null || depth > 4) return
      if (typeof v === 'string') {
        const text = v.trim()
        if (text.length >= 16 && text.length <= 200) found.push({ key: String(key ?? ''), text })
        return
      }
      if (typeof v !== 'object') return
      for (const [k, x] of Object.entries(v)) walk(x, depth + 1, k)
    }
    walk(value, 0, null)
    // 先认明确字段名（akInput / skInput / accessKeyId …），找不到才退回按长度猜。
    // 全靠猜时，宿主回传里任何一个长字符串都可能被当成 AK，写坏原本可用的凭证。
    const pick = (re) => found.find((f) => re.test(f.key))?.text
    let ak = pick(/^(?:[A-Za-z0-9_-]+\.)*(?:akInput|ak|accessKeyId|access_key_id|accessKey)$/i)
    let sk = pick(/^(?:[A-Za-z0-9_-]+\.)*(?:skInput|sk|secretAccessKey|secret_access_key|secretKey)$/i)
    if (!ak || !sk) {
      const isSk = (f) => /(^|[^a-z])sk($|[^a-z])|secret/i.test(f.key)
      const isAk = (f) => !isSk(f) && /ak|access|key|id/i.test(f.key)
      ak ??= (found.find(isAk) ?? found[0])?.text
      sk ??= (found.find((f) => isSk(f) && f.text !== ak) ?? found.find((f) => f.text !== ak))?.text
    }
    if (!ak || !sk || ak === sk) return null
    if (ak.length < 10 || sk.length < 20) return null
    return { ak, sk }
  }

  ctx.inject(['dshGo'], (ctx) => {
    refreshPanels = (includeCreds = true) => {
      // 主面板本来就订阅了 listeners；凭证页只在保存/测试/同步完成后推一次。
      // 启动同步不推凭证页，避免把输入到一半的内容刷掉。
      if (includeCreds) {
        for (const fn of credsListeners) {
          try {
            fn()
          } catch {}
        }
      }
      try {
        ctx.dshGo.refresh?.('madao')
      } catch {}
    }
    const snapshot = (locale) => {
      const s = bridge.status()
      const en = !zh(locale)
      const c = s.credit
      const ck = s.checkin
      // 只有“硬”步骤（凭证 / 协商 / 模型清单）失败才算自检失败；
      // 额度 / 签到失败只提示，不让状态条一直红；成功后 test.stale 会把旧失败压下去。
      const testFailed = Boolean(s.test && s.test.ok === false && !s.test.stale && !s.testing)
      // 软步骤（额度 / 签到）失败只做提示；自检被后续成功证据标记 stale 后不再提示。
      const softStep = s.test?.stale ? null : (s.test?.steps ?? []).find((x) => x.optional && !x.ok)
      const creditError = s.creditError ? String(s.creditError) : ''
      const checkinError = s.checkinError ? String(s.checkinError) : ''
      const credentialError = Boolean(s.error && !/还没有码道凭证/.test(String(s.error)))
      return {
        statusText: s.testing
          ? en ? 'Testing…' : '检测中…'
          : testFailed
            ? en ? 'Check failed' : '自检失败'
            : s.stage === 'bridge'
              ? en ? 'Bridge port busy' : '桥接端口被占用'
              : s.ok
                ? en ? 'Ready' : '就绪'
                : s.stage === 'handshake'
                  ? en ? 'Handshake failed' : '握手失败'
                  : credentialError
                    ? en ? 'Credential error' : '凭证错误'
                    : en ? 'No credentials' : '未配置凭证',
        source: s.configured ? (en ? 'configured' : '已配置') : en ? 'not set' : '未配置',
        ak: s.ak ?? '-',
        sts: s.stsUntil ? String(s.stsUntil).slice(0, 19).replace('T', ' ') : s.ok ? (en ? 'not needed' : '免 STS') : '-',
        models: `${bridge.state.models.filter((m) => modelEnabled(m.id)).length}/${s.models}`,
        modelsSource:
          s.modelsSource === 'gateway'
            ? en ? 'gateway' : '网关'
            : s.modelsSource === 'cache'
              ? en ? 'cached' : '上次同步'
              : en ? 'built-in' : '内置兜底',
        port: `127.0.0.1:${s.port}`,
        errorText: credentialError
          ? String(s.error).slice(0, 120)
          : testFailed
            ? String((s.test.steps ?? []).find((x) => !x.ok)?.detail ?? '自检失败').slice(0, 120)
            : softStep
              ? `${softStep.name}：${String(softStep.detail ?? '').slice(0, 100)}`
              : creditError
                ? `额度：${creditError.slice(0, 110)}`
                : checkinError
                  ? `签到：${checkinError.slice(0, 110)}`
                  : s.heartbeatFailures > 0 && s.heartbeatError
                    ? `心跳：${String(s.heartbeatError).slice(0, 110)}`
                    : '-',
        remain: c ? c.remain : '-',
        caption: c
          ? en
            ? `total ${c.total} · used ${c.used}${c.expiring ? ` · expiring ${c.expiring}` : ''}`
            : `共 ${c.total} · 已用 ${c.used}${c.expiring ? ` · 即将过期 ${c.expiring}` : ''}`
          : creditError
            ? en ? `query failed: ${creditError.slice(0, 40)}` : `查询失败：${creditError.slice(0, 40)}`
            : en
              ? 'auto-refreshing'
              : '自动刷新中…',
        checkin: ck
          ? ck.available
            ? ck.claimable
              ? en ? 'claimable' : '今日可领'
              : statusText(ck.status, en)
            : en ? 'unavailable' : '无签到活动'
          : checkinError
            ? en ? 'query failed' : '查询失败'
            : en ? 'not fetched' : '未查询',
        checkinReward: !ck?.available
          ? '-'
          : ck.amount > 0
            ? `${ck.amount} ${ck.unit === 'CREDIT' ? (en ? 'credits' : '积分') : ck.unit}`
            : ck.claimable
              ? en ? 'pending claim' : '待领取'
              : en ? 'claimed' : '已领取',
        // stale 表示后来有成功证据（对话 / 额度 / 同步）推翻了这次失败：
        // 状态已经回到「就绪」，步骤表就别再挂红叉自相矛盾。
        steps: (s.test?.steps ?? [])
          .filter((x) => x.ok || !s.test?.stale)
          .map((x) => ({
            label: x.name,
            status: x.ok ? 'done' : 'failed',
            detail: x.detail ? String(x.detail).slice(0, 80) : undefined,
          })),
      }
    }

    const stripText = (locale) => {
      const s = bridge.status()
      const en = !zh(locale)
      const c = s.credit
      if (s.testing) return { text: en ? 'Madao testing…' : '码道 检测中…', tone: 'info' }
      if (s.test?.ok === false && !s.test.stale) return { text: en ? 'Madao check failed' : '码道 自检失败', tone: 'warn' }
      if (s.stage === 'bridge') return { text: en ? 'Madao port busy' : '码道 端口被占用', tone: 'warn' }
      if (!s.ok) return { text: en ? 'Madao off' : '码道 未就绪', tone: 'warn' }
      const tail = c ? (en ? ` · ${c.remain}` : ` · 剩 ${c.remain}`) : ''
      if (s.checkin?.available && s.checkin.claimable) return { text: `${en ? 'Madao sign-in' : '码道 可签到'}${tail}`, tone: 'info' }
      if (!c && s.creditError) return { text: en ? 'Madao ready · quota error' : '码道 就绪 · 额度异常', tone: 'info' }
      return { text: c ? (en ? `Madao ${c.remain}` : `码道 剩 ${c.remain}`) : en ? 'Madao ready' : '码道 就绪', tone: 'good' }
    }

    // 输入框上方的状态胶囊：一句话状态，点开就是这个统一面板。
    ctx.dshGo.strip('state', (scope, emit, caps) => {
      const push = () => {
        const { text, tone } = stripText(caps?.locale)
        emit({ text: [...text].slice(0, 24).join(''), icon: 'globe', tone })
      }
      push()
      const timer = setInterval(push, 60_000)
      listeners.add(push)
      return () => {
        clearInterval(timer)
        listeners.delete(push)
      }
    })

    // 每个模型一行的开关：点行即切换（动作 id 是 model:<模型 id>）
    const modelAction = (id) => `model:${id}`
    const buildModelRows = () =>
      bridge.state.models.map((m) => ({
        title: `${m.name}${m.ratio ? ` · ${m.ratio}` : ''}`,
        subtitle: `${m.id} · ${m.context} 上下文${m.images ? ' · 图片' : ''}`,
        trailing: modelEnabled(m.id) ? '已启用' : '已停用',
        tone: modelEnabled(m.id) ? 'good' : 'muted',
        action: modelAction(m.id),
      }))

    const toggleModel = async (id) => {
      const m = bridge.state.models.find((x) => x.id === id)
      if (!m) return { toast: '模型已不在清单里' }
      if (bridge.state.modelsSource === 'fallback') return { toast: '先填凭证，再调整模型' }
      const enabled = modelEnabled(id)
      if (enabled && bridge.state.models.filter((x) => modelEnabled(x.id)).length <= 1) {
        return { toast: '至少留一个模型启用' }
      }
      if (enabled) disabledModels.add(id)
      else disabledModels.delete(id)
      saveModelPrefs()
      const kept = bridge.state.models.filter((x) => modelEnabled(x.id))
      ensureProvider(kept, bridge.status().port)
      return { toast: `${enabled ? '已停用' : '已启用'} ${m.name}`.slice(0, 40), refresh: true }
    }

    // 慢动作交给宿主 pending：3 秒内先回，结果 60 秒内到。
    // 延后结果只允许 toast / patch / insert / copy，所以刷新面板用 refreshPanels() 侧效。
    const deferred = (label, work) => ({ pending: { label, timeoutMs: 60_000 }, result: work })
    const toast = (text) => ({ toast: String(text ?? '').slice(0, 40) })

    const actions = {
      openCreds: () => ({ open: 'panel:creds' }),
      test: () =>
        deferred('正在自检', async (signal) => {
          try {
            const r = await bridge.test(signal)
            if (signal?.aborted) return toast('已取消')
            refreshPanels()
            const bad = (r?.steps ?? []).find((x) => !x.ok)
            if (!r?.ok) return toast(`失败：${bad?.name ?? '自检'}`)
            if (r.warn && bad) return toast(`${bad.name}异常，其余正常`)
            return toast('五项全绿')
          } catch (err) {
            return toast(`自检失败：${String(err?.message ?? err)}`)
          }
        }),
      sync: () =>
        deferred('正在同步模型', async (signal) => {
          try {
            const r = await bridge.syncModels()
            if (signal?.aborted) return toast('已取消')
            if (!r.ok) return toast(`同步失败：${String(r.error ?? '未知错误')}`)
            ensureProvider(bridge.state.models, bridge.status().port)
            refreshPanels()
            return toast(`已拉到 ${r.models} 个模型`)
          } catch (err) {
            return toast(`同步失败：${String(err?.message ?? err)}`)
          }
        }),
      checkin: () =>
        deferred('正在签到', async (signal) => {
          try {
            const r = await bridge.checkin()
            if (signal?.aborted) return toast('已取消')
            refreshPanels()
            if (!r?.available) return toast(r?.reason ?? '没有签到活动')
            if (r.claimed) void bridge.refreshCredit({ force: true })
            const why = String(r.reason ?? '今日已签到').replace(/（.*?）/g, '')
            return toast(r.claimed ? `签到成功 +${r.amount}` : why)
          } catch (err) {
            return toast(`签到失败：${String(err?.message ?? err)}`)
          }
        }),
    }
    /** 模型清单会变，开关动作按需补挂。 */
    const ensureModelActions = () => {
      for (const m of bridge.state.models) {
        const key = modelAction(m.id)
        if (!actions[key]) actions[key] = () => toggleModel(m.id)
      }
    }

    ctx.dshGo.panel('madao', {
      view: () => {
        ensureModelActions()
        return {
          v: 2,
          type: 'stack',
          title: 'dshgo-connect-madao',
          children: [
            { type: 'keyValue', items: [
              ['状态', { $: 'data.statusText' }],
              ['凭证', { $: 'data.source' }],
              ['AK', { $: 'data.ak' }],
              ['STS', { $: 'data.sts' }],
              ['桥接', { $: 'data.port' }],
              ['模型', { $: 'data.models' }],
            ] },
            { type: 'metric', label: '剩余额度', value: { $: 'data.remain' }, caption: { $: 'data.caption' } },
            { type: 'divider' },
            { type: 'actions', items: [
              { label: '填写凭证', action: 'openCreds', icon: 'edit' },
              { label: '测试连接', action: 'test', icon: 'refresh' },
              { label: '同步模型', action: 'sync', icon: 'download' },
            ] },
            { type: 'divider' },
            { type: 'keyValue', items: [
              ['今日签到', { $: 'data.checkin' }],
              ['签到奖励', { $: 'data.checkinReward' }],
            ] },
            { type: 'actions', items: [
              { label: '立即签到', action: 'checkin', icon: 'calendar' },
            ] },
            { type: 'divider' },
            { type: 'steps', items: { $: 'data.steps' } },
            { type: 'list', items: buildModelRows() },
          ],
        }
      },
      data: (scope, emit, caps) => {
        // 打开面板时顺手拉一次（5 秒冷却），其余时间靠桥接定时刷新。
        // 额度接口出错后桥接会退避；用户主动打开面板时可以插队再试一次。
        if (Date.now() - (bridge.state.credit?.at ?? 0) > 5_000) void bridge.refreshCredit({ force: true })
        const push = () => emit(snapshot(caps?.locale))
        push()
        listeners.add(push)
        return () => listeners.delete(push)
      },
      actions,
    })

    // 凭证单独一页：这一页不做实时推送，输入到一半不会被刷掉
    ctx.dshGo.panel('creds', {
      view: (scope, caps) => {
        const components = Array.isArray(caps?.components) ? caps.components : null
        const canForm = !components || (components.includes('form') && components.includes('textField'))
        if (!canForm) {
          // 老 App 画不出 v2 表单：给一条能走通的说明，别让用户对着空页面。
          return {
            v: 1,
            type: 'stack',
            title: 'dshgo-connect-madao · 凭证',
            children: [
              { type: 'callout', text: '当前 App 版本不支持凭证表单，请先更新 dsh-go；也可以手动写 ~/.config/dshgo-connect-madao/credentials.json（ak / sk 两个字段，权限 600）。', tone: 'warn' },
              { type: 'keyValue', items: [
                ['当前 AK', { $: 'data.ak' }],
                ['状态', { $: 'data.statusText' }],
                ['最近错误', { $: 'data.errorText' }],
              ] },
            ],
          }
        }
        return {
          v: 2,
          type: 'stack',
          title: 'dshgo-connect-madao · 凭证',
          children: [
            { type: 'form', label: '凭证设置', submit: 'save', submitLabel: '保存并验证', children: [
              { type: 'textField', label: 'Access Key ID', bind: 'data.akInput', placeholder: '华为云 AK', required: true, maxLength: 128 },
              { type: 'textField', label: 'Secret Access Key', bind: 'data.skInput', placeholder: '华为云 SK', required: true, maxLength: 256 },
            ] },
            { type: 'keyValue', items: [
              ['当前 AK', { $: 'data.ak' }],
              ['状态', { $: 'data.statusText' }],
              ['最近错误', { $: 'data.errorText' }],
            ] },
          ],
        }
      },
      data: (scope, emit, caps) => {
        // 打开时推一次；之后只在保存凭证 / 连接完成时由 refreshPanels 再推。
        // 这里没有定时刷新，避免输入到一半被刷掉。
        // 不要在推送里塞 akInput/skInput：那会把用户正在输入的内容清空。
        // 保存成功后的清空由 actions.save 的 patch 负责。
        const push = () => emit(snapshot(caps?.locale))
        push()
        credsListeners.add(push)
        return () => credsListeners.delete(push)
      },
      actions: {
        save: async (scope, event) => {
          const creds = readCreds(event.value)
          if (!creds) {
            writeDebug('panel', { surface: 'panel', action: 'save', shape: describeShape(event.value) })
            return { toast: '没读到 AK/SK，两个输入框都填一下' }
          }
          try {
            await saveCreds(creds.ak, creds.sk)
          } catch (err) {
            return { toast: `保存失败：${String(err?.message ?? err).slice(0, 24)}` }
          }
          return { toast: '已保存，正在验证…', patch: { akInput: '', skInput: '' } }
        },
      },
    })
  })

  return { bridge }
}
