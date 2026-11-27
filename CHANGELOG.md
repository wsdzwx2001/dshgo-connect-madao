# Changelog

## 0.1.3 — 2026-11-27

中危问题修复：

- 模型清单校验：缺 `context_window` 的模型跳过；非法 `strengths` 过滤；空清单保留旧清单，避免写坏 provider
- `off` 兜底：网关接受 `none` 但 usage 仍返回 `reasoning_tokens>0` 时，自动记住该模型关不掉思考并去掉 off 档
- 凭证页刷新不再显式清空输入；损坏的凭证文件会显示「凭证错误」和具体原因
- 自检失败、端口占用会如实显示，不再伪装成「就绪」或「未配置」
- 签到：没有活动不再让自检变红；`claimable` 为真时不再被 `status !== ELIGIBLE` 挡住
- `messages` 结构错误返回 400；请求体明文上限调到 7MB，避免 base64 加密后撞穿网关 10MB
- `credentials.json` / `models.json` 改为临时文件 + rename 原子写
- `listen` 失败会记录端口错误并清理 error 监听器
- 静态 `cordis.patch.yml` 只声明插件本身，不再写 `llm-pi-ai` 配置，避免整段替换其他 provider
- 新增/扩展 security、ui 回归：模型字段、off usage、无签到活动、claimable、400、原子写、状态显示

## 0.1.2 — 2026-11-27

高危问题修复（按 A 方案）：

- 安全：本机桥要求 `Authorization: Bearer bridge-local`，拒绝浏览器 `Origin`，去掉 CORS 通配；未鉴权 `/healthz` 只返回存活信息
- 额度 / 签到 / 同步模型前先续期 STS；只读接口加 20 秒超时
- 停止生成：客户端断开时取消上游请求，不再继续消耗 token
- 关闭思考：`reasoningEfforts.off` 从 `null` 改为 `'none'`，DSH 才会发 `reasoning_effort: "none"`
- 测试连接 / 同步模型 / 签到改用宿主 `pending` 延后结果，避免 3 秒 handler 超时
- 同步失败或网关返回空清单时保留旧清单并报错，不再静默回退兜底
- HMR：启动阶段不再写 provider 配置；只在保存凭证 / 同步模型 / 切换模型等用户动作里写，写失败退避重试
- 不再运行时改写包内 `cordis.patch.yml`，避免 pnpm store 硬链接污染；静态清单仅作首次安装兜底
- 新增 `test/security.mjs`：鉴权 / Origin / 415 / 同步失败保留清单 / 静态 patch 不被改写

## 0.1.1 — 2026-11-27

- 修复：保存凭证后，凭证页的「当前 AK / 状态」不刷新（面板数据只推一次且不会被重取）

## 0.1.0 — 2026-11-27

首个公开版本：把华为云码道（CodeArts Agent）接入 dsh-go。

- 本机 OpenAI 兼容桥（`127.0.0.1:8766`）：`/v1/chat/completions`（流式 / 非流式）、`/v1/models`、`/healthz`
- 协议：SDK-HMAC-SHA256 签名、P-256 密钥协商、SM4-GCM 载荷加解密、SSE 逐片解密
- 凭证：环境变量 / `~/.config/dshgo-connect-madao/credentials.json` / 旧插件路径迁移
- STS：永久 AK/SK 自动换临时令牌并续期
- 模型清单：启动时从网关拉取，写回 `cordis.patch.yml`，并通过 `configEditor` 注册进 `llm-pi-ai`
- 原生界面：输入框状态条 + 主面板（状态 / 额度 / 测试 / 签到 / 模型开关）+ 凭证页
- 额度每 15 秒自动刷新；对话结束后顺手刷新
- 每日签到：查看状态、一键领取
- 每个模型可启用 / 停用，停用后从模型选择器消失
- 自动识别不支持「关闭思考」的模型（glm-5.3 系列）并回退重试
- 工具调用、图片、思考强度、usage 透传