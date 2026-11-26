# dshgo-connect-madao — 码道接入 dsh-go

把华为云码道（CodeArts Agent）的模型接进 dsh-go：本机起一个 OpenAI 兼容桥，DSH 里直接选
「码道 CodeArts」的模型；App 原生界面里有状态条和一个统一面板。

参考 `dsh-connect-madao`（MIT）重写，只保留核心链路，宿主侧代码从约 5900 行降到约 1700 行。

## 做了什么

| 功能 | 说明 |
|---|---|
| 本机桥接 | `http://127.0.0.1:8766/v1`，`/v1/chat/completions`（流式 / 非流式）、`/v1/models`、`/healthz` |
| 协议 | SDK-HMAC-SHA256 自签、P-256 协商、SM4-GCM 加解密、SSE 逐片解密 |
| 凭证 | 环境变量 `MADAO_AK/MADAO_SK` → `~/.config/dshgo-connect-madao/credentials.json` → 原插件旧路径 |
| STS | 永久 AK/SK 自动换临时 STS，提前 10 分钟续期 |
| 模型清单 | 启动时从网关拉取；写回 `cordis.patch.yml`，同时通过 `configEditor` 直接注册进 `llm-pi-ai`（合并，不动你已有的 provider） |
| 额度 | 面板显示剩余 / 总量，桥接每 15 秒自动刷新（打开面板、每轮对话结束时也会顺手拉一次） |
| 签到 | 面板里看今日签到状态和奖励，「立即签到」一键领 |
| 模型开关 | 模型清单里点一行即可启用/停用；停用的模型从模型选择器消失（至少留一个），状态存在 `~/.config/dshgo-connect-madao/models.json` |
| 思考档位 | 自动发现网关不接受「关闭思考」的模型（实测 glm-5.3 系列），去掉 off 档并按默认思考重发，不再报 400 |
| 原生界面 | 输入框上方一条状态条，点开是主面板（状态/额度/测试/签到/模型开关）；凭证在「码道凭证」面板里填 |

没有搬过来的：网页设置面板（dsh-go 画不了 React）、Windows 码道客户端登录态借用、CLI。

## 安装

```sh
# 目录已在 $DSH_HOME/dsh-go/plugins/dshgo-connect-madao
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dshgo-connect-madao
# 发布到 npm 之后也可以：
dsh plugin --profile web add dshgo-connect-madao
```

装完在 App 的「引擎」页重启一次引擎：插件要在引擎启动时挂载。

打包与分发（npm / GitHub / 插件市场索引）见 [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)。

启动后插件会自己把 `madao-go` 这个 provider 写进 profile 的 `cordis.patch.yml`（和网页「模型」页
同一条写入路径，只动 `providers.madao-go` 这一项），所以模型列表里会直接出现「码道 CodeArts」。
不这么写不行：profile 自己的 `cordis.patch.yml` 会整段替换 `llm-pi-ai` 的 config，插件自带的
bundle patch 会被它覆盖掉。

## 用法

1. 点输入框上方的状态条，打开「dshgo-connect-madao」面板。
2. 点「填写凭证」打开「码道凭证」页，填华为云 AK / SK（控制台 → 我的凭证 → 访问密钥），
   点「保存并验证」；几秒后状态条变成「码道 就绪」。
3. 「dshgo-connect-madao」主面板：状态（凭证「已配置 / 未配置」/ AK 掩码 / STS / 桥接 / 模型数）、剩余额度（自动刷新）、
   填写凭证 / 测试连接 / 同步模型、今日签到与奖励、五项自检、模型清单（点行切换启用）。
   凭证单独一页，是因为主面板每 15 秒推送一次数据，App 会整包替换，正在填的输入框会被清空。
4. 在模型选择里选「码道 CodeArts」下的模型即可对话。

表单提交的 `value` 结构在不同 App 版本里有差别，插件会从扁平/嵌套几种形状里找 AK 和 SK；
万一读不出来，会把字段结构（只有字段名和值长度，不落密钥）记到 `~/.config/dshgo-connect-madao/panel.log`。

面板里的按钮：

- **填写凭证 / 保存并验证**：写入凭证 → 重连 → 拉模型 → 注册 provider → 自检。
- **测试连接**：凭证 → 密钥协商 → 模型清单 → 额度 → 签到，五项逐项显示。
- **同步模型**：立刻拉一次模型清单，并更新 provider 配置。
- **点模型行**：切换该模型是否启用，立刻写回 provider（停用后模型选择器里看不到它）。
- **立即签到**：领今日签到；已签过会直接说「今日已签到」。

状态条：`码道 就绪`、`码道 剩 380`、`码道 可签到 · 剩 380`、`码道 检测中…`、`码道 未就绪`（未配凭证或握手失败，点开看原因）。

## 与旧插件共存

- 端口 `8766`、provider `madao-go`，与 `dsh-connect-madao`（`8765` / `madao`）互不冲突。
- 想只留一个：`dsh plugin --profile web remove dsh-connect-madao`，再把旧目录删掉。

## 排查

```sh
curl -s http://127.0.0.1:8766/healthz          # 状态、STS、额度、自检
curl -s http://127.0.0.1:8766/v1/models        # 当前模型清单
```

常见报错：

- **还没有码道凭证**：没存 AK/SK，或文件不是合法 JSON。
- **换 STS 失败：HTTP 403**：AK/SK 不对，或 IAM 换 STS 触发限流（等约 1 分钟）。
- **对话请求失败：HTTP 4xx**：网关侧拒绝，正文已尽量解密成明文打印。
- **请求体 xx MB**：超过网关约 10 MB 上限，开新会话或换窗口更小的模型。

## 测试

```sh
node test/e2e.mjs   # 与原插件对拍协议
node test/ui.mjs    # 状态条 / 面板 / 表单解析 / 签到 / provider / STS 续期
```

会起一个模拟码道网关（签名校验、P-256、SM4-GCM、加密 SSE），先让原插件 `dsh-connect-madao`
跑通，再让本插件跑同一套，比较两边实际发出的请求是否一致。
（需要 `/tmp/orig-madao` 存在：`cp -r ~/.dsh/profiles/web/node_modules/dsh-connect-madao /tmp/orig-madao`。）

## 文件

```
package.json      清单：dsh.bundle.patch + dshGo（状态条 / 面板）
cordis.patch.yml  自动生成：插入插件 + 注册 madao-go provider 与模型
lib/crypto.js     SM4-GCM、P-256、华为云签名
lib/bridge.js     凭证、STS、客户端、模型清单、额度、OpenAI 兼容服务
lib/index.js      启动桥接 + dsh-go 原生界面
```