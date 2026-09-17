# /sim — 战役回放

这些 HTML 由私有仓库 `redbank-iii/twin` 的 `make demo`(`demo/build.py`)生成,
每个文件自包含、无外部依赖。**不要手工编辑** —— 在 twin 仓库重新生成后整体覆盖:

```
git clone git@github.com:redbank-iii/twin.git
cd twin && make demo
cp demo/*.html <this-repo>/public/sim/
```

本次构建自 twin `c341c0a`。

以前这些文件由 intel-mac 上的 `python3 -m http.server` + Cloudflare 隧道对外服务
(`redbank-twin.liyao.space`),那台机器一关站点就没了。现在走 GitHub Pages,
不依赖任何自建机器。
