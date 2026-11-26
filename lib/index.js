// dsh-go 原生插件：把码道（华为云 CodeArts Agent）接入 DSH。
// 宿主侧起一个本机 OpenAI 兼容桥，App 侧提供状态条、面板和输入框胶囊。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT, PROVIDER, createBridge, saveCredentials } from './bridge.js'

export const name = 'dshgo-connect-madao'
export const inject = []

const CONFIG_DIR = join(homedir(), '.config', 'dshgo-connect-madao')
const MODEL_FILE = join(CONFIG_DIR, 'models.json')
const DEBUG_DIR = CONFIG_DIR
const PATCH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

function renderPatch(models, port = PORT) {
  const lines = [
    '# 由 dshgo-connect-madao 自动生成，请勿手工编辑。',
    '# 模型清单在插件启动时从码道网关拉取；上游上新或调价后重启 DSH 即同步。',
    '- insert:',
    '    - id: dshgo-connect-madao',
    '      name: dshgo-connect-madao',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${PROVIDER}:`,
    `        displayName: ${q('码道 CodeArts')}`,
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${port}/v1`,
    '        headers:',
    `          Authorization: ${q('Bearer bridge-local')}`,
    '        models:',
  ]
  for (const m of models) {
    lines.push(`          - id: ${q(m.id)}`)
    lines.push(`            name: ${q(m.ratio ? `${m.name} · ${m.ratio}` : m.name)}`)
    lines.push(`            contextWindow: ${m.context}`)
    lines.push(`            maxTokens: ${m.maxOutput}`)
    lines.push(`            input: [ ${m.images ? 'text, image' : 'text'} ]`)
    if (m.strengths.length > 0) {
      lines.push('            reasoningEfforts:')
      if (!noOffModels.has(m.id)) lines.push('              off: null')
      for (const level of new Set(['low', ...m.strengths])) lines.push(`              ${level}: ${q(level)}`)
    } else {
      lines.push('            reasoningEfforts: false')
    }
  }
  return `${lines.join('\n')}\n`
}

/** 把当前模型清单写回插件自带的 cordis.patch.yml；重装/重启引擎后生效。 */
export function syncPatch(models, port = PORT) {
  try {
    const next = renderPatch(models, port)
    const prev = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : ''
    if (prev === next) return { changed: false }
    writeFileSync(PATCH, next, 'utf8')
    return { changed: true }
  } catch (err) {
    return { changed: false, error: String(err?.message ?? err) }
  }
}

const zh = (locale) => !String(locale ?? '').startsWith('en')

const modelPrefs = (() => {
  try {
    const raw = JSON.parse(readFileSync(MODEL_FILE, 'utf8'))
    return {
      disabled: new Set(Array.isArray(raw?.disabled) ? raw.disabled : []),
      noOff: new Set(Array.isArray(raw?.noOff) ? raw.noOff : []),
    }
  } catch {
    return { disabled: new Set(), noOff: new Set() }
  }
})()
/** 被停用的模型 id；默认全部启用。 */
const disabledModels = modelPrefs.disabled
/** 网关不接受「关闭思考」的模型（实测 glm-5.3 系列；运行时会自动补发现）。 */
const KNOWN_NO_OFF = ['glm-5.3', 'glm-5.3-flash']
const noOffModels = new Set([...modelPrefs.noOff, ...KNOWN_NO_OFF])
const modelEnabled = (id) => !disabledModels.has(id)

function saveModelPrefs() {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(MODEL_FILE, `${JSON.stringify({ disabled: [...disabledModels], noOff: [...noOffModels] }, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.log(`[dshgo-connect-madao] 保存模型设置失败：${String(err?.message ?? err).slice(0, 120)}`)
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

/** 表单/回传结构对不上时留一份记录，方便排查。 */
function writeDebug(kind, payload) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    appendFileSync(join(DEBUG_DIR, 'panel.log'), `${new Date().toISOString()} ${kind} ${JSON.stringify(payload).slice(0, 800)}\n`, 'utf8')
  } catch {}
}

/** provider profile：llm-pi-ai 认的形状，和 cordis.patch.yml 里那段一致。 */
function providerProfile(models, port) {
  return {
    displayName: '码道 CodeArts',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${port}/v1`,
    headers: { Authorization: 'Bearer bridge-local' },
    models: models.filter((m) => modelEnabled(m.id)).map((m) => ({
      id: m.id,
      name: m.ratio ? `${m.name} · ${m.ratio}` : m.name,
      contextWindow: m.context,
      maxTokens: m.maxOutput,
      input: m.images ? ['text', 'image'] : ['text'],
      reasoningEfforts: m.strengths.length
        ? Object.fromEntries([
            ...(noOffModels.has(m.id) ? [] : [['off', null]]),
            ...[...new Set(['low', ...m.strengths])].map((l) => [l, l]),
          ])
        : false,
    })),
  }
}

/**
 * 把 madao-go 注册进 llm-pi-ai 的配置。
 *
 * 只写 bundle patch 不够：profile 自己的 cordis.patch.yml 会整段替换 llm-pi-ai 的 config，
 * 把这个 provider 抹掉。所以走 configEditor（和网页「模型」页同一条写入路径）：
 * 合并进现有 providers，落盘一次，Loader 热重载后模型列表即出现。
 */
function registerProvider(ctx) {
  let apply = () => {}
  let models = []
  let port = PORT
  const applyModels = () => (models.length > 0 ? apply(models, port) : undefined)
  ctx.inject(['configEditor'], (editorCtx) => {
    const editor = editorCtx.configEditor
    if (!editor || typeof editor.edit !== 'function') return
    apply = (list, atPort) => {
      try {
        return writeProvider(editor, list, atPort)
      } catch (err) {
        console.log(`[dshgo-connect-madao] 更新 provider 失败：${String(err?.message ?? err).slice(0, 160)}`)
        return undefined
      }
    }
    // 服务就绪时先用兜底清单补一次，网关清单拉到后再更新。
    applyModels()
  })
  // 连续切换模型开关时把写配置合并成一次，避免多次编辑互相踩。
  let timer = null
  let queue = Promise.resolve()
  return (next, nextPort) => {
    models = next ?? models
    port = nextPort ?? port
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      queue = queue.then(() => applyModels()).catch(() => {})
    }, 400)
  }
}

/** 写 provider；失败或回读不一致时重试一次。 */
function writeProvider(editor, models, port, attempt = 0) {
  const entry = editor.entries().find((e) => e.options.id === 'llm-pi-ai')
  if (!entry) {
    console.log('[dshgo-connect-madao] 没找到 llm-pi-ai，模型不会出现在选择器里')
    return undefined
  }
  const want = providerProfile(models, port)
  const same = (value) => JSON.stringify(value) === JSON.stringify(want)
  if (same(entry.options.config?.providers?.[PROVIDER])) return undefined
  if (typeof editor.canWrite === 'function' && !editor.canWrite(entry)) {
    console.log('[dshgo-connect-madao] profile 配置被更高层 patch 覆盖，需要在模型页手动添加 provider')
    return undefined
  }
  return editor
    .edit(entry, (current) => ({ ...current, providers: { ...(current.providers ?? {}), [PROVIDER]: want } }))
    .then(() => {
      const ok = same(entry.options.config?.providers?.[PROVIDER])
      console.log(`[dshgo-connect-madao] 已把 ${PROVIDER} 写进 profile 配置（${want.models.length} 个模型${ok ? '' : '，回读未生效'}）`)
      if (!ok && attempt === 0) setTimeout(() => writeProvider(editor, models, port, 1), 1200)
    })
    .catch((err) => {
      console.log(`[dshgo-connect-madao] 写 provider 失败：${String(err?.message ?? err).slice(0, 200)}`)
      if (attempt === 0) setTimeout(() => writeProvider(editor, models, port, 1), 1200)
    })
}

export function apply(ctx, config = {}) {
  const bridge = createBridge({
    port: Number(config.port ?? process.env.MADAO_PORT ?? PORT),
    gateway: config.gateway ?? process.env.MADAO_GATEWAY,
    refreshMs: Number(config.refreshMs ?? 15_000),
    noOff: noOffModels,
    onNoOff: (id) => {
      noOffModels.add(id)
      saveModelPrefs()
      ensureProvider(bridge.state.models, bridge.status().port)
      syncPatch(bridge.state.models.filter((m) => modelEnabled(m.id)), bridge.status().port)
    },
    onModels: async (models) => syncPatch(models.filter((m) => modelEnabled(m.id)), bridge.status().port),
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
    // 先按兜底清单注册 provider：没配凭证也能在模型列表里看到码道。
    ensureProvider(bridge.state.models, bridge.status().port)
    if (await bridge.connect()) {
      // 模型清单同步放到后台：拉网关可能几秒，不该拦着引擎启动。
      bridge
        .syncModels()
        .then((r) => {
          console.log(`[dshgo-connect-madao] 模型清单 ${r.models} 个（${r.source}）`)
          ensureProvider(bridge.state.models, bridge.status().port)
        })
        .catch(() => {})
        .finally(() => {
          void bridge.refreshCredit().finally(() => refreshPanels())
          void bridge.refreshCheckin()
        })
    }
  })()

  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => () => {
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
        await bridge.syncModels()
        ensureProvider(bridge.state.models, bridge.status().port)
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
    const isSk = (f) => /(^|[^a-z])sk($|[^a-z])|secret/i.test(f.key)
    const isAk = (f) => !isSk(f) && /ak|access|key|id/i.test(f.key)
    const ak = (found.find(isAk) ?? found[0])?.text
    const sk = (found.find((f) => isSk(f) && f.text !== ak) ?? found.find((f) => f.text !== ak))?.text
    if (!ak || !sk) return null
    if (ak.length < 10 || sk.length < 20) return null
    return { ak, sk }
  }

  ctx.inject(['dshGo'], (ctx) => {
    refreshPanels = () => {
      // 主面板本来就订阅了 listeners；凭证页只在保存/连接完成后推一次，
      // 这样既能更新「当前 AK / 状态」，又不会在输入途中把内容刷掉。
      for (const fn of credsListeners) {
        try {
          fn()
        } catch {}
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
      return {
        statusText: s.testing
          ? en ? 'Testing…' : '检测中…'
          : s.ok
            ? en ? 'Ready' : '就绪'
            : s.stage === 'handshake'
              ? en ? 'Handshake failed' : '握手失败'
              : en ? 'No credentials' : '未配置凭证',
        source: s.configured ? (en ? 'configured' : '已配置') : en ? 'not set' : '未配置',
        ak: s.ak ?? '-',
        sts: s.stsUntil ? String(s.stsUntil).slice(0, 19).replace('T', ' ') : s.ok ? (en ? 'not needed' : '免 STS') : '-',
        models: `${bridge.state.models.filter((m) => modelEnabled(m.id)).length}/${s.models}`,
        modelsSource: s.modelsSource === 'gateway' ? (en ? 'gateway' : '网关') : en ? 'built-in' : '内置兜底',
        port: `127.0.0.1:${s.port}`,
        errorText: s.error && s.configured ? String(s.error).slice(0, 120) : '-',
        remain: c ? c.remain : '-',
        caption: c
          ? en
            ? `total ${c.total} · used ${c.used}${c.expiring ? ` · expiring ${c.expiring}` : ''}`
            : `共 ${c.total} · 已用 ${c.used}${c.expiring ? ` · 即将过期 ${c.expiring}` : ''}`
          : en
            ? 'auto-refreshing'
            : '自动刷新中…',
        checkin: ck ? (ck.available ? (ck.claimable ? (en ? 'claimable' : '今日可领') : statusText(ck.status, en)) : en ? 'unavailable' : '无签到活动') : en ? 'not fetched' : '未查询',
        checkinReward: !ck?.available
          ? '-'
          : ck.amount > 0
            ? `${ck.amount} ${ck.unit === 'CREDIT' ? (en ? 'credits' : '积分') : ck.unit}`
            : ck.claimable
              ? en ? 'pending claim' : '待领取'
              : en ? 'claimed' : '已领取',
        steps: (s.test?.steps ?? []).map((x) => ({
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
      if (!s.ok) return { text: en ? 'Madao off' : '码道 未就绪', tone: 'warn' }
      const tail = c ? (en ? ` · ${c.remain}` : ` · 剩 ${c.remain}`) : ''
      if (s.checkin?.available && s.checkin.claimable) return { text: `${en ? 'Madao sign-in' : '码道 可签到'}${tail}`, tone: 'info' }
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
      const enabled = modelEnabled(id)
      if (enabled && bridge.state.models.filter((x) => modelEnabled(x.id)).length <= 1) {
        return { toast: '至少留一个模型启用' }
      }
      if (enabled) disabledModels.add(id)
      else disabledModels.delete(id)
      saveModelPrefs()
      const kept = bridge.state.models.filter((x) => modelEnabled(x.id))
      ensureProvider(kept, bridge.status().port)
      syncPatch(kept, bridge.status().port)
      return { toast: `${enabled ? '已停用' : '已启用'} ${m.name}`.slice(0, 40), refresh: true }
    }

    const actions = {
      openCreds: () => ({ open: 'panel:creds' }),
      test: async () => {
        const r = await bridge.test()
        const bad = (r?.steps ?? []).find((x) => !x.ok)
        return [{ toast: r?.ok ? '五项全绿' : `失败：${bad?.name ?? '自检'}` }, { refresh: 'madao' }, { refresh: 'creds' }]
      },
      sync: async () => {
        const r = await bridge.syncModels()
        if (r.ok) ensureProvider(bridge.state.models, bridge.status().port)
        return [{ toast: r.ok ? `已拉到 ${r.models} 个模型` : String(r.error).slice(0, 40) }, { refresh: 'madao' }, { refresh: 'creds' }]
      },
      checkin: async () => {
        const r = await bridge.checkin()
        if (!r?.available) return { toast: r?.reason?.slice(0, 40) ?? '没有签到活动' }
        const why = String(r.reason ?? '今日已签到').replace(/（.*?）/g, '')
        return { toast: r.claimed ? `签到成功 +${r.amount}` : why.slice(0, 36), refresh: true }
      },
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
              { label: '填写凭证', action: 'openCreds', icon: 'edit', style: 'primary' },
              { label: '测试连接', action: 'test', icon: 'refresh' },
              { label: '同步模型', action: 'sync', icon: 'download' },
            ] },
            { type: 'divider' },
            { type: 'keyValue', items: [
              ['今日签到', { $: 'data.checkin' }],
              ['签到奖励', { $: 'data.checkinReward' }],
            ] },
            { type: 'actions', items: [{ label: '立即签到', action: 'checkin', icon: 'calendar' }] },
            { type: 'divider' },
            { type: 'steps', items: { $: 'data.steps' } },
            { type: 'list', items: buildModelRows() },
          ],
        }
      },
      data: (scope, emit, caps) => {
        // 打开面板时顺手拉一次（5 秒冷却），其余时间靠桥接定时刷新。
        if (Date.now() - (bridge.state.credit?.at ?? 0) > 5_000) void bridge.refreshCredit()
        const push = () => emit(snapshot(caps?.locale))
        push()
        listeners.add(push)
        return () => listeners.delete(push)
      },
      actions,
    })

    // 凭证单独一页：这一页不做实时推送，输入到一半不会被刷掉
    ctx.dshGo.panel('creds', {
      view: {
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
      },
      data: (scope, emit, caps) => {
        // 打开时推一次；之后只在保存凭证 / 连接完成时由 refreshPanels 再推。
        // 这里没有定时刷新，避免输入到一半被刷掉。
        const push = () => emit({ akInput: '', skInput: '', ...snapshot(caps?.locale) })
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

  return { bridge, syncPatch }
}
