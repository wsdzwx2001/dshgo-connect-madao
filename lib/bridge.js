// 码道（华为云 CodeArts Agent）→ 本机 OpenAI 兼容桥。
// 负责凭证（AK/SK → STS）、模型清单、加密转发和额度查询。
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { completeKeyExchange, createEcdhPair, decryptChunk, encryptRequest, signGateway, signIam } from './crypto.js'
import { VALID_EFFORTS, effortsFor } from './efforts.js'

export const PORT = 8766
export const PROVIDER = 'madao-go'
/** 运行中模块的版本；/healthz 用它确认引擎确实加载了新代码。 */
export const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()
const GATEWAY = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const CHAT_PATH = '/api/v2/chat/completions'
const KEY_PATH = '/api/v1/security/key-exchange'
const IAM_HOST = 'iam.cn-north-4.myhuaweicloud.com'
const IAM_PATH = '/v3.0/OS-CREDENTIAL/securitytokens'
const IDENTITY = { pluginName: 'codemate_vscode', pluginVersion: '26.11.100', ideName: 'VSCode', ideVersion: '26.11.100' }
const REFRESH_MARGIN_MS = 300_000
/** 输出上限：没有模型信息时的兜底值，与 MAX_OUTPUT_CAP 保持一致，别比模型上限还大。 */
const DEFAULT_MAX_TOKENS = 32768
const MAX_OUTPUT_CAP = 32768
/** 网关收的是 base64 密文，约为明文的 4/3；留 7MB 明文避免 10MB 网关上限被撞穿。 */
const BODY_LIMIT = 7 * 1024 * 1024
const GATEWAY_BODY_LIMIT = 10 * 1024 * 1024
/** 只读接口（IAM / 模型 / 额度 / 签到 / 心跳）的应用层超时。 */
const META_TIMEOUT_MS = 20_000
/** 本机桥的 Bearer 值；provider 配置里用的也是它。 */
export const BRIDGE_TOKEN = 'bridge-local'

/** 给只读请求加超时；有父 signal 时合并，父级取消也能立刻中断。 */
const requestSignal = (signal, ms = META_TIMEOUT_MS) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

/** 网关不可达时的兜底清单（与码道 26.11 当前模型一致）。 */
export const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1048576, maxOutput: 32768, ratio: '0.18x', images: true, strengths: [], known: true },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', context: 1048576, maxOutput: 32768, ratio: '0.18x', images: true, strengths: [], known: true },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1048576, maxOutput: 32768, ratio: '0.79x', images: false, strengths: [], known: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context: 1048576, maxOutput: 32768, ratio: '0.08x', images: true, strengths: [], known: true },
  { id: 'GLM-5.2', name: 'GLM-5.2', context: 202752, maxOutput: 32768, ratio: '0.7x', images: false, strengths: ['high', 'max'], defaultStrength: 'high', known: true },
  { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', context: 202752, maxOutput: 32768, ratio: '0.7x', images: false, strengths: ['high', 'max'], defaultStrength: 'high', known: true },
  { id: 'kimi-k3', name: 'Kimi-K3', context: 1048576, maxOutput: 32768, ratio: '2.38x', images: true, strengths: [], known: true },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', context: 1048576, maxOutput: 32768, ratio: '1.63x', images: true, strengths: [], known: true },
  { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', context: 524288, maxOutput: 32768, ratio: '0.7x', images: false, strengths: [], known: true },
  { id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash', context: 524288, maxOutput: 32768, ratio: '0.32x', images: false, strengths: [], known: true },
  { id: 'speed', name: '智速模式', context: 1048576, maxOutput: 32768, ratio: '0.18x', images: false, strengths: [], known: true },
]

const log = (...args) => console.log('[dshgo-connect-madao]', ...args)

// ── 凭证 ────────────────────────────────────────────────────
const CRED_DIR = join(homedir(), '.config', 'dshgo-connect-madao')
export const CRED_PATH = join(CRED_DIR, 'credentials.json')
const LEGACY_PATHS = [join(homedir(), '.config', 'dsh-connect-madao', 'credentials.json'), join(homedir(), '.dsh-connect-madao', 'credentials.json')]

// ── 模型清单缓存 ────────────────────────────────────────────
/**
 * 上一次成功同步的清单。没有它时，离线重启只能用内置兜底清单，
 * provider 里已经存在的新模型会报「未知模型」。
 */
export const MODEL_CACHE_PATH = join(CRED_DIR, 'models-cache.json')

function readModelCache(path) {
  if (!path) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const list = Array.isArray(raw?.models) ? raw.models : []
    const models = list
      .filter((m) => m && typeof m.id === 'string' && m.id && Number.isFinite(m.context) && m.context > 0 && Number.isFinite(m.maxOutput) && m.maxOutput > 0)
      .map((m) => ({
        ...m,
        id: String(m.id),
        name: String(m.name || m.id),
        // 档位必须落在 DSH 白名单里：非法值会让 llm-pi-ai 整段配置校验失败，
        // 结果是所有 provider 都不出来，比单个模型坏严重得多。
        strengths: Array.isArray(m.strengths) ? m.strengths.filter((x) => typeof x === 'string' && x !== 'off' && VALID_EFFORTS.has(x)) : [],
        images: m.images === true,
        ratio: typeof m.ratio === 'string' ? m.ratio : undefined,
        // 0.1.4 的缓存没有 known 字段：兜底清单里写过的模型按"已知"处理，
        // 免得升级后离线启动把非思考模型写成三档。
        known: m.known === true || FALLBACK_MODELS.some((f) => f.id === m.id),
      }))
    return models.length > 0 ? { models, at: Number(raw?.at) || 0 } : null
  } catch {
    return null
  }
}

/** 清单没变就不重写（启动同步每次都写盘没有意义）。 */
async function writeModelCache(path, models, previous = null) {
  if (!path) return
  if (previous && JSON.stringify(previous) === JSON.stringify(models)) return
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await mkdir(CRED_DIR, { recursive: true, mode: 0o700 })
    await writeFile(tmp, `${JSON.stringify({ at: Date.now(), models })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (err) {
    log('模型清单缓存写入失败：', String(err?.message ?? err).slice(0, 120))
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

function parseCred(raw, where) {
  const ak = raw.ak ?? raw.accessKeyId
  const sk = raw.sk ?? raw.secretAccessKey
  if (!ak || !sk) throw new Error(`${where} 里缺少 ak / sk`)
  const securityToken = raw.securityToken ?? raw.security_token ?? raw.token
  const expiresAt = raw.expiresAt ?? raw.expires_at
  return {
    ak: String(ak).trim(),
    sk: String(sk).trim(),
    ...(securityToken ? { securityToken: String(securityToken) } : {}),
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
  }
}

/** 环境变量优先，其次新路径，最后兼容原插件的两个路径。 */
export async function loadCredentials() {
  const ak = process.env.MADAO_AK?.trim()
  const sk = process.env.MADAO_SK?.trim()
  if (ak && sk) {
    const token = process.env.MADAO_SECURITY_TOKEN?.trim()
    const expiresAt = process.env.MADAO_SECURITY_TOKEN_EXPIRES?.trim()
    return { key: { ak, sk, ...(token ? { securityToken: token } : {}), ...(token && expiresAt ? { expiresAt } : {}) }, source: '环境变量' }
  }
  // 损坏的凭证文件不该挡住兼容路径：先记下原因，全部试完再报。
  const errors = []
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
      errors.push(`${path} 内容不对：${err?.message ?? err}`)
    }
  }
  if (errors.length > 0) throw new Error(errors.join('；'))
  throw new Error('还没有码道凭证。打开「dshgo-connect-madao」面板，在「凭证设置」里填 AK/SK 后保存。')
}

export async function saveCredentials(ak, sk) {
  await mkdir(CRED_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CRED_PATH}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, JSON.stringify({ ak, sk }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, CRED_PATH)
    await chmod(CRED_PATH, 0o600)
  } finally {
    await unlink(tmp).catch(() => {})
  }
  return CRED_PATH
}

// ── IAM → STS ───────────────────────────────────────────────
async function getSts(ak, sk, durationSeconds = 3600, signal) {
  const body = JSON.stringify({ auth: { identity: { methods: ['token'], token: { duration_seconds: durationSeconds } } } })
  const headers = signIam({ method: 'POST', host: IAM_HOST, path: `${IAM_PATH}/`, contentType: 'application/json;charset=utf8', body, ak, sk })
  const res = await fetch(`https://${IAM_HOST}${IAM_PATH}`, { method: 'POST', headers, body, signal: requestSignal(signal) })
  const text = await res.text()
  if (!res.ok) throw new Error(`换 STS 失败：HTTP ${res.status} ${text.slice(0, 200)}`)
  const cred = JSON.parse(text).credential
  if (!cred?.access || !cred?.secret || !cred?.securitytoken) throw new Error('IAM 响应里没有 credential')
  // 正常会带 expires_at；万一缺了也得给个有限期，否则会一直用过期令牌。
  const parsed = Date.parse(cred.expires_at ?? '')
  const expiresAt = Number.isFinite(parsed) ? cred.expires_at : new Date(Date.now() + Math.max(60, durationSeconds - 600) * 1000).toISOString()
  return { ak: cred.access, sk: cred.secret, securityToken: cred.securitytoken, expiresAt }
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
    if (!Number.isFinite(t)) return Boolean(this.value)
    return Date.now() > t - 600_000
  }
  async get(signal) {
    if (this.value && !this.expiring()) return this.value
    if (!this.pending) {
      this.pending = getSts(this.ak, this.sk, 3600, signal)
        .then((v) => (this.value = v))
        .finally(() => (this.pending = null))
    }
    return this.pending
  }
}

// ── 网关客户端 ──────────────────────────────────────────────
const sha = (v) => createHash('sha256').update(v).digest('hex')

class Client {
  constructor({ gateway, credentials, sessionSeed }) {
    this.gateway = (gateway || GATEWAY).replace(/\/+$/, '')
    this.creds = credentials
    // 固定复用同一个会话 id：网关按它算并发名额（上限 3），每请求换新会占满。
    // 种子必须用长期 AK，不能用 STS 临时 AK —— 那玩意儿每小时轮换一次。
    this.sessionId = `madao-${sha(sessionSeed || credentials.ak || 'default').slice(0, 16)}`
    this.key = null
    this.negotiating = null
  }

  async ensureKey() {
    return this.negotiateWith()
  }

  /** 可中断、可限时的协商；并发调用复用同一次。 */
  async negotiateWith(signal) {
    if (this.key && Date.now() < this.key.expiresAt - REFRESH_MARGIN_MS) return this.key
    if (!this.negotiating) {
      this.negotiating = this.negotiate(signal).finally(() => (this.negotiating = null))
    }
    return this.negotiating
  }

  async negotiate(signal) {
    const url = new URL(this.gateway + KEY_PATH)
    const pair = createEcdhPair()
    const body = JSON.stringify({ clientPublicKey: pair.publicKeyB64, sessionId: randomUUID().replace(/-/g, ''), timestamp: Date.now() })
    const headers = signGateway({ method: 'POST', url, contentType: 'application/json', body, credentials: this.creds })
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'User-Agent': `codearts/${IDENTITY.ideVersion}` },
      body,
      signal: requestSignal(signal),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`密钥协商失败：HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
    }
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

  /** 加密对话，返回已解密的 SSE 文本流；signal 由调用方的“停止 / 断开”触发。 */
  async chat(payload, signal) {
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
      ...(signal ? { signal } : {}),
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

  async getJson(path, signal) {
    const url = new URL(this.gateway + path)
    const headers = await this._signed(url, { method: 'GET' })
    const res = await fetch(url, {
      headers: { ...headers, 'User-Agent': `codearts/${IDENTITY.ideVersion}`, ...this.identityHeaders() },
      signal: requestSignal(signal),
    })
    if (!res.ok) {
      // 带上响应体：网关的 4xx 往往只有这一段能说明原因（缺参数、没权限、签名不对…）。
      const text = await res.text().catch(() => '')
      throw new Error(`GET ${path} 失败：HTTP ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`)
    }
    return res.json()
  }

  async postJson(path, payload, signal) {
    const url = new URL(this.gateway + path)
    const body = JSON.stringify(payload)
    const headers = await this._signed(url, { method: 'POST', contentType: 'application/json', body })
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'User-Agent': `codearts/${IDENTITY.ideVersion}`, ...this.identityHeaders() },
      body,
      signal: requestSignal(signal),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`POST ${path} 失败：HTTP ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`)
    }
    return res.json()
  }

  /** 标记会话 busy / idle，让并发名额及时释放；失败不影响对话。 */
  async heartbeat(status, signal) {
    const path = `/snap-manager/v1/chat-session/heartbeat?status=${status}`
    const url = new URL(this.gateway + path)
    const headers = await this._signed(url, { method: 'PUT' })
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'User-Agent': `codearts/${IDENTITY.ideVersion}`, ...this.identityHeaders(), 'user-session-id': this.sessionId },
      signal: requestSignal(signal, 10_000),
    })
    if (!res.ok) throw new Error(`心跳 ${status} 失败：HTTP ${res.status}`)
    return true
  }
}

/** 上游可能用 \r\n 当行尾：统一成 \n 再拆帧。末尾单独一个 \r 会留到下一块再处理。 */
const normalizeNewlines = (text) => text.replace(/\r\n/g, '\n')

function decryptStream(upstream, session) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let index = 0
  let reader
  const release = async (reason) => {
    try {
      await reader?.cancel(reason)
    } catch {}
    try {
      reader?.releaseLock()
    } catch {}
  }
  const flush = (controller, chunk) => {
    const plain = decryptChunk(session, chunk, index++)
    controller.enqueue(encoder.encode(plain.endsWith('\n\n') ? plain : `${plain}\n\n`))
  }
  return new ReadableStream({
    async start(controller) {
      reader = upstream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            const rest = buffer.trim()
            if (rest) flush(controller, rest)
            try {
              reader.releaseLock()
            } catch {}
            try {
              controller.close()
            } catch {}
            return
          }
          buffer = normalizeNewlines(buffer + decoder.decode(value, { stream: true }))
          let sep
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, sep).trim()
            buffer = buffer.slice(sep + 2)
            if (chunk) flush(controller, chunk)
          }
        }
      } catch (err) {
        await release(err)
        try {
          controller.error(err)
        } catch {}
      }
    },
    async cancel(reason) {
      await release(reason)
    },
  })
}

// ── 模型清单 ────────────────────────────────────────────────
export async function discoverModels(client, signal) {
  try {
    const raw = await client.getJson('/v1/model/builtin', signal)
    const list = raw?.builtinModels ?? []
    if (list.length === 0) return { ok: false, error: '网关返回空模型清单' }
    let variants = {}
    let variantsOk = false
    try {
      variants = (await client.postJson('/v1/model/thinking-variants', { model_names: list.map((m) => m.model_id) }, signal))?.variants ?? {}
      variantsOk = true
    } catch (err) {
      // 拿不到档位声明时当作「判断不了」：provider 侧会退回不思考 / 高 / 最高三档。
      log('思考档位声明拉取失败（改按默认三档）：', String(err?.message ?? err).slice(0, 120))
    }
    const models = list
      .filter((m) => m?.model_id && m.enable !== false)
      .map((m) => {
        const v = variants[m.model_id]
        const fb = FALLBACK_MODELS.find((f) => f.id === m.model_id)
        const context = Number(m.context_window ?? fb?.context ?? 0)
        if (!Number.isFinite(context) || context <= 0) {
          log(`模型 ${m.model_id} 缺少有效 context_window，已跳过`)
          return null
        }
        const rawMax = Number(m.max_tokens ?? fb?.maxOutput ?? MAX_OUTPUT_CAP)
        const maxOutput = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, MAX_OUTPUT_CAP) : MAX_OUTPUT_CAP
        const strengths = [...new Set((Array.isArray(v?.strengths) ? v.strengths : []).filter((s) => typeof s === 'string' && s !== 'off' && VALID_EFFORTS.has(s)))]
        return {
          id: String(m.model_id),
          name: String(m.model_name || m.model_id),
          context,
          // 输出上限别照抄网关：DSH 会把它和 headroom 一起从窗口里扣掉。
          maxOutput,
          ratio: m.credit?.[0]?.ratio_display,
          images: m.supports_images === true,
          strengths,
          // 网关真的声明过这个模型的档位吗？没声明 = 判断不了，走默认三档。
          known: variantsOk && Boolean(v) && Array.isArray(v.strengths),
          defaultStrength: typeof v?.default_strength === 'string' ? v.default_strength : undefined,
        }
      })
      .filter(Boolean)
    if (models.length === 0) return { ok: false, error: '网关清单里没有可用模型（可能全部被停用或缺少上下文窗口）' }
    return { ok: true, models, source: 'gateway' }
  } catch (err) {
    const message = String(err?.message ?? err)
    log('模型清单拉取失败，保留现有清单：', message)
    return { ok: false, error: message }
  }
}

// ── 额度 ────────────────────────────────────────────────────
const metric = (list, name) => list.find((m) => m?.name === name)
const pkgOf = (m) => (m ? { amount: Number(m.package_credit_amount ?? 0), used: Number(m.package_credit_used ?? 0), remain: Number(m.package_credit_remain ?? 0) } : undefined)

/** @returns {{ credit: object } | { error: string }} 失败时把原因交给调用方，由它决定退避与日志。 */
async function queryCredit(client, signal) {
  try {
    const r = await client.getJson('/snap-manager/v1/statistics/plugin', signal)
    const list = r?.metrics ?? []
    const total = metric(list, 'usageTotalPackageCredit')
    if (!total) return { error: '额度接口没有 usageTotalPackageCredit 指标' }
    const bonus = metric(list, 'usageBonusPackageCredit')
    return {
      credit: {
        total: Number(total.package_credit_amount ?? 0),
        used: Number(total.package_credit_used ?? 0),
        remain: Number(total.package_credit_remain ?? 0),
        basic: pkgOf(metric(list, 'usageBasicPackageCredit')),
        bonus: pkgOf(bonus),
        expiring: Number(bonus?.package_credit_expiring_amount ?? 0) || 0,
        end: typeof r?.end_date === 'string' ? r.end_date : undefined,
        at: Date.now(),
      },
    }
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 300) }
  }
}

// ── 每日签到 ────────────────────────────────────────────────
const CHECKIN_CAMPAIGN = 34

const dailyView = (it) => ({
  campaignId: Number(it?.campaignId),
  title: String(it?.title ?? '每日签到'),
  status: it?.status ?? null,
  claimable: it?.claimable === true || it?.claimable === 1,
  amount: Number(it?.pendingTotalAmount ?? it?.benefitAmount ?? 0),
  unit: String(it?.benefitUnit ?? 'CREDIT'),
  expireAt: it?.expireAt ?? null,
})

async function fetchCampaigns(client, signal) {
  const d = await client.getJson('/v1/ops/delivery?channel=IDE', signal)
  const items = d?.data?.items
  return Array.isArray(items) ? items : []
}

/** 只关心每日签到那个活动（campaignId=34）。 */
export async function queryCheckin(client, signal) {
  const daily = (await fetchCampaigns(client, signal)).find((x) => Number(x?.campaignId) === CHECKIN_CAMPAIGN)
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
  // claimable 是网关的权威判断；status 只用于解释原因，不能再把它当门槛。
  if (!state.claimable) {
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
  const confirmedAmount = Number(r?.data?.totalAmount)
  return {
    ...state,
    claimed,
    claimable: false,
    status: r?.data?.status ?? (claimed ? 'CONFIRMED' : state.status),
    // 网关没回 totalAmount 时保留「待领取额」，别把两个数混着当到账金额。
    ...(claimed && Number.isFinite(confirmedAmount) ? { amount: confirmedAmount } : {}),
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

function hasImage(messages) {
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue
    for (const p of m.content) if (p?.type === 'image_url') return true
  }
  return false
}

/** 输出上限按模型收敛：不传就用模型上限，传大了也压回去，别拿网关不认的值去撞 400。 */
function clampMaxTokens(requested, maxOutput) {
  const cap = Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : DEFAULT_MAX_TOKENS
  const value = Number(requested)
  if (!Number.isFinite(value) || value <= 0) return cap
  return Math.min(Math.floor(value), cap)
}

function upstreamBody(req, maxOutput) {
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
    max_tokens: clampMaxTokens(req.max_tokens ?? req.max_completion_tokens, maxOutput),
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
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) yield* parse(normalizeNewlines(buffer))
        return
      }
      buffer = normalizeNewlines(buffer + decoder.decode(value, { stream: true }))
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        yield* parse(block)
      }
    }
  } finally {
    // 消费方 break / 取消 / 上游报错时，把底层连接一起收掉。
    try {
      await reader.cancel()
    } catch {}
    try {
      reader.releaseLock()
    } catch {}
  }
}

const chunk = (id, model, delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })
const line = (payload) => `data: ${JSON.stringify(payload)}\n\n`

// ── 桥接服务 ────────────────────────────────────────────────
export function createBridge({ port = PORT, gateway, onModels, onChange, refreshMs = 15_000, modelCache = MODEL_CACHE_PATH } = {}) {
  const cached = readModelCache(modelCache)
  const state = {
    loaded: null,
    configured: false,
    client: null,
    sts: null,
    // 手填 / 环境变量的临时令牌的到期时间（0 = 不用临时令牌）
    tokenOnly: 0,
    lastCreds: null,
    // 本次运行里网关拒绝过"关闭思考"的模型；只影响本次运行，不落盘、不改 provider。
    noOff: new Set(),
    error: null,
    listenError: null,
    heartbeatFailures: 0,
    heartbeatError: null,
    // 优先用上次成功同步的清单：离线重启也能解析 provider 里已有的模型 id。
    models: cached ? cached.models : FALLBACK_MODELS,
    modelsSource: cached ? 'cache' : 'fallback',
    modelsCachedAt: cached?.at || 0,
    credit: null,
    creditError: null,
    creditFailures: 0,
    checkin: null,
    checkinError: null,
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

  /** 有成功证据时清掉旧的自检失败，别让状态条一直红。 */
  function clearTestFailure() {
    const t = state.test
    if (t && !t.stale && (t.ok === false || t.warn)) {
      state.test = { ...t, stale: true }
      notify()
    }
  }

  async function connect(signal) {
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
        state.sts = null
        state.credit = null
        state.creditError = null
        state.creditFailures = 0
        state.checkin = null
        state.lastCreds = null
        state.test = null
        return false
      }
      // 凭证存在就算“已配置”，后面握不上手只影响状态，不影响这一判断
      state.loaded = loaded
      state.configured = true
      state.error = null
      const tokenExpiry = Date.parse(loaded.key.expiresAt ?? '')
      const tokenExpired = Number.isFinite(tokenExpiry) && tokenExpiry - Date.now() <= 60_000
      if (loaded.key.securityToken && !tokenExpired) {
        // 手填 / 环境变量带的临时令牌：直接用。它一定会过期，过期后自动退回 STS（见 ensureFresh）。
        state.sts = null
        state.tokenOnly = Number.isFinite(tokenExpiry) ? tokenExpiry : 0
        state.lastCreds = loaded.key
        state.client = new Client({ gateway, credentials: loaded.key, sessionSeed: loaded.key.ak })
        if (!Number.isFinite(tokenExpiry)) {
          log('凭证里的 securityToken 没有 expiresAt：无法预判过期，401 后请重填或改用 AK/SK')
        }
      } else {
        // AK/SK（或过期令牌）：换 STS，之后自动续期。
        state.sts = new StsCache(loaded.key.ak, loaded.key.sk)
        state.tokenOnly = 0
        state.lastCreds = await state.sts.get(signal)
        state.client = new Client({ gateway, credentials: state.lastCreds, sessionSeed: loaded.key.ak })
      }
      state.test = null
      return true
    } catch (err) {
      state.error = String(err?.message ?? err)
      state.client = null
      state.credit = null
      state.creditError = null
      state.creditFailures = 0
      state.checkin = null
      state.lastCreds = null
      state.test = null
      return false
    } finally {
      notify()
    }
  }

  /** 临时 STS 只有一小时，过期前换新的；手填令牌到期后自动改走 AK/SK；凭证变了就重建客户端。 */
  async function ensureFresh(signal) {
    // 手填 / 环境变量的临时令牌：到期前 1 分钟自动换成 STS，别让用户手动重填。
    if (state.tokenOnly && !state.sts && state.client) {
      if (Date.now() < state.tokenOnly - 60_000) return
      const ak = state.loaded?.key.ak
      const sk = state.loaded?.key.sk
      if (!ak || !sk) {
        log('临时令牌已过期，且没有 AK/SK 可以续期：请在面板重新填写凭证')
        return
      }
      state.sts = new StsCache(ak, sk)
      state.tokenOnly = 0
      log('临时令牌即将过期，改走 AK/SK 换 STS')
    }
    if (!state.sts || !state.client) return
    try {
      const creds = await state.sts.get(signal)
      if (creds !== state.lastCreds) {
        state.lastCreds = creds
        state.client = new Client({ gateway, credentials: creds, sessionSeed: state.loaded?.key.ak })
        log('STS 已续期，客户端已重建')
      }
    } catch (err) {
      log('STS 续期失败：', err?.message ?? err)
    }
  }

  async function reload() {
    await connect()
    void refreshCredit({ force: true })
    void refreshCheckin({ force: true })
    return Boolean(state.client)
  }

  /** 签到状态变化很慢；失败时保留上一次结果，不要抹成「未查询」。 */
  async function refreshCheckin({ force = false } = {}) {
    if (!state.client) return null
    if (!force && state.checkin && Date.now() - state.checkinAt < 60_000) return state.checkin
    await ensureFresh()
    if (!state.client) return null
    try {
      state.checkin = await queryCheckin(state.client)
      state.checkinError = null
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 200)
      if (state.checkinError !== message) log('签到状态查询失败（保留上次结果）：', message)
      state.checkinError = message
    }
    state.checkinAt = Date.now()
    notify()
    return state.checkin
  }

  async function checkin() {
    if (!state.client) return { ok: false, reason: '还没有可用凭证' }
    await ensureFresh()
    if (!state.client) return { ok: false, reason: '没有可用凭证' }
    const r = await claimCheckin(state.client)
    state.checkin = r
    state.checkinAt = Date.now()
    state.checkinError = null
    clearTestFailure()
    notify()
    return r
  }

  let creditPending = null
  /** 失败后指数退避（最长 5 分钟），并且只在首次失败/次数变化时打一行日志。 */
  function creditBackoffMs() {
    return Math.min(30_000 * 2 ** Math.max(0, Math.min(state.creditFailures - 1, 3)), 300_000)
  }
  let creditAt = 0
  async function refreshCredit({ force = false } = {}) {
    if (!state.client) return null
    await ensureFresh()
    if (!state.client) return null
    if (creditPending) return creditPending
    const now = Date.now()
    const base = Math.min(2000, Math.max(250, Number(refreshMs) || 2000))
    // force 跳过失败退避（用户主动点开面板 / 重存凭证），但仍保留最小间隔，避免连点刷网关。
    const floor = state.creditFailures > 0 && !force ? Math.max(base, creditBackoffMs()) : base
    if (now - creditAt < floor) return state.credit
    creditPending = queryCredit(state.client)
      .then((r) => {
        if (r.credit) {
          state.credit = r.credit
          if (state.creditError) log('额度查询已恢复')
          state.creditError = null
          state.creditFailures = 0
          clearTestFailure()
        } else {
          state.creditFailures += 1
          state.creditError = r.error
          // 只在第一次和每 10 次记一次，避免刷屏
          if (state.creditFailures === 1 || state.creditFailures % 10 === 0) log(`额度查询失败（第 ${state.creditFailures} 次，退避 ${Math.round(creditBackoffMs() / 1000)}s）：`, r.error)
        }
        notify()
        return state.credit
      })
      .finally(() => {
        creditAt = Date.now()
        creditPending = null
      })
    return creditPending
  }

  async function syncModels(signal) {
    if (!state.client) return { ok: false, error: '还没有可用凭证' }
    await ensureFresh(signal)
    if (!state.client) return { ok: false, error: '没有可用凭证' }
    const found = await discoverModels(state.client, signal)
    if (!found.ok) {
      log('模型清单未更新，保留现有清单：', found.error)
      return { ok: false, error: found.error, models: state.models.length, source: state.modelsSource }
    }
    const previous = state.models
    state.models = found.models
    state.modelsSource = found.source
    state.modelsCachedAt = Date.now()
    notify()
    void writeModelCache(modelCache, found.models, previous)
    clearTestFailure()
    const written = onModels ? await onModels(found.models) : null
    return { ok: true, models: found.models.length, source: found.source, written }
  }

  /** 自检：凭证 → 密钥协商 → 模型清单（硬）+ 额度 / 签到（软）。
   * 额度或签到挂了只算“提醒”，不该让整个连接状态变红；总时长压到 50 秒内，
   * 免得宿主 60 秒的 pending 先超时、结果丢掉。 */
  let testPromise = null
  function test(signal) {
    if (testPromise) return testPromise
    testPromise = runTest(signal).finally(() => {
      testPromise = null
    })
    return testPromise
  }
  async function runTest(signal) {
    state.testing = true
    notify()
    try {
      return await runTestSteps(signal)
    } finally {
      state.testing = false
      notify()
    }
  }
  async function runTestSteps(signal) {
    const deadline = Date.now() + 50_000
    const left = () => Math.max(1000, Math.min(META_TIMEOUT_MS, deadline - Date.now()))
    const slice = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(left())]) : AbortSignal.timeout(left()))
    const steps = []
    const step = async (name, fn, { optional = false } = {}) => {
      const t0 = Date.now()
      try {
        const detail = await fn()
        steps.push({ name, ok: true, optional, detail, ms: Date.now() - t0 })
        return true
      } catch (err) {
        steps.push({ name, ok: false, optional, detail: String(err?.message ?? err).slice(0, 160), ms: Date.now() - t0 })
        return false
      }
    }
    const credOk = await step('凭证', async () => {
      await connect(signal)
      if (!state.client) throw new Error(state.error ?? '未配置')
      return `${state.loaded?.source ?? '凭证'} · ${state.loaded.key.ak.slice(0, 4)}…`
    })
    if (credOk) {
      await step('密钥协商', async () => {
        state.client.key = null
        await state.client.negotiateWith(slice())
        return `keyId ${String(state.client.key?.keyId ?? '').slice(0, 8)}`
      })
      await step('模型清单', async () => {
        const r = await syncModels(slice())
        if (!r.ok) throw new Error(r.error)
        return `${r.models} 个（${r.source}）`
      })
      await step(
        '额度',
        async () => {
          const r = await queryCredit(state.client, slice())
          if (!r.credit) {
            state.creditError = r.error
            throw new Error(r.error)
          }
          state.credit = r.credit
          state.creditError = null
          state.creditFailures = 0
          return `剩余 ${r.credit.remain} / ${r.credit.total}`
        },
        { optional: true },
      )
      await step(
        '签到',
        async () => {
          const c = await queryCheckin(state.client, slice())
          state.checkin = c
          state.checkinAt = Date.now()
          state.checkinError = null
          // 没有活动是正常状态，不该让整个自检变红。
          if (!c.available) return c.reason ?? '无签到活动'
          return c.claimable ? '今日可领取' : `今日${c.status ?? '不可领'}`
        },
        { optional: true },
      )
    }
    const hard = steps.filter((s) => !s.optional)
    const softFailed = steps.some((s) => s.optional && !s.ok)
    state.test = { ok: hard.every((s) => s.ok), steps, at: Date.now(), ...(softFailed ? { warn: true } : {}) }
    return state.test
  }

  /** 心跳是释放网关并发名额（上限 3）的唯一手段，失败不能静默：记次数，只在首次 / 每 10 次打一行。 */
  async function sendHeartbeat(client, status) {
    try {
      await client.heartbeat(status)
      if (state.heartbeatFailures > 0) {
        state.heartbeatFailures = 0
        state.heartbeatError = null
        notify()
      }
      return true
    } catch (err) {
      state.heartbeatFailures += 1
      state.heartbeatError = String(err?.message ?? err).slice(0, 160)
      if (state.heartbeatFailures === 1 || state.heartbeatFailures % 10 === 0) {
        log(`心跳失败（第 ${state.heartbeatFailures} 次，可能占着并发名额）：`, state.heartbeatError)
        notify()
      }
      return false
    }
  }

  async function chatCompletion(res, client, rawBody) {
    if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return sendJson(res, 400, { error: { message: '请求体必须是 JSON 对象', type: 'invalid_request_error' } })
    }
    if (!Array.isArray(rawBody.messages) || rawBody.messages.some((m) => m === null || typeof m !== 'object' || Array.isArray(m))) {
      return sendJson(res, 400, { error: { message: 'messages 必须是消息对象数组', type: 'invalid_request_error' } })
    }
    const bad = unsupportedPart(rawBody.messages)
    if (bad) return sendJson(res, 400, { error: { message: `不支持的内容类型：${bad}。码道路由只认 text 和 image_url。`, type: 'unsupported_content' } })

    const model = resolveModel(rawBody.model, state.models)
    if (!model) {
      const names = state.models.map((m) => m.id).join('、')
      return sendJson(res, 400, { error: { message: `未知模型 ${JSON.stringify(String(rawBody.model ?? ''))}。可用：${names}`, type: 'model_not_found' } })
    }
    const body = { ...rawBody, model, effort: rawBody.strength ?? rawBody.reasoning_effort }
    const info = state.models.find((m) => m.id === model)
    // 图片：模型不支持就别发出去等网关回一句看不懂的 400。
    if (info && info.images !== true && hasImage(rawBody.messages)) {
      return sendJson(res, 400, {
        error: { message: `「${info.name}」不支持图片输入，请换成支持图片的模型，或去掉图片再发。`, type: 'unsupported_content' },
      })
    }
    const upstream = upstreamBody(body, info?.maxOutput)
    // 本次运行已验证该模型关不掉思考：别再发一次 none 去换一次 400。
    if (upstream.reasoning_effort === 'none' && state.noOff.has(model)) delete upstream.reasoning_effort

    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(upstream))
    } catch {}
    if (bytes > BODY_LIMIT) {
      return sendJson(res, 413, { error: { message: `明文请求体 ${(bytes / 1048576).toFixed(1)} MB，加密后约 ${(bytes * 4 / 3 / 1048576).toFixed(1)} MB，超过网关约 ${(GATEWAY_BODY_LIMIT / 1048576).toFixed(0)} MB 上限。请压缩会话或减少工具定义。`, type: 'request_too_large' } })
    }
    const est = estimateTokens(rawBody.messages) + (Array.isArray(rawBody.tools) ? estimateTokens(rawBody.tools) : 0)
    if (info?.context > 0 && est > (info.context - 4096) * 1.2) {
      return sendJson(res, 400, {
        error: { message: `上下文超出「${info.name}」的窗口 ${info.context}：估算 ${est} tokens（含工具定义）。压缩会话、减少工具，或换窗口更大的模型。`, type: 'context_length_exceeded' },
      })
    }

    const id = `chatcmpl-${Date.now().toString(36)}`
    const wantStream = rawBody.stream !== false
    // 客户端断开 / 点“停止”时取消上游，别继续烧 token。
    const abort = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) abort.abort(new Error('client closed'))
    }
    res.on('close', onClose)
    void sendHeartbeat(client, 'busy')
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      void sendHeartbeat(client, 'idle')
    }
    // 网关拒绝“关闭思考”的措辞：明确说“不能关/不支持 none”，或点名 reasoning_effort=off/none。
    // 不要一看到 reasoning_effort 字样就当成关不掉 —— “Invalid reasoning_effort: 'low'”
    // 是档位不被接受，误判会把 off 档永久删掉，还会静默吞掉用户的强度设置。
    const alwaysThinks = (text) =>
      /始终思考|不支持关闭思考|reasoning[_ ]?effort\s*[=:：]\s*["']?(?:none|off)["']?[^。.;\n]{0,30}(?:not\s+supported|unsupported|invalid|not\s+allowed|not\s+permitted|rejected|不支持|无效|不允许)|(?:none|off)\s*(?:is\s+)?(?:not\s+supported|unsupported|invalid|not\s+allowed|not\s+permitted|rejected|不支持|无效|不允许)/i.test(
        String(text ?? ''),
      )
    // 只吐了一部分内容时不能再重发：用户会看到重复正文，也算两份 token。
    let emittedContent = false
    const learnNoOff = (id) => {
      if (state.noOff.has(id)) return
      state.noOff.add(id)
      notify()
      // 只记在本次运行的内存里：provider 的档位由 lib/efforts.js 的规则表决定，
      // 这里只是避免同一次运行里反复用会被拒的档位去撞网关。
      log(`${id} 拒绝了关闭思考，本次运行不再给该模型发 none（档位仍按规则表）`)
    }
    // 网关有时接受 none 但仍在思考：usage 里 reasoning_tokens>0 也算关不掉。
    const learnNoOffFromUsage = (u) => {
      if (upstream.reasoning_effort !== 'none') return
      if (Number(u?.completion_tokens_details?.reasoning_tokens ?? 0) > 0) learnNoOff(model)
    }
    /** 关思考被网关拒绝时：记住、去掉 off 重发。错误可能出现在 HTTP 层，也可能是一帧 SSE。 */
    const retryWithoutEffort = async () => {
      const body = { ...upstream }
      delete body.reasoning_effort
      return client.chat(body, abort.signal)
    }

    let triedOff = false
    let upstreamStream
    try {
      upstreamStream = await client.chat(upstream, abort.signal)
    } catch (err) {
      const message = String(err?.message ?? err)
      if (abort.signal.aborted) {
        done()
        return
      }
      if (upstream.reasoning_effort === 'none' && !triedOff && alwaysThinks(message)) {
        triedOff = true
        learnNoOff(model)
        try {
          upstreamStream = await retryWithoutEffort()
        } catch (err2) {
          done()
          if (abort.signal.aborted) return
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
          if (ev.error && upstream.reasoning_effort === 'none' && !triedOff && !emittedContent && alwaysThinks(ev.error.message)) {
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
          if (ev.reasoning) {
            reasoning += ev.reasoning
            emittedContent = true
          }
          if (ev.text) {
            text += ev.text
            emittedContent = true
          }
          if (ev.toolCalls) {
            emittedContent = true
            for (const tc of ev.toolCalls) {
              // 续传帧经常不带 index：沿用上一个调用，别把参数拆成第二个调用。
              const i = typeof tc?.index === 'number' ? tc.index : Math.max(0, calls.length - 1)
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
            if (abort.signal.aborted) return
            return sendJson(res, 400, { error: { message: `${ev.error.message}（${ev.error.code}）`, type: 'upstream_error', code: ev.error.code } })
          }
          if (ev.finish) finish = ev.finish
          if (ev.usage) usage = ev.usage
        }
      } catch (err) {
        done()
        if (abort.signal.aborted) return
        return sendJson(res, 502, { error: { message: String(err?.message ?? err), type: 'upstream_error' } })
      }
      if (abort.signal.aborted) {
        done()
        return
      }
      learnNoOffFromUsage(usage)
      res.off('close', onClose)
      done()
      // 这次对话真的成功了，说明连接是好的：别再让状态条挂着上一次的自检失败。
      clearTestFailure()
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

    if (abort.signal.aborted) {
      done()
      return
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
        if (abort.signal.aborted) break
        if (ev.reasoning) {
          emittedContent = true
          res.write(line(chunk(id, model, { reasoning_content: ev.reasoning })))
        }
        if (ev.text) {
          emittedContent = true
          res.write(line(chunk(id, model, { content: ev.text })))
        }
        if (ev.toolCalls) {
          emittedContent = true
          res.write(line(chunk(id, model, { tool_calls: ev.toolCalls })))
        }
        if (ev.error) {
          res.write(line({ error: { message: `${ev.error.message}（${ev.error.code}）`, type: 'upstream_error', code: ev.error.code } }))
          break
        }
        if (ev.finish) finish = ev.finish
        if (ev.usage) usage = ev.usage
      }
    } catch (err) {
      if (!abort.signal.aborted) res.write(line({ error: { message: String(err?.message ?? err), type: 'upstream_error' } }))
    }
    if (abort.signal.aborted) {
      done()
      try {
        res.end()
      } catch {}
      return
    }
    learnNoOffFromUsage(usage)
    if (usage) res.write(line({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage }))
    res.write(line(chunk(id, model, {}, finish ?? 'stop')))
    res.write('data: [DONE]\n\n')
    res.off('close', onClose)
    res.end()
    done()
    clearTestFailure()
    void refreshCredit()
  }

  function sendJson(res, status, payload, extraHeaders) {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extraHeaders })
    res.end(text)
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let failed = false
      const limit = BODY_LIMIT + 1_000_000
      const tooLarge = () => {
        const err = new Error(`请求体 ${(size / 1048576).toFixed(1)} MB 超过本机桥上限 ${(limit / 1048576).toFixed(1)} MB`)
        err.code = 'PAYLOAD_TOO_LARGE'
        return err
      }
      req.on('data', (c) => {
        if (failed) return
        size += c.length
        if (size > limit) {
          // 已经确定要回 413：别再往下攒内存（数据照样从 socket 流走并被丢掉）。
          failed = true
          chunks.length = 0
          return reject(tooLarge())
        }
        chunks.push(Buffer.from(c))
      })
      req.on('end', () => {
        if (failed) return
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', (err) => {
        if (failed) return
        failed = true
        reject(err)
      })
    })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    // 本机桥只服务引擎：浏览器跨源请求一律拒绝，也不发任何 CORS 放行头。
    if (req.headers.origin) {
      return sendJson(res, 403, { error: { message: '浏览器来源不允许访问本机桥', type: 'forbidden_origin' } })
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    const authorized = req.headers.authorization === `Bearer ${BRIDGE_TOKEN}`
    if (url.pathname === '/healthz' || url.pathname === '/v1/status') {
      // 未带 token 只给最少的存活信息，不暴露额度 / AK / 签到。
      if (!authorized) {
        return sendJson(res, 200, { ok: Boolean(state.client), stage: state.client ? 'ready' : state.configured ? 'handshake' : 'credentials' })
      }
      return sendJson(res, 200, status())
    }
    if (!authorized) {
      return sendJson(res, 401, { error: { message: `需要 Authorization: Bearer ${BRIDGE_TOKEN}`, type: 'unauthorized' } })
    }
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
          // provider 里实际会写的档位（规则表决定），方便排查"为什么没有 off"。
          efforts: effortsFor(m.id, m.strengths, m.known),
        })),
      })
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return sendJson(res, 415, { error: { message: '请求体必须是 application/json', type: 'unsupported_media_type' } })
      }
      await ensureFresh()
      if (!state.client) return sendJson(res, 503, { error: { message: state.error ?? '还没有可用凭证', type: 'credentials_error' } })
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        if (err?.code === 'PAYLOAD_TOO_LARGE') {
          // 请求体还没读完就回 413：顺便告诉对端别再传了。
          return sendJson(res, 413, { error: { message: `${err.message}。请压缩会话、开新会话或减少工具定义。`, type: 'request_too_large' } }, { Connection: 'close' })
        }
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
      version: PLUGIN_VERSION,
      stage: state.client ? 'ready' : state.listenError ? 'bridge' : state.configured ? 'handshake' : 'credentials',
      configured: state.configured,
      error: state.error ?? state.listenError ?? undefined,
      ak: state.loaded ? `${state.loaded.key.ak.slice(0, 4)}…${state.loaded.key.ak.slice(-4)}` : undefined,
      source: state.loaded?.source,
      stsUntil: state.sts?.value?.expiresAt,
      models: state.models.length,
      modelsSource: state.modelsSource,
      credit: c ? { remain: c.remain, total: c.total, used: c.used, expiring: c.expiring, end: c.end, at: c.at } : null,
      creditError: state.creditError,
      creditFailures: state.creditFailures,
      checkin: state.checkin,
      checkinError: state.checkinError,
      // 本次运行里拒绝过"关闭思考"的模型（不落盘；provider 档位由 lib/efforts.js 决定）
      noOff: [...state.noOff],
      heartbeatFailures: state.heartbeatFailures,
      heartbeatError: state.heartbeatError,
      tokenOnly: Boolean(state.tokenOnly),
      checkinAt: state.checkinAt || undefined,
      modelsCachedAt: state.modelsCachedAt || undefined,
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
    // 签到状态一天只变一两次，没必要跟着额度一起高频刷（原先 75 秒一次）。
    welfareTimer = setInterval(() => {
      if (state.client) void refreshCheckin()
    }, Math.max(refreshMs * 20, 300_000))
    welfareTimer.unref?.()
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // 客户端中途断开时写响应会抛：这里再兜一层，别让一个断连把进程带走。
      try {
        if (!res.headersSent) sendJson(res, 500, { error: { message: String(err?.message ?? err), type: 'internal_error' } })
        else res.end()
      } catch {}
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
        const onError = (err) => {
          server.off('error', onError)
          state.listenError = String(err?.message ?? err)
          reject(err)
        }
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          state.listenError = null
          resolve(`http://127.0.0.1:${port}`)
        })
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