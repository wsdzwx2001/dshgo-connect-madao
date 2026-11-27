# 打包与分发

本插件既是 DSH 的 Cordis bundle（`dsh.bundle.patch`），也是 dsh-go 原生插件（`dshGo` 清单），
所以既能用 `dsh plugin ... add` 安装，也能作为插件市场条目分发。

**唯一权威来源是 npm registry**：GitHub 只放源码和 tag，Release 不附 tgz（见第 2 节）。
本地 `npm pack` 出来的 tgz 只用于自测和离线安装。

## 1. 本地打包与自测

```sh
npm pack --dry-run     # 只看会打进包的文件，不落盘
npm pack               # → dshgo-connect-madao-<version>.tgz
```

包内只包含 `lib/`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/`
（见 `package.json` 的 `files`），测试代码不进包。

发布前至少跑一遍：

```sh
npm test               # efforts / security / e2e / ui / bootstrap / fixes 六个回归
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load   # App 侧清单与视图
```

想验证 tgz 本身，可以把它装进临时目录再检查：

```sh
mkdir -p /tmp/pk && tar -xzf dshgo-connect-madao-*.tgz -C /tmp/pk
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs /tmp/pk/package --load
```

## 2. 上传到 GitHub

```sh
git add -A
git commit -m "fix: <一句话说明>"
git tag -a v0.1.6 -m "v0.1.6"      # 用附注 tag，和已有 tag 保持一致
git push origin main --tags
```

`package.json` 里需要有这几项（首次建仓时补一次即可）：

```json
"repository": { "type": "git", "url": "git+https://github.com/wsdzwx2001/dshgo-connect-madao.git" },
"homepage": "https://github.com/wsdzwx2001/dshgo-connect-madao#readme",
"bugs": { "url": "https://github.com/wsdzwx2001/dshgo-connect-madao/issues" }
```

### GitHub Release：建，但不附 tgz

tag 推上去就够用了；Release 只是给人看的说明页，建议建，正文直接取 `CHANGELOG.md`
里对应版本那一节。**默认不附 tgz**，理由：

- npm 上的包就是同一份 Artifact，Release 再存一份等于双份维护，容易和实际发布的版本对不上；
- Release 页面自动带 “Source code (zip/tar.gz)”，那是 git 源码快照，不是 npm 包，别再混一份 tgz 进去；
- 真要离线/内网分发时，临时附一次，并在 Release 正文里写清“与 npm 上的 x.y.z 相同”。

创建方式（网页或 API 二选一）：

```sh
# 方式一：GitHub 网页 → Releases → Draft a new release → 选已有 tag → 正文粘贴 CHANGELOG 对应小节
# 方式二：本机没有 curl，用 node（GH_TOKEN 只放环境变量）
GH_TOKEN=... node --input-type=module -e '
import fs from "node:fs";
const md = fs.readFileSync("CHANGELOG.md", "utf8");
const body = "## 0.1.6" + md.split("## 0.1.6")[1].split("\n## 0.1.")[0];
const r = await fetch("https://api.github.com/repos/wsdzwx2001/dshgo-connect-madao/releases", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ tag_name: "v0.1.6", name: "v0.1.6", body }),
});
console.log(r.status, (await r.json()).html_url);
'
```

## 3. 发布到 npm

```sh
npm login                       # 或临时 userconfig 里放 //registry.npmjs.org/:_authToken=...
npm publish --registry=https://registry.npmjs.org/ --access public
```

顺序建议：先 push tag（第 2 节），再 `npm publish`，这样 `#v0.1.6` 这种固定装法立刻可用。

发布后核对：

```sh
npm view dshgo-connect-madao dist-tags version --registry=https://registry.npmjs.org/ --prefer-online
npm view dshgo-connect-madao time.0.1.6 --registry=https://registry.npmjs.org/   # 第 4 节要用这个时间戳
```

- 同版本号不能重复发布；改代码必须升版本。
- registry 有缓存，`latest` 可能要等几十秒到几分钟才更新，属正常现象。

## 4. 上架 dsh 插件市场

dsh 的插件市场读取**索引 JSON**（格式 1），可以并入社区索引，也可以自建。
`docs/market/index.json` 是一份可直接托管的单插件索引，追加新版本时保持这个形状：

```json
"versions": [
  { "version": "0.1.5", "publishTimestamp": 1795751789, "source": { "type": "npm" } },
  { "version": "0.1.6", "publishTimestamp": 1795752629, "source": { "type": "npm" } }
]
```

- `publishTimestamp` 用 **npm 的发布时间，秒级**（`npm view dshgo-connect-madao time.0.1.6`，
  或 registry packument 里的 `time["0.1.6"]`），不要用本地打包时间。
- 版本号必须和 `package.json` 一致，旧版本条目保留，别删。
- 改完索引单独提交一次（`docs: <版本> 市场索引发布时间戳`），这样 tag 指向发布代码、
  HEAD 指向索引更新，和 0.1.3 起的做法一致。
- 上面示例里的数字是 0.1.6 / 0.1.7 的真实发布时间。本次发布的条目必须等 `npm publish`
  拿到时间戳之后才能追加，因此 **npm 包内的 `docs/market/index.json` 永远比 npm 少这最新一版**：
  这是发布顺序的必然结果，不是漏发；权威索引以托管的 Pages 地址为准。

自检索引格式：

```sh
# 解析器来自本机 harness 的安装目录（/opt/dsh），路径按实际位置改
node --input-type=module -e '
import fs from "node:fs";
const { parseMarketIndex } = await import("/opt/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js");
const raw = JSON.parse(fs.readFileSync("docs/market/index.json", "utf8"));
const out = parseMarketIndex(raw, "https://wsdzwx2001.github.io/dshgo-connect-madao/market/index.json");
console.log(out.plugins.map((p) => [p.name, p.versions.map((v) => v.version)]));
'
```

两条分发路径：

1. **并入社区索引**：把 `plugins` 那一项加进社区索引仓库的 `plugins` 数组（版本号、时间戳、
   `source` 与 npm 发布一致），提 PR。
2. **自建索引**：把 `docs/market/index.json` 放到任意 https 静态地址（GitHub Pages、CDN 均可），
   在插件市场添加该索引 URL。

市场详情页的长描述来自 `docs/market/detail.zh.md`。

## 5. 版本与兼容

- 版本号：`package.json` 的 `version`、git tag、npm 版本、索引条目四者必须一致。
- 兼容范围：`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`，低于它时市场会提示不兼容。
- App 版本：原生面板依赖 dsh-go 原生插件协议 v1（状态条 / 面板 / 视图 v2）。
- Release 附件：默认不附 tgz；npm 是唯一权威来源。
- 卸载/回滚：`dsh plugin --profile web add dshgo-connect-madao@0.1.4` 可回到旧版本；
  `remove` 不会删掉 profile 里的 `madao-go` provider，需要时在「设置 → 模型」里删。