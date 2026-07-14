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
  │ ① 选择 .deb → 本地解析（ar/tar/gz/xz/zstd 纯前端解包）
  │    展示图标 / 包名 / 版本 / .desktop / 邮箱 / 文件清单 / 安全报告
  │    并对照线上索引预检：包名归属、版本是否重复/倒退
  │ ② GitHub OAuth 登录（scope: user:email，读取已验证邮箱）
  │ ③ POST /api/submit（同域，无 CORS）
  ▼
Cloudflare Worker（本仓库 worker/，静态页面同域托管）
  │ ④ 会话校验 + 归属/版本预检（拉线上 Packages 索引比对）
  │ ⑤ .deb 存入 packages 仓库 web-upload-buffer Release（BOT_TOKEN）
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

- 新包名：任何人首次提交即占有（deb 的 `Maintainer` 邮箱必须是提交者
  GitHub 账号的已验证邮箱或 `<login>@users.noreply.github.com`）。
- 已有包名：仅当线上包的 Maintainer 邮箱 ∈ 提交者已验证邮箱时可更新/下架。
- 管理员：`wrangler.toml` 的 `ADMIN_LOGINS`（逗号分隔的 GitHub 登录名）
  可管理任意包。
- 相同版本再次提交 → 前端与服务端都会提示"版本已存在，请提升版本号"。

## 初步安全报告（浏览器 + CI 双层）

- setuid/setgid、全局可写、设备文件、路径穿越
- 安装路径白名单（`usr/share/APPLaunch/`、`lib/systemd/system/`、
  `usr/share/<pkg>/`、`usr/lib/<pkg>/`、`opt/<pkg>/`、`usr/share/doc/`）
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

解析器单元测试（用系统 gzip/xz/zstd 模拟浏览器解压）：

```bash
node --test test/*.test.js
```
