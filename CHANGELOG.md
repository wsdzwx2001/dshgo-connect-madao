# Changelog

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