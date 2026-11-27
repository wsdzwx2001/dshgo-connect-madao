# 打包与分发

本插件既是 DSH 的 Cordis bundle（`dsh.bundle.patch`），也是 dsh-go 原生插件（`dshGo` 清单），
所以既能用 `dsh plugin ... add` 安装，也能作为插件市场条目分发。

## 1. 本地打包

```sh
npm pack
# → dshgo-connect-madao-0.1.3.tgz
```

包内只包含 `lib/`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/`
（见 `package.json` 的 `files`），测试代码不进包。

自测：把 tarball 装进一个临时 profile，或在解包目录里跑

```sh
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs <解包目录> --load
```

## 2. 上传到 GitHub

```sh
git init -b main
git add .
git commit -m "feat: dshgo-connect-madao 0.1.3"
git tag v0.1.3
git remote add origin https://github.com/wsdzwx2001/dshgo-connect-madao.git
git push -u origin main --tags
```

然后把 GitHub Release 附上 `dshgo-connect-madao-0.1.3.tgz`，并在 `package.json` 补上：

```json
"repository": { "type": "git", "url": "git+https://github.com/wsdzwx2001/dshgo-connect-madao.git" },
"homepage": "https://github.com/wsdzwx2001/dshgo-connect-madao#readme",
"bugs": { "url": "https://github.com/wsdzwx2001/dshgo-connect-madao/issues" }
```

## 3. 发布到 npm

```sh
npm login
npm publish --registry=https://registry.npmjs.org/ --access public
```

发布后安装方式：`dsh plugin --profile web add dshgo-connect-madao`。

（自动化发布可选：在仓库加 `.github/workflows/publish.yml`，配置 `NPM_TOKEN` 后打 tag 自动发布；当前仍为手动发布。）

## 4. 上架 dsh 插件市场

dsh 的插件市场读取**索引 JSON**（格式 1），索引源可以自建，也可以并入社区索引。
`docs/market/index.json` 已经是一份可直接托管的单插件索引（已用
`@deepseek-ai/dsh-plugin-market-index` 校验通过）：

```json
{
  "format": 1,
  "title": { "zh": "…", "en": "…" },
  "plugins": [{
    "name": "dshgo-connect-madao",
    "versions": [{ "version": "0.1.3", "publishTimestamp": 1795744417, "source": { "type": "npm" } }]
  }]
}
```

两条路：

1. **并入社区索引**：把 `plugins` 里的那一项加进社区索引仓库的 `plugins` 数组（版本号、时间戳、
   `source` 保持与 npm 发布一致），提 PR。社区索引的地址由维护方提供，加进 dsh 的
   「设置 → 插件市场 → 索引源」后即可在发现页看到。
2. **自建索引**：把 `docs/market/index.json` 放到任意 https 静态地址（GitHub Pages、CDN 均可），
   在插件市场添加该索引 URL。

市场详情页的长描述来自包的 Markdown 文档，本文对应的内容是 `docs/market/detail.zh.md`。

## 5. 版本与兼容

- 版本号：`package.json` 的 `version` 与索引里的 `version` 必须一致；每次发布新版本同时更新索引条目。
- 兼容范围：`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`，低于它时市场会提示不兼容。
- App 版本：原生面板依赖 dsh-go 原生插件协议 v1（状态条 / 面板 / 视图 v2）。