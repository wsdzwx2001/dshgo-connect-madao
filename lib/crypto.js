// 码道网关的密码层：SM4-GCM 载荷加解密、P-256 密钥协商、华为云 SDK-HMAC-SHA256 签名。
// 算法与常量按 dsh-connect-madao（MIT）实测结果重写，行为等价、体积更小。
import { createECDH, createHash, createHmac, randomBytes } from 'node:crypto'

// SBOX / CK 压成十六进制字符串，避免几百行数字字面量。
const SBOX = Buffer.from(
  'd690e9fecce13db716b614c228fb2c052b679a762abe04c3aa441326498606999c4250f491ef987a33540b43edcfac62e4b31ca9c908e89580df94fa758f3fa64707a7fcf37317ba83593c19e6854fa8686b81b27164da8bf8eb0f4b70569d351e240e5e6358d1a225227c3b01217887d40046579fd327524c3602e7a0c4c89eeabf8ad240c738b5a3f7f2cef96115a1e0ae5da49b341a55ad933230f58cb1e31df6e22e8266ca60c02923ab0d534e6fd5db3745defd8e2f03ff6a726d6c5b518d1baf92bbddbc7f11d95c411f105ad80ac13188a5cd7bbd2d74d012b8e5b4b08969974a0c96777e65b9f109c56ec68418f07dec3adc4d2079ee5f3ed7cb3948',
  'hex',
)
const CK_HEX =
  '00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b7279'
const CK = Array.from({ length: 32 }, (_, i) => parseInt(CK_HEX.slice(i * 8, i * 8 + 8), 16))
const FK = [2746333894, 1453994832, 1736282519, 2993693404]

const rotl = (x, n) => ((x << (n & 31)) | (x >>> (32 - (n & 31)))) >>> 0
const tau = (a) => ((SBOX[(a >>> 24) & 255] << 24) | (SBOX[(a >>> 16) & 255] << 16) | (SBOX[(a >>> 8) & 255] << 8) | (SBOX[a & 255])) >>> 0
const t1 = (x) => {
  const a = tau(x)
  return (a ^ rotl(a, 2) ^ rotl(a, 10) ^ rotl(a, 18) ^ rotl(a, 24)) >>> 0
}
const t2 = (x) => {
  const a = tau(x)
  return (a ^ rotl(a, 13) ^ rotl(a, 23)) >>> 0
}
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const w32 = (b, o, v) => {
  b[o] = (v >>> 24) & 255
  b[o + 1] = (v >>> 16) & 255
  b[o + 2] = (v >>> 8) & 255
  b[o + 3] = v & 255
}

function expandKey(key) {
  const k = new Uint32Array(36)
  for (let i = 0; i < 4; i++) k[i] = (u32(key, i * 4) ^ FK[i]) >>> 0
  const rk = new Uint32Array(32)
  for (let i = 0; i < 32; i++) {
    k[i + 4] = (k[i] ^ t2((k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ CK[i]) >>> 0)) >>> 0
    rk[i] = k[i + 4]
  }
  return rk
}

function block(rk, input, off, out, outOff) {
  const x = new Uint32Array(36)
  x[0] = u32(input, off)
  x[1] = u32(input, off + 4)
  x[2] = u32(input, off + 8)
  x[3] = u32(input, off + 12)
  for (let i = 0; i < 32; i++) x[i + 4] = (x[i] ^ t1((x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rk[i]) >>> 0)) >>> 0
  w32(out, outOff, x[35])
  w32(out, outOff + 4, x[34])
  w32(out, outOff + 8, x[33])
  w32(out, outOff + 12, x[32])
}

function gfMul(x, y) {
  const z = new Uint8Array(16)
  const v = new Uint8Array(y)
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3] >>> (7 - (i & 7))) & 1) for (let j = 0; j < 16; j++) z[j] ^= v[j]
    const lsb = v[15] & 1
    for (let j = 15; j > 0; j--) v[j] = ((v[j] >>> 1) | ((v[j - 1] & 1) << 7)) & 255
    v[0] = (v[0] >>> 1) & 255
    if (lsb) v[0] ^= 225
  }
  return z
}

function ghashBlocks(h, data) {
  let y = new Uint8Array(16)
  const n = Math.ceil(data.length / 16)
  for (let i = 0; i < n; i++) {
    const b = new Uint8Array(16)
    b.set(data.subarray(i * 16, Math.min(i * 16 + 16, data.length)))
    for (let j = 0; j < 16; j++) y[j] ^= b[j]
    y = gfMul(y, h)
  }
  return y
}

const inc32 = (c) => {
  for (let i = 15; i >= 12; i--) {
    c[i] = (c[i] + 1) & 255
    if (c[i] !== 0) break
  }
}

function gctr(rk, icb, data) {
  if (data.length === 0) return new Uint8Array(0)
  const out = new Uint8Array(data.length)
  const cb = new Uint8Array(icb)
  const ks = new Uint8Array(16)
  for (let off = 0; off < data.length; off += 16) {
    block(rk, cb, 0, ks, 0)
    const len = Math.min(16, data.length - off)
    for (let i = 0; i < len; i++) out[off + i] = data[off + i] ^ ks[i]
    inc32(cb)
  }
  return out
}

function ghashInput(aad, ct) {
  const aadPad = Math.ceil(aad.length / 16) * 16
  const ctPad = Math.ceil(ct.length / 16) * 16
  const buf = new Uint8Array(aadPad + ctPad + 16)
  buf.set(aad, 0)
  buf.set(ct, aadPad)
  const aadBits = BigInt(aad.length) * 8n
  const ctBits = BigInt(ct.length) * 8n
  const tail = aadPad + ctPad
  for (let i = 0; i < 8; i++) {
    buf[tail + 7 - i] = Number((aadBits >> BigInt(8 * i)) & 0xffn)
    buf[tail + 15 - i] = Number((ctBits >> BigInt(8 * i)) & 0xffn)
  }
  return buf
}

function setup(key, iv) {
  const rk = expandKey(key)
  const h = new Uint8Array(16)
  block(rk, new Uint8Array(16), 0, h, 0)
  const j0 = new Uint8Array(16)
  j0.set(iv.subarray(0, Math.min(12, iv.length)))
  j0[15] = 1
  return { rk, h, j0 }
}

function tagOf(rk, h, j0, aad, ct) {
  const s = ghashBlocks(h, ghashInput(aad, ct))
  const e = gctr(rk, j0, new Uint8Array(16))
  const tag = new Uint8Array(16)
  for (let i = 0; i < 16; i++) tag[i] = s[i] ^ e[i]
  return tag
}

export function sm4GcmEncrypt(key, iv, plaintext, aad) {
  const { rk, h, j0 } = setup(new Uint8Array(key), new Uint8Array(iv))
  const icb = new Uint8Array(j0)
  inc32(icb)
  const ct = gctr(rk, icb, new Uint8Array(plaintext))
  return { ciphertext: Buffer.from(ct), tag: Buffer.from(tagOf(rk, h, j0, new Uint8Array(aad), ct)) }
}

export function sm4GcmDecrypt(key, iv, ciphertext, tag, aad) {
  if (tag.length !== 16) throw new Error('SM4-GCM: tag 必须是 16 字节')
  const { rk, h, j0 } = setup(new Uint8Array(key), new Uint8Array(iv))
  const ct = new Uint8Array(ciphertext)
  const expected = tagOf(rk, h, j0, new Uint8Array(aad), ct)
  let diff = 0
  for (let i = 0; i < 16; i++) diff |= expected[i] ^ tag[i]
  if (diff !== 0) throw new Error('SM4-GCM: 认证标签不匹配')
  const icb = new Uint8Array(j0)
  inc32(icb)
  return Buffer.from(gctr(rk, icb, ct))
}

// ── 密钥协商 ────────────────────────────────────────────────
const CURVE = 'prime256v1'
const KEY_BYTES = 16
const IV_BYTES = 12

export function createEcdhPair() {
  const ecdh = createECDH(CURVE)
  return { ecdh, publicKeyB64: ecdh.generateKeys().toString('base64') }
}

export function completeKeyExchange(pair, serverPublicKeyB64, keyId, expiresInSec) {
  const shared = pair.ecdh.computeSecret(Buffer.from(serverPublicKeyB64, 'base64'))
  return {
    keyId,
    key: createHash('sha256').update(shared).digest().subarray(0, KEY_BYTES),
    expiresAt: Date.now() + (expiresInSec > 0 ? expiresInSec * 1000 : 7_200_000),
  }
}

/** 加密一次请求体；AAD = method|path|timestamp。 */
export function encryptRequest(session, plaintext, method, pathname, timestamp = Date.now()) {
  const iv = randomBytes(IV_BYTES)
  const aad = Buffer.from(`${method}|${pathname}|${timestamp}`, 'utf8')
  const { ciphertext, tag } = sm4GcmEncrypt(session.key, iv, plaintext, aad)
  return {
    // 网关要的是 Base64 文本当正文，不是原始二进制。
    body: Buffer.from(ciphertext.toString('base64'), 'utf8'),
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Encrypt-Algo': 'sm4-gcm',
      'X-Encrypt-Key-Id': session.keyId,
      'X-Encrypt-Iv': iv.toString('base64'),
      'X-Encrypt-Tag': tag.toString('base64'),
      'X-Encrypt-Ts': String(timestamp),
    },
  }
}

/** 解一段 SSE 密文 `IV:TAG:CIPHERTEXT`；AAD = keyId|chunkIndex。 */
export function decryptChunk(session, chunk, index) {
  const parts = String(chunk).split(':')
  if (parts.length !== 3) throw new Error('SSE 密文格式不对')
  const aad = Buffer.from(`${session.keyId}|${index}`, 'utf8')
  return sm4GcmDecrypt(
    session.key,
    Buffer.from(parts[0], 'base64'),
    Buffer.from(parts[2], 'base64'),
    Buffer.from(parts[1], 'base64'),
    aad,
  ).toString('utf8')
}

// ── 华为云签名 ──────────────────────────────────────────────
const ALGO = 'SDK-HMAC-SHA256'
const sha256 = (v) => createHash('sha256').update(v).digest('hex')

export function sdkDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

const isDefaultPort = (protocol, port) => (protocol === 'https:' && port === '443') || (protocol === 'http:' && port === '80')

function canonicalHeaders(headers) {
  const entries = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return {
    block: entries.map(([k, v]) => `${k}:${String(v ?? '').replace(/[\r\n]/g, ' ').trim()}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  }
}

/** 码道网关的签名头。bodyBytes 用真实 body 的 SHA256（不是 UNSIGNED-PAYLOAD）。 */
export function signGateway({ method, url, contentType, body = '', bodyBytes, credentials, date = sdkDate() }) {
  const payloadHash = bodyBytes ? sha256(bodyBytes) : sha256(body)
  const host = url.port && !isDefaultPort(url.protocol, url.port) ? `${url.hostname}:${url.port}` : url.hostname
  const headers = { Host: host, 'X-Sdk-Date': date, 'X-Security-Token': credentials.securityToken }
  if (contentType) headers['Content-Type'] = contentType
  const { block, signed } = canonicalHeaders(headers)
  const canonicalUri = url.pathname.split('/').map((s) => encodeURIComponent(s)).join('/')
  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalUri.endsWith('/') ? canonicalUri : `${canonicalUri}/`,
    url.search ? url.search.slice(1) : '',
    block,
    signed,
    payloadHash,
  ].join('\n')
  const stringToSign = [ALGO, date, sha256(canonicalRequest)].join('\n')
  return {
    ...headers,
    Authorization: `${ALGO} Access=${credentials.ak}, SignedHeaders=${signed}, Signature=${createHmac('sha256', credentials.sk).update(stringToSign).digest('hex')}`,
  }
}

/** IAM 换 STS 用的签名（无 STS 头，签名路径带尾斜杠）。 */
export function signIam({ method, host, path, query = '', contentType, body = '', ak, sk, date = sdkDate() }) {
  const headers = { Host: host, 'X-Sdk-Date': date }
  if (contentType) headers['Content-Type'] = contentType
  const { block, signed } = canonicalHeaders(headers)
  const canonicalRequest = [String(method).toUpperCase(), path, query, block, signed, sha256(body)].join('\n')
  const stringToSign = [ALGO, date, sha256(canonicalRequest)].join('\n')
  return {
    ...headers,
    Authorization: `${ALGO} Access=${ak}, SignedHeaders=${signed}, Signature=${createHmac('sha256', sk).update(stringToSign).digest('hex')}`,
  }
}