# dshgo-connect-madao

把华为云**码道（CodeArts Agent）**接进 dsh-go：本机起一个 OpenAI 兼容桥，
App 里用原生状态条 / 面板管凭证、额度和模型。需要 DSH 0.2.x（≥ 0.2.1-rc.2）。

## 安装

```sh
dsh plugin --profile web add dshgo-connect-madao            # npm
dsh plugin --profile web add /path/to/dshgo-connect-madao   # 本地目录
```

装完（或升级后）在「引擎」页重启一次引擎。

## 配置

点输入框上方的状态条 →「填写凭证」→ 填华为云 IAM 的 AK/SK
（控制台 → 我的凭证 → 访问密钥）→「保存并验证」。

也可以走环境变量 `MADAO_AK` / `MADAO_SK`，或写
`~/.config/dshgo-connect-madao/credentials.json`（`{"ak":"…","sk":"…"}`，权限 600）。

## 使用

- 模型选择器里选「码道 CodeArts」下的模型，正常对话（流式 / 工具 / 图片都支持）。
- 面板点模型行可启停，停用的不出现在选择器里（至少留一个）。
- 思考档位由插件按模型自动决定，不用手调。
- 点停止会同时取消发往码道的请求，不再消耗 token。

## 状态条

| 显示 | 含义 |
|---|---|
| `码道 剩 4043.48` | 已连接，显示剩余额度 |
| `码道 可签到 · 剩 …` | 今日签到没领，面板里可领 |
| `码道 就绪 · 额度异常` | 能对话，只是额度接口报错 |
| `码道 未就绪` / `自检失败` / `端口被占用` | 没凭证或连不上（面板写「握手失败（自动重连中）」时它在自己重试）/ 自检硬步骤失败 / 8766 被占 |

## 需知

- 出问题先看凭证页的「最近错误」（带状态码和响应体），比状态条细。
- 断网 / IAM 抖动会自己退避重连；临时令牌过期或失效会自动换 STS 重试，一般不用重填。
- 桥只监听 `127.0.0.1:8766`（`Bearer bridge-local`，拒浏览器来源），别暴露到局域网。
- 卸载：`dsh plugin --profile web remove dshgo-connect-madao`；选择器里若残留「码道 CodeArts」，
  去「设置 → 模型」删掉 `madao-go` provider（算用户配置，插件不自动删）。