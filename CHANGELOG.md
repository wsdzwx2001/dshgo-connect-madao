# Changelog

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