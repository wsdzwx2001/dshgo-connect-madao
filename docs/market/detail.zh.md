# 码道连接（dshgo-connect-madao）

把 **华为云码道（CodeArts Agent）** 的模型接进 dsh-go。插件在本机起一个 OpenAI 兼容桥，
把 AK/SK 换成 STS、按码道协议签名与加密，再把模型注册进 DSH 的模型选择器。
界面是 dsh-go 原生的：输入框上方一条状态条，点开是面板。

## 能做什么

- **12 个可用模型**：GLM-5.2 / GLM-5.3 / GLM-5.3-Flash / GLM-5.2-ArkTS-SPARK /
  DeepSeek-V4.1-Flash（含 1017）/ Kimi-K3 / Kimi-K3.1-Pro / OpenPangu 2.0、2.1 / 智速模式
- **完整协议**：SDK-HMAC-SHA256 签名、P-256 密钥协商、SM4-GCM 加解密、SSE 逐片解密
- **流式 / 非流式、工具调用、图片、思考强度、usage（含缓存命中）** 全部透传
- **额度自动刷新**：每 15 秒一次，对话结束也会刷新；额度接口报错只影响这一块，不影响对话，并会退避重试
- **断线自愈**：握手失败自动退避重连，令牌过期（含没有到期时间的临时令牌）自动换 STS，不用重填凭证
- **每日签到**：查看状态、一键领取
- **逐模型开关**：点模型行即可启用 / 停用，停用的模型从模型选择器消失
- **思考档位由内置规则决定**：当前 12 个模型的档位全部写死在规则表里（glm-5.3 系列不给「关闭思考」，openpangu / 智速模式无思考档，deepseek / kimi 四档齐全）；网关以后新增的模型先按声明走、再退默认「不思考 / 高 / 最高」。不需要人工调档

## 安装

```sh
# npm（发布后）
dsh plugin --profile web add dshgo-connect-madao

# 本地目录
dsh plugin --profile web add /path/to/dshgo-connect-madao

# tarball
dsh plugin --profile web add ./dshgo-connect-madao-0.1.6.tgz
```

装完在 App「引擎」页重启一次引擎。

## 使用

1. 打开「connect-madao」面板 →「填写凭证」，填华为云 IAM 的 AK/SK（控制台 → 我的凭证 → 访问密钥），保存。
2. 状态条变成「码道 剩 4043.48」，模型选择器里出现「码道 CodeArts」。
3. 选中模型即可对话；面板里还能看额度、签到、模型开关和五项自检。

## 数据与配置

| 内容 | 位置 |
|---|---|
| 凭证 | `~/.config/dshgo-connect-madao/credentials.json`（0600） |
| 模型开关 | `~/.config/dshgo-connect-madao/models.json`（思考档位不再存这里） |
| 上次同步的模型清单 | `~/.config/dshgo-connect-madao/models-cache.json` |
| 桥接 | `http://127.0.0.1:8766/v1` |
| 诊断 | `GET /healthz`、`GET /v1/models`（需 `Authorization: Bearer bridge-local`；未鉴权的 `/healthz` 只返回存活信息） |

环境变量 `MADAO_AK` / `MADAO_SK`（可加 `MADAO_SECURITY_TOKEN`）优先于文件。
插件会兼容读取旧插件 `dsh-connect-madao` 的凭证路径。

## 已知限制

- 凭证只保存在本机；插件不代管、不上传凭据。
- 网关限制约 10 MB 单次请求体（换算成本机桥约 8.3 MB 明文，超了返回 413）；超长会话需要压缩或换窗口更大的模型。
- 图片只支持 `image_url`（data URL）；音频、file 类型网关不接受；模型不支持图片时桥接会直接回 400 并提示换模型。
- `max_tokens` 会按模型上限收敛：不传就用模型上限，传大了也压回上限。
- 依赖 dsh-go 原生插件协议；旧版本 App 可能看不到面板，凭证页会提示改用文件配置。
- 自检里「额度 / 签到」是软步骤：失败只提示，不会把连接判成不可用。

## 许可

MIT