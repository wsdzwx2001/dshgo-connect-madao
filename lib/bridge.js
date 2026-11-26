// 码道（华为云 CodeArts Agent）→ 本机 OpenAI 兼容桥。
// 负责凭证（AK/SK → STS）、模型清单、加密转发和额度查询。
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { completeKeyExchange, createEcdhPair, decryptChunk, encryptRequest, signGateway, signIam } from './crypto.js'

export const PORT = 8766
export const PROVIDER = 'madao-go'
const GATEWAY = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const CHAT_PATH = '/api/v2/chat/completions'
const KEY_PATH = '/api/v1/security/key-exchange'
const IAM_HOST = 'iam.cn-north-4.myhuaweicloud.com'
const IAM_PATH = '/v3.0/OS-CREDENTIAL/securitytokens'
const IDENTITY = { pluginName: 'codemate_vscode', pluginVersion: '26.11.100', ideName: 'VSCode', ideVersion: '26.11.100' }
const REFRESH_MARGIN_MS = 300_000
const DEFAULT_MAX_TOKENS = 65536
const MAX_OUTPUT_CAP = 32768
const BODY_LIMIT = 9.5 * 1024 * 1024

/** 网关不可达时的兜底清单（与码道 26.11 当前模型一致）。 */
export const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1048576, maxOutput: 32768, ratio: '0.18x', images: true, strengths: [] },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', context: 1048576, maxOutput: 32768, ratio: '0.18x', images: true, strengths: [] },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1048576, maxOutput: 32768, ratio: '0.79x', images: false, strengths: [] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context: 1048576, maxOutput: 32768, ratio: '0.08x', images: true, strengths: [] },
  { id: 'GLM-5.2', name: 'GLM-5.2', context: 202752, maxOutput: 32768, ratio: '0.7x', images: false, strengths: ['high', 'max'], defaultStrength: 'high' },
  { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', context: 202752, maxOutput: 32768, ratio: '0.7x', images: false, strengths: ['high', 'max'], defaultStrength: 'high' },
  { id: 'kimi-k3', name: 'Kimi-K3', context: 1048576, maxOutput: 32768, ratio: '2.38x', images: true, strengths: [] },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', context: 1048576, maxOutput: 32768, ratio: '1.63x', images: true, strengths: [] },
  { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', context: 524288, maxOutput: 32768, ratio: '0.7x', images: false, strengths: [] },
  { id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash', context: 524288, maxOutput: 32768, ratio: '0.32x', images: false, strengths: [] },
  { id: 'speed', name: '智速模式', context: 1048576, maxOutput: 32768, ratio: '0.18x', images: false, strengths: [] },
]

const log = (...args) => console.log('[dshgo-connect-madao]', ...args)

// ── 凭证 ────────────────────────────────────────────────────
const CRED_DIR = join(homedir(), '.config', 'dshgo-connect-madao')
export const CRED_PATH = join(CRED_DIR, 'credentials.json')
const LEGACY_PATHS = [join(homedir(), '.config', 'dsh-connect-madao', 'credentials.json'), join(homedir(), '.dsh-connect-madao', 'credentials.json')]

function parseCred(raw, where) {
  const ak = raw.ak ?? raw.accessKeyId
  const sk = raw.sk ?? raw.secretAccessKey
  if (!ak || !sk) throw new Error(`${where} 里缺少 ak / sk`)
  const securityToken = raw.securityToken ?? raw.security_token ?? raw.token
  return { ak: String(ak).trim(), sk: String(sk).trim(), ...(securityToken ? { securityToken: String(securityToken) } : {}) }
}

/** 环境变量优先，其次新路径，最后兼容原插件的两个路径。 */
export async function loadCredentials() {
  const ak = process.env.MADAO_AK?.trim()
  const sk = process.env.MADAO_SK?.trim()
  if (ak && sk) {
    const token = process.env.MADAO_SECURITY_TOKEN?.trim()
    return { key: { ak, sk, ...(token ? { securityToken: token } : {}) }, source: '环境变量' }
  }
  for (const path of [CRED_PATH, ...LEGACY_PATHS]) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    try {
      return { key: parseCred(JSON.parse(text), path), source: '凭证文件' }
    } catch (err) {
      throw new Error(`${path} 内容不对：${err?.message ?? err}`)
    }
  }
  throw new Error('还没有码道凭证。打开「dshgo-connect-madao」面板，在「凭证设置」里填 AK/SK 后保存。')
}

export async function saveCredentials(ak, sk) {
  await mkdir(CRED_DIR, { recursive: true, mode: 0o700 })
  await writeFile(CRED_PATH, JSON.stringify({ ak, sk }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return CRED_PATH
}

// ── IAM → STS ───────────────────────────────────────────────
async function getSts(ak, sk, durationSeconds = 3600) {
  const body = JSON.stringify({ auth: { identity: { methods: ['token'], token: { duration_seconds: durationSeconds } } } })
  const headers = signIam({ method: 'POST', host: IAM_HOST, path: `${IAM_PATH}/`, contentType: 'application/json;charset=utf8', body, ak, sk })
  const res = await fetch(`https://${IAM_HOST}${IAM_PATH}`, { method: 'POST', headers, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`换 STS 失败：HTTP ${res.status} ${text.slice(0, 200)}`)
  const cred = JSON.parse(text).credential
  if (!cred?.access || !cred?.secret || !cred?.securitytoken) throw new Error('IAM 响应里没有 credential')
  return { ak: cred.access, sk: cred.secret, securityToken: cred.securitytoken, expiresAt: cred.expires_at ?? '' }
}

class StsCache {
  constructor(ak, sk) {
    this.ak = ak
    this.sk = sk
    this.value = null
    this.pending = null
  }
  expiring() {
    const t = Date.parse(this.value?.expiresAt ?? '')
    return !Number.isFinite(t) ? false : Date.now() > t - 600_000
  }
  async get() {
    if (this.value && !this.expiring()) return this.value
    if (!this.pending) {
      this.pending = getSts(this.ak, this.sk)
        .then((v) => (this.value = v))
        .finally(() => (this.pending = null))
    }
    return this.pending
  }
}

// ── 网关客户端 ──────────────────────────────────────────────
const sha = (v) => createHash('sha256').update(v).digest('hex')

class Client {
  constructor({ gateway, credentials }) {
    this.gateway = (gateway || GATEWAY).replace(/\/+$/, '')
    this.creds = credentials
    // 固定复用同一个会话 id：网关按它算并发名额（上限 3），每请求换新会占满。
    this.sessionId = `madao-${sha(credentials.ak ?? 'default').slice(0, 16)}`
    this.key = null
    this.negotiating = null
  }

  async ensureKey() {
    if (this.key && Date.now() < this.key.expiresAt - REFRESH_MARGIN_MS) return this.key
    if (!this.negotiating) {
      this.negotiating = this.negotiate().finally(() => (this.negotiating = null))
    }
    return this.negotiating
  }

  async negotiate() {
    const url = new URL(this.gateway + KEY_PATH)
    const pair = createEcdhPair()
    const body = JSON.stringify({ clientPublicKey: pair.publicKeyB64, sessionId: randomUUID().replace(/-/g, ''), timestamp: Date.now() })
    const headers = signGateway({ method: 'POST', url, contentType: 'application/json', body, credentials: this.creds })
    const res = await fetch(url, { method: 'POST', headers: { ...headers, 'User-Agent': `codearts/${IDENTITY.ideVersion}` }, body })
    if (!res.ok) throw new Error(`密钥协商失败：HTTP ${res.status}`)
    const json = await res.json()
    if (!json.keyId || !json.serverPublicKey) throw new Error('密钥协商响应不完整')
    this.key = completeKeyExchange(pair, json.serverPublicKey, json.keyId, json.expiresIn ?? 7200)
    return this.key
  }

  async _signed(url, { method, contentType, body = '', bodyBytes }) {
    return signGateway({ method, url, contentType, body, bodyBytes, credentials: this.creds })
  }

  identityHeaders() {
    return {
      'Agent-Type': 'PromptCenter',
      'x-language': 'zh-cn',
      'plugin-name': IDENTITY.pluginName,
      'plugin-version': IDENTITY.pluginVersion,
      'ide-name': IDENTITY.ideName,
      'ide-version': IDENTITY.ideVersion,
    }
  }

  /** 加密对话，返回已解密的 SSE 文本流。 */
  async chat(payload) {
    const session = await this.ensureKey()
    const url = new URL(this.gateway + CHAT_PATH)
    const ts = Date.now()
    const { body, headers: enc } = encryptRequest(session, Buffer.from(JSON.stringify(payload), 'utf8'), 'POST', CHAT_PATH, ts)
    const signed = await this._signed(url, { method: 'POST', contentType: enc['Content-Type'], bodyBytes: body })
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...signed,
        ...enc,
        Accept: 'text/event-stream',
        'X-Encrypt-Capable': 'sm4-gcm',
        'User-Agent': 'ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14',
        ...this.identityHeaders(),
        'user-session-id': this.sessionId,
        'user-msg-id': randomUUID(),
      },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let plain = text.slice(0, 300)
      try {
        plain = decryptChunk(session, text.trim(), 0).slice(0, 600)
      } catch {}
      throw new Error(`对话请求失败：HTTP ${res.status} ${plain}`)
    }
    if (res.headers.get('x-encrypt-algo') !== 'sm4-gcm') return res.body
    return decryptStream(res.body, session)
  }

  async getJson(path) {
    const url = new URL(this.gateway + path)
    const headers = await this._signed(url, { method: 'GET' })
    const res = await fetch(url, {
      headers: { ...headers, 'User-Agent': `codearts/${IDENTITY.ideVersion}`, ...this.identityHeaders() },
    })
    if (!res.ok) throw new Error(`GET ${path} 失败：HTTP ${res.status}`)
    return res.json()
  }

  async postJson(path, payload) {
    const url = new URL(this.gateway + path)
    const body = JSON.stringify(payload)
    const headers = await this._signed(url, { method: 'POST', contentType: 'application/json', body })
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'User-Agent': `codearts/${IDENTITY.ideVersion}`, ...this.identityHeaders() },
      body,
    })
    if (!res.ok) throw new Error(`POST ${path} 失败：HTTP ${res.status}`)
    return res.json()
  }

  /** 标记会话 busy / idle，让并发名额及时释放；失败不影响对话。 */
  async heartbeat(status) {
    try {
      const path = `/snap-manager/v1/chat-session/heartbeat?status=${status}`
      const url = new URL(this.gateway + path)
      const headers = await this._signed(url, { method: 'PUT' })
      const res = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'User-Agent': `codearts/${IDENTITY.ideVersion}`, ...this.identityHeaders(), 'user-session-id': this.sessionId },
      })
      return res.ok
    } catch {
      return false
    }
  }
}

function decryptStream(upstream, session) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let index = 0
  const flush = (controller, chunk) => {
    const plain = decryptChunk(session, chunk, index++)
    controller.enqueue(encoder.encode(plain.endsWith('\n\n') ? plain : `${plain}\n\n`))
  }
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            const rest = buffer.trim()
            if (rest) flush(controller, rest)
            controller.close()
            return
          }
          buffer += decoder.decode(value, { stream: true })
          let sep
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, sep).trim()
            buffer = buffer.slice(sep + 2)
            if (chunk) flush(controller, chunk)
          }
        }
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

// ── 模型清单 ────────────────────────────────────────────────
export async function discoverModels(client) {
  try {
    const raw = await client.getJson('/v1/model/builtin')
    const list = raw?.builtinModels ?? []
    if (list.length === 0) return { models: FALLBACK_MODELS, source: 'fallback' }
    let variants = {}
    try {
      variants = (await client.postJson('/v1/model/thinking-variants', { model_names: list.map((m) => m.model_id) }))?.variants ?? {}
    } catch {}
    const models = list
      .filter((m) => m.model_id && m.enable !== false)
      .map((m) => {
        const v = variants[m.model_id]
        const fb = FALLBACK_MODELS.find((f) => f.id === m.model_id)
        const maxOutput = m.max_tokens && m.max_tokens > 0 ? m.max_tokens : fb?.maxOutput ?? MAX_OUTPUT_CAP
        return {
          id: m.model_id,
          name: m.model_name || m.model_id,
          context: m.context_window ?? fb?.context ?? 0,
          // 输出上限别照抄网关：DSH 会把它和 headroom 一起从窗口里扣掉。
          maxOutput: Math.min(maxOutput, MAX_OUTPUT_CAP),
          ratio: m.credit?.[0]?.ratio_display,
          images: m.supports_images === true,
          strengths: v?.strengths ?? [],
          defaultStrength: v?.default_strength || undefined,
        }
      })
    return { models, source: 'gateway' }
  } catch (err) {
    log('模型清单拉取失败，用兜底清单：', err?.message ?? err)
    return { models: FALLBACK_MODELS, source: 'fallback' }
  }
}

// ── 额度 ────────────────────────────────────────────────────
const metric = (list, name) => list.find((m) => m?.name === name)
const pkgOf = (m) => (m ? { amount: Number(m.package_credit_amount ?? 0), used: Number(m.package_credit_used ?? 0), remain: Number(m.package_credit_remain ?? 0) } : undefined)

async function queryCredit(client) {
  try {
    const r = await client.getJson('/snap-manager/v1/statistics/plugin')
    const list = r?.metrics ?? []
    const total = metric(list, 'usageTotalPackageCredit')
    if (!total) return null
    const bonus = metric(list, 'usageBonusPackageCredit')
    return {
      total: Number(total.package_credit_amount ?? 0),
      used: Number(total.package_credit_used ?? 0),
      remain: Number(total.package_credit_remain ?? 0),
      basic: pkgOf(metric(list, 'usageBasicPackageCredit')),
      bonus: pkgOf(bonus),
      expiring: Number(bonus?.package_credit_expiring_amount ?? 0) || 0,
      end: typeof r?.end_date === 'string' ? r.end_date : undefined,
      at: Date.now(),
    }
  } catch (err) {
    log('额度查询失败：', err?.message ?? err)
    return null
  }
}

// ── 每日签到 ────────────────────────────────────────────────
const CHECKIN_CAMPAIGN = 34

const dailyView = (it) => ({
  campaignId: Number(it?.campaignId),
  title: String(it?.title ?? '每日签到'),
  status: it?.status ?? null,
  claimable: it?.claimable === true,
  amount: Number(it?.pendingTotalAmount ?? it?.benefitAmount ?? 0),
  unit: String(it?.benefitUnit ?? 'CREDIT'),
  expireAt: it?.expireAt ?? null,
})

async function fetchCampaigns(client) {
  const d = await client.getJson('/v1/ops/delivery?channel=IDE')
  const items = d?.data?.items
  return Array.isArray(items) ? items : []
}

/** 只关心每日签到那个活动（campaignId=34）。 */
export async function queryCheckin(client) {
  const daily = (await fetchCampaigns(client)).find((x) => Number(x?.campaignId) === CHECKIN_CAMPAIGN)
  if (!daily) return { ok: true, available: false, reason: '网关福利列表里没有每日签到' }
  return { ok: true, available: true, ...dailyView(daily) }
}

async function confirmClaim(client, campaignId) {
  try {
    return (await client.postJson('/v1/ops/confirm', { campaignId }))?.code === 0
  } catch {
    return false
  }
}

/** 今日签到：已领取就直接说明，可领就 claim 并补 confirm。 */
export async function claimCheckin(client) {
  const state = await queryCheckin(client)
  if (!state.available) return { ...state, claimed: false }
  if (!state.claimable || state.status !== 'ELIGIBLE') {
    const why =
      state.status === 'CONSUMED'
        ? '今日已领取（积分已用完）'
        : state.status === 'CONFIRMED'
          ? '今日已签到'
          : state.status === 'CLAIMED'
            ? '今日已签到（待确认）'
            : '当前不可签到'
    return { ...state, claimed: false, claimable: false, reason: `${why}（${state.status ?? 'null'}）` }
  }
  const r = await client.postJson('/v1/ops/claim', { campaignId: CHECKIN_CAMPAIGN, idempotentKey: randomUUID().replace(/-/g, ''), channel: 'IDE' })
  const claimed = r?.code === 0
  if (claimed) await confirmClaim(client, CHECKIN_CAMPAIGN)
  return {
    ...state,
    claimed,
    claimable: false,
    status: r?.data?.status ?? (claimed ? 'CONFIRMED' : state.status),
    amount: r?.data?.totalAmount ?? state.amount,
    ...(claimed ? {} : { reason: String(r?.message ?? '签到失败') }),
  }
}

// ── 请求体规范化 ────────────────────────────────────────────
function normPart(p) {
  if (!p || typeof p !== 'object') return null
  if (p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text }
  if (p.type === 'image_url' && p.image_url?.url) return { type: 'image_url', image_url: { url: String(p.image_url.url) } }
  return null
}

function normContent(content) {
  if (typeof content === 'string') return content
  if (content == null) return ''
  const parts = (Array.isArray(content) ? content : [content]).map(normPart).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('')
  return parts
}

function unsupportedPart(messages) {
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue
    for (const p of m.content) {
      if (typeof p?.type === 'string' && p.type !== 'text' && p.type !== 'image_url') return p.type
    }
  }
  return null
}

function upstreamBody(req) {
  return {
    model: req.model,
    messages: (req.messages ?? []).map((m) => ({
      // 网关不认 developer 角色，会静默返回空内容：降级成 system。
      role: m.role === 'developer' ? 'system' : m.role,
      content: normContent(m.content),
      ...(m.name ? { name: m.name } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    })),
    max_tokens: req.max_tokens ?? req.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    ...(req.stream_options ? { stream_options: req.stream_options } : {}),
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === 'number' ? { top_p: req.top_p } : {}),
    ...(req.stop ? { stop: req.stop } : {}),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
    // 网关认 reasoning_effort；off 走 none。
    ...(typeof req.effort === 'string' && req.effort ? { reasoning_effort: req.effort === 'off' ? 'none' : req.effort } : {}),
  }
}

function resolveModel(raw, models) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const low = text.toLowerCase()
  const shown = (m) => (m.ratio ? `${m.name} · ${m.ratio}` : m.name)
  const hit =
    models.find((m) => m.id.toLowerCase() === low) ||
    models.find((m) => shown(m) === text || m.name === text) ||
    models.find((m) => shown(m).toLowerCase() === low) ||
    models.find((m) => m.id.toLowerCase() === text.split('·')[0].trim().toLowerCase())
  return hit?.id ?? null
}

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u
function estimateTokens(value) {
  let images = 0
  const text = JSON.stringify(value ?? '', (_k, v) => {
    if (typeof v === 'string' && v.startsWith('data:image/')) {
      images++
      return '__IMG__'
    }
    return v
  })
  let cjk = 0
  for (const ch of text) if (CJK.test(ch)) cjk++
  return Math.ceil(cjk / 2.5 + (text.length - cjk) / 5) + images * 1500
}

// ── 上游 SSE 解析 ───────────────────────────────────────────
async function* events(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = function* (block) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const text = line.slice(5).trim()
      if (!text) continue
      if (text === '[DONE]') return
      let obj
      try {
        obj = JSON.parse(text)
      } catch {
        continue
      }
      if (obj.error_code) yield { error: { code: obj.error_code, message: String(obj.error_msg ?? '') } }
      else if (obj.error && !Array.isArray(obj.choices)) yield { error: { code: String(obj.error.code ?? 'upstream_error'), message: String(obj.error.message ?? '') } }
      else if (Array.isArray(obj.choices)) {
        if (obj.usage) yield { usage: obj.usage }
        const ch = obj.choices[0]
        if (!ch) continue
        const d = ch.delta ?? ch.message ?? {}
        yield {
          text: typeof d.content === 'string' ? d.content : '',
          reasoning: typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '',
          toolCalls: Array.isArray(d.tool_calls) ? d.tool_calls : undefined,
          finish: ch.finish_reason ? String(ch.finish_reason) : undefined,
        }
      }
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) yield* parse(buffer)
      return
    }
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      yield* parse(block)
    }
  }
}

const chunk = (id, model, delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })
const line = (payload) => `data: ${JSON.stringify(payload)}\n\n`

// ── 桥接服务 ────────────────────────────────────────────────
export function createBridge({ port = PORT, gateway, onModels, onChange, onNoOff, noOff, refreshMs = 15_000 } = {}) {
  const state = {
    loaded: null,
    configured: false,
    client: null,
    sts: null,
    lastCreds: null,
    noOff: new Set(noOff ?? []),
    error: null,
    models: FALLBACK_MODELS,
    modelsSource: 'fallback',
    credit: null,
    checkin: null,
    checkinAt: 0,
    test: null,
    testing: false,
    port,
    startedAt: Date.now(),
  }
  const notify = () => {
    try {
      onChange?.()
    } catch {}
  }

  async function connect() {
    try {
      let loaded
      try {
        loaded = await loadCredentials()
      } catch (err) {
        // 压根没有凭证：算“未配置”
        state.error = String(err?.message ?? err)
        state.loaded = null
        state.configured = false
        state.client = null
        state.credit = null
        state.checkin = null
        state.lastCreds = null
        return false
      }
      // 凭证存在就算“已配置”，后面握不上手只影响状态，不影响这一判断
      state.loaded = loaded
      state.configured = true
      state.error = null
      if (loaded.key.securityToken) {
        state.sts = null
        state.client = new Client({ gateway, credentials: loaded.key })
      } else {
        state.sts = new StsCache(loaded.key.ak, loaded.key.sk)
        state.lastCreds = await state.sts.get()
        state.client = new Client({ gateway, credentials: state.lastCreds })
      }
      return true
    } catch (err) {
      state.error = String(err?.message ?? err)
      state.client = null
      state.credit = null
      state.checkin = null
      state.lastCreds = null
      return false
    } finally {
      notify()
    }
  }

  /** 临时 STS 只有一小时，过期前换新的；凭证变了就重建客户端。 */
  async function ensureFresh() {
    if (!state.sts || !state.client) return
    try {
      const creds = await state.sts.get()
      if (creds !== state.lastCreds) {
        state.lastCreds = creds
        state.client = new Client({ gateway, credentials: creds })
        log('STS 已续期，客户端已重建')
      }
    } catch (err) {
      log('STS 续期失败：', err?.message ?? err)
    }
  }

  async function reload() {
    await connect()
    void refreshCredit()
    void refreshCheckin()
    return Boolean(state.client)
  }

  async function refreshCheckin() {
    if (!state.client) return null
    state.checkin = await queryCheckin(state.client).catch(() => null)
    state.checkinAt = Date.now()
    notify()
    return state.checkin
  }

  async function checkin() {
    if (!state.client) return { ok: false, reason: '还没有可用凭证' }
    const r = await claimCheckin(state.client)
    state.checkin = r
    state.checkinAt = Date.now()
    notify()
    return r
  }

  let creditPending = null
  let creditAt = 0
  async function refreshCredit() {
    if (!state.client) return null
    if (creditPending) return creditPending
    if (Date.now() - creditAt < Math.min(2000, refreshMs || 2000)) return state.credit
    creditPending = queryCredit(state.client)
      .then((next) => {
        if (next) state.credit = next
        notify()
        return state.credit
      })
      .finally(() => {
        creditAt = Date.now()
        creditPending = null
      })
    return creditPending
  }

  async function syncModels() {
    if (!state.client) return { ok: false, error: '还没有可用凭证' }
    const found = await discoverModels(state.client)
    state.models = found.models
    state.modelsSource = found.source
    notify()
    const written = onModels ? await onModels(found.models) : null
    return { ok: true, models: found.models.length, source: found.source, written }
  }

  /** 自检：凭证 → 密钥协商 → 模型清单 → 额度 → 签到。并发调用复用同一次。 */
  let testPromise = null
  function test() {
    if (testPromise) return testPromise
    testPromise = runTest().finally(() => {
      testPromise = null
    })
    return testPromise
  }
  async function runTest() {
    state.testing = true
    notify()
    try {
      return await runTestSteps()
    } finally {
      state.testing = false
      notify()
    }
  }
  async function runTestSteps() {
    const steps = []
    const step = async (name, fn) => {
      const t0 = Date.now()
      try {
        const detail = await fn()
        steps.push({ name, ok: true, detail, ms: Date.now() - t0 })
        return true
      } catch (err) {
        steps.push({ name, ok: false, detail: String(err?.message ?? err).slice(0, 160), ms: Date.now() - t0 })
        return false
      }
    }
    const credOk = await step('凭证', async () => {
      await connect()
      if (!state.client) throw new Error(state.error ?? '未配置')
      return `${state.loaded?.source ?? '凭证'} · ${state.loaded.key.ak.slice(0, 4)}…`
    })
    if (credOk) {
      await step('密钥协商', async () => {
        state.client.key = null
        const k = await state.client.ensureKey()
        return `keyId ${String(k.keyId).slice(0, 8)}`
      })
      await step('模型清单', async () => {
        const r = await syncModels()
        if (!r.ok) throw new Error(r.error)
        return `${r.models} 个（${r.source}）`
      })
      await step('额度', async () => {
        const c = await queryCredit(state.client)
        if (!c) throw new Error('额度接口无返回')
        state.credit = c
        return `剩余 ${c.remain} / ${c.total}`
      })
      await step('签到', async () => {
        const c = await queryCheckin(state.client)
        state.checkin = c
        state.checkinAt = Date.now()
        if (!c.available) throw new Error(c.reason ?? '没有签到活动')
        return c.claimable ? '今日可领取' : `今日${c.status ?? '不可领'}`
      })
    }
    state.test = { ok: steps.every((s) => s.ok), steps, at: Date.now() }
    return state.test
  }

  async function chatCompletion(res, client, rawBody) {
    const bad = unsupportedPart(rawBody.messages)
    if (bad) return sendJson(res, 400, { error: { message: `不支持的内容类型：${bad}。码道路由只认 text 和 image_url。`, type: 'unsupported_content' } })

    const model = resolveModel(rawBody.model, state.models)
    if (!model) {
      const names = state.models.map((m) => m.id).join('、')
      return sendJson(res, 400, { error: { message: `未知模型 ${JSON.stringify(String(rawBody.model ?? ''))}。可用：${names}`, type: 'model_not_found' } })
    }
    const body = { ...rawBody, model, effort: rawBody.strength ?? rawBody.reasoning_effort }
    const info = state.models.find((m) => m.id === model)
    const upstream = upstreamBody(body)

    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(upstream))
    } catch {}
    if (bytes > BODY_LIMIT) {
      return sendJson(res, 413, { error: { message: `请求体 ${(bytes / 1048576).toFixed(1)} MB，超过网关约 10 MB 上限。开个新会话，或换窗口更小的模型。`, type: 'request_too_large' } })
    }
    const est = estimateTokens(rawBody.messages) + (Array.isArray(rawBody.tools) ? estimateTokens(rawBody.tools) : 0)
    if (info?.context > 0 && est > (info.context - 4096) * 1.2) {
      return sendJson(res, 400, {
        error: { message: `上下文超出「${info.name}」的窗口 ${info.context}：估算 ${est} tokens（含工具定义）。压缩会话、减少工具，或换窗口更大的模型。`, type: 'context_length_exceeded' },
      })
    }

    const id = `chatcmpl-${Date.now().toString(36)}`
    const wantStream = rawBody.stream !== false
    void client.heartbeat('busy')
    const done = () => void client.heartbeat('idle')
    const alwaysThinks = (text) => /始终思考|不支持关闭思考/.test(String(text ?? ''))
    const learnNoOff = (id) => {
      if (state.noOff.has(id)) return
      state.noOff.add(id)
      notify()
      console.log(`[dshgo-connect-madao] ${id} 不支持关闭思考，已去掉 off 档`)
      onNoOff?.(id)
    }
    /** 关思考被网关拒绝时：记住、去掉 off 重发。错误可能出现在 HTTP 层，也可能是一帧 SSE。 */
    const retryWithoutEffort = async () => {
      const body = { ...upstream }
      delete body.reasoning_effort
      return client.chat(body)
    }

    let triedOff = false
    let upstreamStream
    try {
      upstreamStream = await client.chat(upstream)
    } catch (err) {
      const message = String(err?.message ?? err)
      if (upstream.reasoning_effort === 'none' && !triedOff && alwaysThinks(message)) {
        triedOff = true
        learnNoOff(model)
        try {
          upstreamStream = await retryWithoutEffort()
        } catch (err2) {
          done()
          return sendJson(res, 502, { error: { message: String(err2?.message ?? err2), type: 'upstream_error' } })
        }
      } else {
        done()
        return sendJson(res, 502, { error: { message, type: 'upstream_error' } })
      }
    }

    // 上游可能先回 200、再吐一帧错误；这种情况下也要能换一种请求重来。
    async function* withOffFallback(first) {
      let stream = first
      let prev = null
      for (;;) {
        const iterator = events(stream)
        let retried = false
        for await (const ev of iterator) {
          if (ev.error && upstream.reasoning_effort === 'none' && !triedOff && alwaysThinks(ev.error.message)) {
            triedOff = true
            learnNoOff(model)
            const stale = stream
            try {
              stream = await retryWithoutEffort()
            } catch (err) {
              yield { error: { code: 'upstream_error', message: String(err?.message ?? err) } }
              return
            }
            prev = stale
            retried = true
            break
          }
          yield ev
        }
        try {
          const dropped = prev?.cancel?.()
          if (dropped && typeof dropped.catch === 'function') dropped.catch(() => {})
        } catch {}
        prev = null
        if (!retried) return
      }
    }

    const it = withOffFallback(upstreamStream)

    if (!wantStream) {
      let text = ''
      let reasoning = ''
      let finish = null
      let usage
      const calls = []
      try {
        for await (const ev of it) {
          if (ev.reasoning) reasoning += ev.reasoning
          if (ev.text) text += ev.text
          if (ev.toolCalls) {
            for (const tc of ev.toolCalls) {
              const i = typeof tc?.index === 'number' ? tc.index : calls.length
              const cur = calls[i] ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
              if (tc.id) cur.id = tc.id
              if (tc.type) cur.type = tc.type
              if (tc.function?.name) cur.function.name += tc.function.name
              if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
              calls[i] = cur
            }
          }
          if (ev.error) {
            done()
            return sendJson(res, 400, { error: { message: `${ev.error.message}（${ev.error.code}）`, type: 'upstream_error', code: ev.error.code } })
          }
          if (ev.finish) finish = ev.finish
          if (ev.usage) usage = ev.usage
        }
      } catch (err) {
        done()
        return sendJson(res, 502, { error: { message: String(err?.message ?? err), type: 'upstream_error' } })
      }
      done()
      void refreshCredit()
      const merged = calls.filter(Boolean)
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(merged.length ? { tool_calls: merged } : {}) },
            finish_reason: finish ?? 'stop',
          },
        ],
        ...(usage ? { usage } : {}),
      })
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(line(chunk(id, model, { role: 'assistant' })))
    let finish = null
    let usage
    try {
      for await (const ev of it) {
        if (ev.reasoning) res.write(line(chunk(id, model, { reasoning_content: ev.reasoning })))
        if (ev.text) res.write(line(chunk(id, model, { content: ev.text })))
        if (ev.toolCalls) res.write(line(chunk(id, model, { tool_calls: ev.toolCalls })))
        if (ev.error) {
          res.write(line({ error: { message: `${ev.error.message}（${ev.error.code}）`, type: 'upstream_error', code: ev.error.code } }))
          break
        }
        if (ev.finish) finish = ev.finish
        if (ev.usage) usage = ev.usage
      }
    } catch (err) {
      res.write(line({ error: { message: String(err?.message ?? err), type: 'upstream_error' } }))
    }
    if (usage) res.write(line({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage }))
    res.write(line(chunk(id, model, {}, finish ?? 'stop')))
    res.write('data: [DONE]\n\n')
    res.end()
    done()
    void refreshCredit()
  }

  function sendJson(res, status, payload) {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > BODY_LIMIT + 1_000_000) return reject(new Error('请求体过大'))
        chunks.push(Buffer.from(c))
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    if (url.pathname === '/healthz' || url.pathname === '/v1/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: state.models.map((m) => ({
          id: m.id,
          object: 'model',
          name: m.name,
          owned_by: 'huawei-codearts',
          context_window: m.context,
          max_output_tokens: m.maxOutput,
          supports_images: m.images,
          strengths: m.strengths,
        })),
      })
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await ensureFresh()
      if (!state.client) return sendJson(res, 503, { error: { message: state.error ?? '还没有可用凭证', type: 'credentials_error' } })
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        return sendJson(res, 400, { error: { message: `请求体不是合法 JSON：${err?.message ?? err}`, type: 'invalid_request_error' } })
      }
      return chatCompletion(res, state.client, body)
    }
    sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}`, type: 'not_found' } })
  }

  function status() {
    const c = state.credit
    return {
      ok: Boolean(state.client),
      stage: state.client ? 'ready' : state.configured ? 'handshake' : 'credentials',
      configured: state.configured,
      error: state.error ?? undefined,
      ak: state.loaded ? `${state.loaded.key.ak.slice(0, 4)}…${state.loaded.key.ak.slice(-4)}` : undefined,
      source: state.loaded?.source,
      stsUntil: state.sts?.value?.expiresAt,
      models: state.models.length,
      modelsSource: state.modelsSource,
      credit: c ? { remain: c.remain, total: c.total, used: c.used, expiring: c.expiring, end: c.end, at: c.at } : null,
      checkin: state.checkin,
      noOff: [...state.noOff],
      checkinAt: state.checkinAt || undefined,
      test: state.test,
      testing: state.testing,
      port: state.port,
      startedAt: state.startedAt,
    }
  }

  let creditTimer = null
  let welfareTimer = null
  if (refreshMs > 0) {
    creditTimer = setInterval(() => {
      if (state.client) void refreshCredit()
    }, refreshMs)
    creditTimer.unref?.()
    welfareTimer = setInterval(() => {
      if (state.client) void refreshCheckin()
    }, Math.max(refreshMs * 5, 60_000))
    welfareTimer.unref?.()
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err?.message ?? err), type: 'internal_error' } })
      else res.end()
    })
  })

  return {
    state,
    server,
    status,
    connect,
    reload,
    test,
    syncModels,
    refreshCredit,
    refreshCheckin,
    checkin,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`))
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(creditTimer)
        clearInterval(welfareTimer)
        server.close(() => resolve())
        // 热重载时把还开着的连接直接断掉，端口马上能复用
        server.closeAllConnections?.()
      }),
  }
}