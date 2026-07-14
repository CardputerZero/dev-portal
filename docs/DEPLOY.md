# 部署指南（Cloudflare Worker + GitHub Actions CI/CD）

本仓库通过 **GitHub Actions** 部署到 Cloudflare Workers（`wrangler deploy`），
**不是** Cloudflare 控制台的 "连接 GitHub 自动拉取" 集成。push `main`
分支即自动测试并部署，全程可在仓库 Actions 页追踪。

```
push main ──▶ GitHub Actions（.github/workflows/deploy.yml）
                │ ① node --test：deb 解析器单元测试
                │ ② wrangler deploy（cloudflare/wrangler-action）
                │ ③ 可选：把 GitHub secrets 同步到 Worker secrets
                ▼
        Cloudflare Workers（dev.cardputer.cc，静态页面 + API 同域）
```

## 一、域名接入 Cloudflare（一次性）

1. Cloudflare 控制台 → Add site → `cardputer.cc`（免费版即可），把域名 NS
   切到 Cloudflare（当前已完成：`eva.ns.cloudflare.com` / `nick.ns.cloudflare.com`）。
2. 主站 `cardputer.cc` 继续指向 GitHub Pages（A 记录 185.199.108–111.153），
   互不影响；开发者中心用 `dev.cardputer.cc` 子域，由 Worker 的
   custom domain 自动接管 DNS + 证书，**无需手动加 DNS 记录**。

`worker/wrangler.toml` 中已声明：

```toml
routes = [
  { pattern = "dev.cardputer.cc", custom_domain = true },
]
```

## 二、创建 GitHub OAuth App（一次性）

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App：

- Homepage URL: `https://dev.cardputer.cc`
- Authorization callback URL: `https://dev.cardputer.cc/auth/callback`

记下 Client ID / Client Secret（下面配 secrets 用）。

## 三、准备 bot token（一次性）

建议用机器人账号（或组织管理员）创建 fine-grained PAT：

- Repository access: 仅 `CardputerZero/packages`
- Permissions: **Contents: Read and write**（上传 buffer Release 资产 +
  触发 `repository_dispatch`）

## 四、配置 GitHub Actions secrets

本仓库 Settings → Secrets and variables → Actions → New repository secret：

| Secret | 必需 | 说明 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | ✅ | Cloudflare API token。My Profile → API Tokens → Create Token，权限 **Workers Scripts: Edit**；首次部署要建自定义域，还需 **Workers Custom Domains: Edit** 和 `cardputer.cc` zone 的 **DNS: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 控制台任一域名概览页右侧栏的 Account ID |
| `OAUTH_CLIENT_ID` | 可选 | 第二步的 Client ID → 同步为 Worker secret `GITHUB_CLIENT_ID` |
| `OAUTH_CLIENT_SECRET` | 可选 | 第二步的 Client Secret → 同步为 `GITHUB_CLIENT_SECRET` |
| `BOT_TOKEN` | 可选 | 第三步的 PAT → 同步为 `BOT_TOKEN` |
| `SESSION_SECRET` | 可选 | `openssl rand -hex 32` → 同步为 `SESSION_SECRET` |

> GitHub 不允许 secret 名以 `GITHUB_` 开头，所以 OAuth 两项在 GitHub 侧叫
> `OAUTH_*`，workflow 会以 Worker 侧的正式名字 `GITHUB_CLIENT_ID` /
> `GITHUB_CLIENT_SECRET` 写入。
>
> 4 个"可选"项：配置在 GitHub 后**每次部署自动同步**到 Worker（推荐，改
> 密钥只需改 GitHub secret 再跑一次部署）；不配置则 workflow 跳过同步，
> 需要本地手动设置一次：
>
> ```bash
> cd worker
> wrangler login
> wrangler secret put GITHUB_CLIENT_ID
> wrangler secret put GITHUB_CLIENT_SECRET
> wrangler secret put BOT_TOKEN
> wrangler secret put SESSION_SECRET
> ```

## 五、触发部署

- push 任何提交到 `main` → 自动测试 + 部署；
- 或 Actions → "Deploy to Cloudflare" → Run workflow 手动触发。

部署完成后访问 `https://dev.cardputer.cc` 验证。

## 六、packages 仓库侧（一次性）

把 `packages-workflows/` 下的两个 workflow 复制到
`CardputerZero/packages` 的 `.github/workflows/`：

- `process-web-submission.yml` — 接收网页提交，dpkg-deb 权威校验，
  通过后自动开发布 PR（`AUTO_MERGE: "true"` 时自动合并；改为
  `"false"` 则保留人工审核）；失败开 issue @提交者。
- `process-web-unpublish.yml` — 接收下架请求，生成移除 PR。

并在 `packages` 仓库建 `web-submission-failed` label（失败反馈 issue 用）。

## 安全设计

- **身份**：GitHub OAuth（scope `user:email`，读已验证邮箱）；Worker 用
  HMAC 签名的 HttpOnly cookie 维持 24h 会话，不保存用户 OAuth token。
- **信任边界**：用户上传内容一律视为不可信——浏览器解析只做预览体验，
  Worker 只做魔数/大小/归属/版本预检；语义校验全部在 packages 仓库
  Actions 里用 `dpkg-deb` 完成，`.deb` 永不被执行。
- **身份绑定**：包的 `Maintainer` 邮箱必须 ∈ 提交者的 GitHub 已验证邮箱
  （或 `<login>@users.noreply.github.com`），抢占式归属，防冒名顶替或
  覆盖他人的包；`ADMIN_LOGINS` 管理员可管理任意包。
- **payload 传递**：workflow 中所有来自 dispatch payload 的值只经 env
  传入 shell，杜绝模板注入。
- **上限**：Worker 默认 64 MB（`MAX_SIZE_MB`），Cloudflare 免费版请求体
  上限 100 MB。
- 可选加固：Cloudflare 侧对 `/api/submit` 配 rate limiting 规则防刷。

## 与 OSS 直传的取舍

如果更希望文件落在阿里云 OSS（国内直传快）：OSS bucket 支持配置 CORS 允许
浏览器直传，但生成上传签名同样需要一个服务端（函数计算/STS），之后还要一跳
回调 GitHub API。整体链路比 Worker 方案多一层，且 packages 管线最终仍要从
URL 拉取 `.deb` 校验。因此推荐当前方案（`.deb` 直接进 GitHub Release，与
现有 apt-pool 分发/OSS 镜像同步逻辑无缝衔接）；将来如需国内上传加速，只需
把 Worker 的转存一步换成"签名直传 OSS + manifest url 指向 OSS"，其余不变。
