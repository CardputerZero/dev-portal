# CardputerZero 开发者中心（dev.cardputer.cc）

面向开发者的 AppStore 网页上传入口。开发者在浏览器里直接上传 `.deb`，
页面**本地解析**出应用图标、包名、版本号、`.desktop` 声明、Maintainer 邮箱，
生成初步安全报告；GitHub 登录校验邮箱真实性，包名**抢占式归属**（先提交者
拥有该包名，之后只有同邮箱账号或管理员可以更新/下架）；自动化审核通过后
自动生成发布 PR（可配置自动合并），APT 索引与商店 registry 随之更新。

> 本仓库是站点源码（Cloudflare Worker 架构，无数据库）。归属与版本状态
> 直接以线上 APT 索引为准，天然免维护。

## 工作原理

```
浏览器 dev.cardputer.cc
  │ ① 选择 .deb → 本地解析（ar/tar 纯前端解包，支持 deb(5) 全部压缩：
  │    gz / xz / zstd / bz2 / lzma / 无压缩，解压库全部同域 vendored）
  │    展示图标 / 包名 / 版本 / .desktop / 邮箱 / 文件清单 / 安全报告
  │    并对照线上索引预检：包名归属、版本是否重复/倒退
  │ ② GitHub OAuth 登录（scope: user:email，读取已验证邮箱）
  │ ③ 三步提交（同域，无 CORS）：prepare 拿票据 → deb 传字节 → finalize
  ▼
Cloudflare Worker（本仓库 worker/，静态页面同域托管）
  │ ④ 会话校验 + 归属/版本预检（拉线上 Packages 索引比对），过了才发票据，
  │    因此包名被占或版本倒退在传字节之前就被挡住
  │ ⑤ .deb 流式转发进 packages 仓库 staging Release（BOT_TOKEN），全程不落
  │    内存，上限由 Cloudflare 请求体限制而非 Worker 的 128 MB 内存决定
  │ ⑥ repository_dispatch: web-submission
  ▼
CardputerZero/packages Actions（packages-workflows/ 里的两个 workflow）
  │ ⑦ dpkg-deb 权威校验：完整性 / control / .desktop / setuid / 设备文件 /
  │    越权路径 / maintainer 脚本危险模式 / 邮箱归属 / 版本单调
  │ ⑧ store 元数据：优先源码仓库 app-builder.json，否则从 deb 自动生成
  │ ⑨ 通过 → 发布 PR（AUTO_MERGE=true 时自动合并）；失败 → issue @提交者
  ▼
update-index.yml（已有）→ .deb 提升进 apt-pool → APT 索引/商店 JSON 更新
```

信任模型：浏览器解析只做**预览与提前拦截**（好体验）；一切以 Actions 里
`dpkg-deb` 的服务端校验为准，客户端传来的任何字段都不会被直接采信。

## 抢占式包名归属

- 新包名：任何人首次提交即占有，归属记录为提交者的 GitHub 登录名（发布清单
  里的 `uploaded_by`）。不做 deb 的 `Maintainer` 邮箱与 GitHub 账号的匹配。
- 已有包名：仅记录的上传者本人或管理员可更新/下架；早期没有 `uploaded_by`
  的包，从线上包 `Maintainer` 的 noreply 地址反推登录名。
- 管理员：`wrangler.toml` 的 `ADMIN_LOGINS`（逗号分隔的 GitHub 登录名）
  可管理任意包。
- 相同版本再次提交 → 前端与服务端都会提示"版本已存在，请提升版本号"。

## 初步安全报告（浏览器 + CI 双层）

- setuid/setgid、全局可写、设备文件、路径穿越
- 安装路径策略：对齐 Debian 的标准位置（`usr/bin/`、`usr/share/`、`usr/lib/`、
  `opt/`、`etc/`、`var/lib/`、`usr/share/APPLaunch/`、`usr/share/doc/`、
  `(usr/)lib/systemd/system/`），但共享目录里的文件名/目录名必须与包名相关
  （比对时忽略 `-` `_` `.` 的差异），因此装不进 `usr/bin/ls` 或 `sshd.service`；
  `usr/local/` 与 `/bin` `/sbin` `/lib` 等 usr-merge 别名路径按 Debian Policy
  9.1.2 / 10.1 一律拒绝。被拒时网页与失败 issue 都会给出规则说明和一段可直接
  交给 AI 的提示词（前端 `site/debparse.js` 与 CI 的实现由测试保证逐字一致）。
- systemd 服务不得以 root 运行（`[Service]` 需有非 root 的 `User=`
  或 `DynamicUser=`），浏览器与 CI 同样判定
- ELF 架构核对（非 arm64 告警）
- maintainer 脚本危险模式（`rm -rf /`、`curl|sh`、写设备、动 passwd/cron 等）
- 缺 `.desktop`/图标、包名/架构不合法、超大文件

## 部署（GitHub Actions CI/CD）

**主路径就是 CI/CD**：push `main` 即自动测试 + `wrangler deploy` 到
Cloudflare Workers（不使用 Cloudflare 的 git 集成 / 自动拉取部署）。
完整步骤（域名接入、OAuth App、bot token、GitHub secrets 配置）见
[docs/DEPLOY.md](docs/DEPLOY.md)。

概要：

1. `cardputer.cc` 的 zone 已在 Cloudflare（NS 已切）；`wrangler.toml` 声明的
   `dev.cardputer.cc` 自定义域会在首次部署时自动接管 DNS + 证书。
2. 仓库 Settings → Secrets and variables → Actions 配置：
   - `CLOUDFLARE_API_TOKEN`（必需，Workers Scripts: Edit；首次部署自定义域
     还需 Workers Custom Domains: Edit + zone DNS: Edit）
   - `CLOUDFLARE_ACCOUNT_ID`（必需）
   - `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / `BOT_TOKEN` /
     `SESSION_SECRET`（可选：配置后每次部署自动同步到 Worker secrets；
     也可以本地 `wrangler secret put` 一次性设置）
3. push `main`（或手动 workflow_dispatch）→ 自动部署。
4. `packages-workflows/` 下的两个文件复制到 `CardputerZero/packages` 的
   `.github/workflows/`（一次性）。想保留人工审核就把其中 `AUTO_MERGE`
   改为 `"false"`（PR 仍会自动创建，由管理员合并）。

在 `worker/wrangler.toml` 的 `[vars] ADMIN_LOGINS` 里填管理员的 GitHub
登录名（逗号分隔）。

## 本地开发

```bash
cd worker && wrangler dev   # http://localhost:8787，页面 + API 同域
```

解析器单元测试（zstd/bzip2/lzma 直接用页面同款 vendored 纯 JS 库解压，
gzip 用 node:zlib，xz 用系统 xz；需要 `apt install dpkg xz-utils bzip2`）：

```bash
node --test test/*.test.js
```
