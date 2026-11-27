// 真实网关冒烟（只读）：验证凭证 → 密钥协商 → 模型清单 → 额度 → 签到，并列出每个模型
// 实际会写进 provider 的思考档位。**不发对话、不花额度**，用备用端口，不碰正在跑的桥。
//
//   node test/smoke-real.mjs                  # 用 ~/.config 或 MADAO_* 环境变量里的凭证
//   MADAO_SMOKE_PORT=8767 node test/smoke-real.mjs
//
// 这是手工步骤，不在 `npm test` 里（会连真实网关，CI 里跑会花流量）。
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBridge } from '../lib/bridge.js'
import { effortsFor, effortsSource } from '../lib/efforts.js'

const port = Number(process.env.MADAO_SMOKE_PORT ?? 8767)
const bridge = createBridge({
  port,
  refreshMs: 0,
  // 别踩用户真实的模型缓存
  modelCache: join(tmpdir(), `madao-smoke-cache-${process.pid}.json`),
})

/** 按顺序跑完，返回退出码。 */
async function run() {
  await bridge.listen()
  if (!(await bridge.connect())) {
    console.error(`❌ 凭证/握手失败：${bridge.state.error ?? '未知原因'}`)
    return 1
  }

  let code = 0
  const sync = await bridge.syncModels()
  if (!sync.ok) {
    console.error(`❌ 模型清单同步失败：${sync.error}`)
    code = 1
  }

  const test = await bridge.test()
  const steps = test.steps.map((s) => `${s.name}:${s.ok ? 'ok' : `失败(${s.detail})`}`).join(' | ')
  if (!test.ok) {
    console.error(`❌ 自检硬步骤失败：${steps}`)
    code = 1
  }

  const status = bridge.status()
  console.log(`版本 ${status.version} · 端口 ${port} · 模型 ${status.models}（${status.modelsSource}）`)
  console.log(`额度 ${status.credit?.remain ?? '-'} / ${status.credit?.total ?? '-'} · 签到 ${status.checkin?.status ?? '-'}`)
  console.log(`心跳失败 ${status.heartbeatFailures} · 自检 ${test.ok ? '通过' : '失败'}${test.warn ? '（软步骤有异常）' : ''}`)
  console.log(`自检步骤：${steps}`)
  console.log('')
  console.log('模型'.padEnd(26) + '来源'.padEnd(9) + '网关声明'.padEnd(22) + '最终档位')
  for (const m of bridge.state.models) {
    const efforts = effortsFor(m.id, m.strengths, m.known)
    const source = effortsSource(m.id)
    console.log(`${m.id.padEnd(26)}${source.padEnd(9)}${JSON.stringify(m.strengths).padEnd(22)}${JSON.stringify(efforts)}`)
    // 兜底清单里的模型必须有规则，否则档位会随网关声明漂移
    if (source === 'gateway') {
      console.error(`❌ ${m.id} 没有内置规则（档位会随网关声明漂移）`)
      code = 1
    }
  }
  console.log('')
  if (code === 0) console.log('✅ 真实网关只读冒烟通过（未发对话、未花额度）')
  return code
}

try {
  process.exitCode = await run()
} catch (err) {
  console.error(`❌ 冒烟失败：${String(err?.message ?? err)}`)
  process.exitCode = 1
} finally {
  await bridge.close().catch(() => {})
}