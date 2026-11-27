# 社区上架清单（提交用）

仓库：`dshgo-connect-madao`（GitHub `v0.2.1`）
包：`dshgo-connect-madao@0.2.1`（npm latest）

## 0. 前置

- [x] GitHub 仓库创建（public）
- [x] `package.json` 补 `repository` / `homepage` / `bugs`
- [x] `git push origin main --tags`
- [x] `git tag -a v0.2.1` + `git push origin main --tags`
- [x] `npm publish`（0.2.1，latest）
- [x] GitHub Release `v0.2.1`（正文取自 CHANGELOG；**不附 tgz**，npm 是唯一权威来源）
- [x] 市场索引追加 0.2.1 与发布时间戳

## 1. GitHub 仓库设置

- Topics：`dsh-plugin`、`dsh-go`、`dsh-go-plugin`、`madao`、`codearts`、`huawei`
  （`dsh-plugin` 是 awesome 列表和多个生态爬虫的发现入口）
- About：把 `package.json` 的 description 粘过去，Website 填仓库 Pages 地址（见下）

## 2. DSH 插件市场（官方「发现」标签页）

DSH 不内置索引源，需要自己托管一份索引（`docs/market/index.json`，已通过格式 1 校验）：

1. 开 GitHub Pages：Settings → Pages → Deploy from branch（`main` / `/docs`），
   或把 `docs/market/index.json` 扔到任意 https 静态地址。
2. 索引地址形如 `https://wsdzwx2001.github.io/dshgo-connect-madao/market/index.json`。
3. 在 DSH 里打开「自定义插件索引」→「发现」→「添加索引源」，填入该地址。
4. 每次发版追加一条版本记录（`version` + npm 的 `publishTimestamp`，秒级），旧条目保留；
   细节见 `docs/DISTRIBUTION.md` 第 4 节。

> `docs/market/index.json` 里的 `source` 用 `{ "type": "npm" }`；如果暂时不发 npm，
> 可改成 `{ "type": "git", "url": "https://github.com/wsdzwx2001/dshgo-connect-madao", "commit": "<40 位 SHA>" }`。

## 3. awesome-dsh-plugin（PR / Issue）

仓库：https://github.com/billliao/awesome-dsh-plugin

- 要求：仓库带 `dsh-plugin` topic + 声明 `dsh.bundle`（本包都满足）。
- 分类：**Models & Providers**（`categories/models-providers.md`）。
- 提交文案：

```text
dshgo-connect-madao — 把华为云码道（CodeArts Agent）接入 dsh-go：本机 OpenAI 兼容桥、
原生状态条与面板、额度自动刷新、每日签到、逐模型开关。
https://github.com/wsdzwx2001/dshgo-connect-madao
```

## 4. dsh-go Registry / Marketplace（coeasy/dsh-go）

仓库：https://github.com/coeasy/dsh-go

- 它的 Registry 只认 `dsh-package.json`（Manifest V2）+ immutable commit；
  纯 Cordis bundle 需要补一份 Manifest V2 才会进入可安装 Registry。
- 人工元数据可走 `catalog/overrides.json` 的 PR，但不会因此变成可安装 authority。
- 若你要走这条线，告诉我，我按他们的 Manifest V2 schema 补 `dsh-package.json` 再提。

## 5. 发布后自检

```sh
dsh plugin --profile web add dshgo-connect-madao
# 或在插件市场加索引后从「发现」安装
node -e 'const r = await fetch("http://127.0.0.1:8766/healthz", { headers: { authorization: "Bearer bridge-local" } }); const j = await r.json(); console.log(j.version, j.models, j.credit && j.credit.remain)'
```

确认：面板出现、状态条可点、凭证页可保存、模型选择器里出现「码道 CodeArts」。