// 模拟码道网关（测试用）：签名校验、P-256 协商、SM4-GCM 请求解密 / SSE 加密。
// 先让原插件 dsh-connect-madao 跑通 → 证明这套服务端与它的协议理解一致；
// 再让 dshgo-connect-madao 跑同一套 → 验证重写后的客户端与原实现等价。
import { createServer } from 'node:http'
import { createECDH, createHash, randomBytes } from 'node:crypto'
import { sm4GcmDecrypt, sm4GcmEncrypt, signGateway } from '../lib/crypto.js'

const AK = 'TESTAKTESTAKTESTAK00'
const SK = 'testSKtestSKtestSKtestSKtestSKtestSK00'
const TOKEN = 'test-security-token'
const creds = { ak: AK, sk: SK, securityToken: TOKEN }

const keyFromShared = (shared) => ({ key: createHash('sha256').update(shared).digest().subarray(0, 16) })

function encryptSseChunk(key, keyId, plain, index) {
  const iv = randomBytes(12)
  const aad = Buffer.from(`${keyId}|${index}`, 'utf8')
  const { ciphertext, tag } = sm4GcmEncrypt(key.key, iv, Buffer.from(plain, 'utf8'), aad)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}\n\n`
}

export function startMock(port = 8790) {
  const sessions = new Map()
  const seen = []
  // 福利活动：每次起服务都是「今日可签到」的初始状态
  const welfare = {
    items: [
      { campaignId: 34, title: '每日签到', type: 'USER_LOGIN', status: 'ELIGIBLE', claimable: true, benefitAmount: 10, pendingTotalAmount: 10, benefitUnit: 'CREDIT', extra: { triggerEvent: 'user.login', triggerMode: 'MANUAL' } },
      { campaignId: 12, title: '新用户礼包', type: 'AUTO_GRANT', status: 'CONFIRMED', claimable: false, benefitAmount: 50, benefitUnit: 'CREDIT', extra: { triggerMode: 'AUTO_GRANT' } },
    ],
  }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url, `http://${req.headers.host}`)
    const record = { method: req.method, path: url.pathname, headers: { ...req.headers }, bytes: raw.length }
    seen.push(record)

    // 用同一套 signGateway 重算签名：原插件发来的签名能对上，说明两边的规范化/哈希一致。
    const expected = signGateway({
      method: req.method,
      url,
      contentType: req.headers['content-type'],
      bodyBytes: raw,
      credentials: creds,
      date: req.headers['x-sdk-date'],
    })
    if (expected.Authorization !== req.headers.authorization) {
      record.error = 'signature mismatch'
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"error":"signature"}')
    }

    if (url.pathname === '/api/v1/security/key-exchange') {
      const body = JSON.parse(raw.toString())
      const ecdh = createECDH('prime256v1')
      const serverPub = ecdh.generateKeys()
      const key = keyFromShared(ecdh.computeSecret(Buffer.from(body.clientPublicKey, 'base64')))
      const keyId = `key-${randomBytes(4).toString('hex')}`
      sessions.set(keyId, key)
      record.keyId = keyId
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ keyId, serverPublicKey: serverPub.toString('base64'), expiresIn: 7200 }))
    }

    if (url.pathname === '/v1/model/builtin') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          builtinModels: [
            { model_id: 'mock-fast', model_name: 'Mock-Fast', context_window: 202752, max_tokens: 65536, supports_images: true, enable: true, credit: [{ ratio_display: '0.1x' }] },
            { model_id: 'mock-pro', model_name: 'Mock-Pro', context_window: 1048576, max_tokens: 32768, supports_images: false, enable: true, credit: [{ ratio_display: '1.0x' }] },
          ],
        }),
      )
    }
    if (url.pathname === '/v1/model/thinking-variants') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ variants: { 'mock-pro': { strengths: ['high', 'max'], default_strength: 'high' } } }))
    }
    if (url.pathname === '/snap-manager/v1/statistics/plugin') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 500, package_credit_used: 120, package_credit_remain: 380, package_credit_expiring_amount: 20 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 120, package_credit_remain: 380 },
          ],
          end_date: '2027-01-01',
        }),
      )
    }
    if (url.pathname === '/v1/ops/delivery') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 0, data: { items: welfare.items } }))
    }
    if (url.pathname === '/v1/ops/claim') {
      const body = JSON.parse(raw.toString())
      const item = welfare.items.find((x) => x.campaignId === body.campaignId)
      if (!item || !item.claimable) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ code: 400, message: 'not claimable' }))
      }
      item.claimable = false
      item.status = 'CONFIRMED'
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 0, data: { status: 'CONFIRMED', totalAmount: item.benefitAmount, claimedAt: new Date().toISOString() } }))
    }
    if (url.pathname === '/v1/ops/confirm') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 0, data: { ok: true } }))
    }
    if (url.pathname.startsWith('/snap-manager/v1/chat-session/heartbeat')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }

    if (url.pathname === '/api/v2/chat/completions') {
      const keyId = req.headers['x-encrypt-key-id']
      const key = sessions.get(keyId)
      if (!key) {
        record.error = 'unknown keyId'
        res.writeHead(401)
        return res.end('{}')
      }
      const ts = req.headers['x-encrypt-ts']
      const aad = Buffer.from(`POST|/api/v2/chat/completions|${ts}`, 'utf8')
      let payload
      try {
        payload = JSON.parse(
          sm4GcmDecrypt(
            key.key,
            Buffer.from(req.headers['x-encrypt-iv'], 'base64'),
            Buffer.from(raw.toString('utf8'), 'base64'),
            Buffer.from(req.headers['x-encrypt-tag'], 'base64'),
            aad,
          ).toString('utf8'),
        )
      } catch (err) {
        record.error = `decrypt: ${err.message}`
        res.writeHead(400)
        return res.end('{}')
      }
      record.model = payload.model
      record.roles = (payload.messages ?? []).map((m) => m.role)
      record.reasoningEffort = payload.reasoning_effort
      record.maxTokens = payload.max_tokens
      record.hasTools = Boolean(payload.tools)

      // glm-5.3 系列的行为：不接受关闭思考
      if (payload.reasoning_effort === 'none') {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'InferHub.ModelArts.81001', message: '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。' } }))
      }

      const frames = [
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想一想。' } }] },
        { choices: [{ index: 0, delta: { content: `你好，${payload.model}。` } }] },
        { choices: [{ index: 0, delta: { content: '第二段。' } }] },
        ...(payload.tools ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"' } }] } }] }] : []),
        ...(payload.tools ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ',"x":1}' } }] } }] }] : []),
        { choices: [{ index: 0, delta: {}, finish_reason: payload.tools ? 'tool_calls' : 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } } },
      ]

      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-encrypt-algo': 'sm4-gcm' })
      let index = 0
      for (const frame of frames) res.write(encryptSseChunk(key, keyId, `data: ${JSON.stringify(frame)}\n\n`, index++))
      res.write(encryptSseChunk(key, keyId, 'data: [DONE]\n\n', index++))
      return res.end()
    }

    res.writeHead(404)
    res.end('{}')
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, seen, welfare, close: () => new Promise((r) => {
      server.close(() => r())
      server.closeAllConnections?.()
    }) })),
  )
}