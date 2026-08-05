/**
 * CardputerZero developer portal — Cloudflare Worker.
 *
 * Serves the static portal (../site via the assets binding) and the API on
 * the same origin (no CORS involved):
 *
 *   GET  /auth/login      GitHub OAuth (scope: user:email — verified emails)
 *   GET  /auth/callback   code exchange, sets signed session cookie
 *   GET  /auth/logout
 *   GET  /api/me          {login, emails, is_admin}
 *   GET  /api/config      {max_size_mb} — upload limit, for client pre-checks
 *   POST /api/submit/prepare   json: metadata → signed upload ticket
 *   PUT  /api/submit/deb       raw octet-stream: the .deb bytes
 *   POST /api/submit/finalize  multipart: store metadata + PNGs → dispatch
 *   POST /api/unpublish   json: {package, version}
 *
 * Submitting is three requests so the .deb never has to be materialized in
 * memory: `prepare` validates everything cheap (ownership, version bump, size)
 * and mints a short-lived signed ticket, `deb` streams the bytes straight
 * through to the GitHub release, and `finalize` attaches the small store
 * images and dispatches the publish event. The ticket carries the state
 * between steps, which keeps the Worker stateless (no KV or Durable Object).
 *
 * Trust model: the browser parses the .deb for preview UX, but nothing the
 * client sends is trusted for enforcement. This Worker re-checks ownership
 * and version monotonicity against the published APT index, and the
 * packages-repo GitHub Action re-validates everything with real dpkg-deb
 * before a publish PR is created. The one value now sourced from the client is
 * the .deb's sha256: streaming means the Worker no longer sees the whole file
 * at once, so the digest is computed in the browser and forwarded purely as a
 * transfer-integrity checksum, which the Action re-computes with sha256sum and
 * rejects on mismatch. The declared byte length is enforced rather than
 * trusted — FixedLengthStream fails the upload if the body does not match.
 *
 * Secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, BOT_TOKEN, SESSION_SECRET.
 * Vars: see wrangler.toml.
 */

import { compareDebVersions, loginFromNoreply } from "../../site/debparse.js";

const SESSION_COOKIE = "cz_session";
const STATE_COOKIE = "cz_oauth_state";
const SESSION_TTL_SECS = 24 * 3600;
const USER_AGENT = "cardputerzero-dev-portal/1.0";
const TICKET_HEADER = "x-cz-upload-ticket";
// Marks a sealed blob as an upload ticket so a session cookie cannot be
// replayed as one (both are signed with SESSION_SECRET).
const TICKET_KIND = "upload";
// Generous enough to stream a max-size .deb over a slow uplink.
const TICKET_TTL_SECS = 3600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // NOTE: these are awaited so async rejections are caught here and turned
      // into a readable JSON 500 instead of an opaque Cloudflare 1101 page.
      switch (`${request.method} ${url.pathname}`) {
        case "GET /auth/login": return await authLogin(url, env);
        case "GET /auth/callback": return await authCallback(request, url, env);
        case "GET /auth/logout": return await authLogout(env);
        case "GET /api/me": return await apiMe(request, env);
        case "GET /api/config": return json(200, { max_size_mb: Number(maxSizeMb(env)) });
        case "GET /api/my-submissions": return await apiMySubmissions(request, env);
        case "POST /api/submit/prepare": return await apiSubmitPrepare(request, env);
        case "PUT /api/submit/deb": return await apiSubmitDeb(request, env);
        case "POST /api/submit/finalize": return await apiSubmitFinalize(request, env);
        case "POST /api/unpublish": return await apiUnpublish(request, env);
      }
      // Everything else falls through to the static assets.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err.stack || String(err));
      return json(500, { error: "internal", detail: String(err.message || err) });
    }
  },
};

/* ---------------------------------- auth --------------------------------- */

function authLogin(url, env) {
  const state = crypto.randomUUID();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  target.searchParams.set("scope", "user:email"); // verified email addresses
  target.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Set-Cookie": cookie(STATE_COOKIE, state, 600),
    },
  });
}

async function authCallback(request, url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || parseCookies(request)[STATE_COOKIE] !== state) {
    return json(400, { error: "bad_oauth_state", detail: "state 校验失败，请回到首页重新点击登录（不要直接刷新回调页）" });
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return json(500, { error: "server_misconfigured", detail: "Worker 缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET secret" });
  }
  if (!env.SESSION_SECRET) {
    return json(500, { error: "server_misconfigured", detail: "Worker 缺少 SESSION_SECRET secret" });
  }

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  const token = tokenData.access_token;
  if (!token) {
    return json(502, {
      error: "oauth_exchange_failed",
      detail: tokenData.error_description || tokenData.error || `token 交换失败 (HTTP ${tokenResp.status})`,
    });
  }

  // Read identity + verified emails, then discard the user token.
  const userHeaders = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
  const userResp = await fetch("https://api.github.com/user", { headers: userHeaders });
  const user = await userResp.json().catch(() => ({}));
  if (!userResp.ok || !user.login) {
    return json(502, {
      error: "github_user_failed",
      detail: user.message || `读取 GitHub 用户信息失败 (HTTP ${userResp.status})`,
    });
  }
  let verified = [];
  try {
    const emails = await (await fetch("https://api.github.com/user/emails", { headers: userHeaders })).json();
    if (Array.isArray(emails)) {
      verified = emails.filter((e) => e.verified).map((e) => e.email.toLowerCase());
    }
  } catch { /* user:email may be revoked; noreply fallback below still works */ }

  const emails = [...new Set([
    `${user.login.toLowerCase()}@users.noreply.github.com`,
    `${user.id}+${user.login.toLowerCase()}@users.noreply.github.com`,
    ...verified,
  ])].slice(0, 12);

  const isAdmin = (env.ADMIN_LOGINS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(user.login.toLowerCase());

  const session = await seal(env, {
    l: user.login,
    e: emails,
    a: isAdmin,
    x: Math.floor(Date.now() / 1000) + SESSION_TTL_SECS,
  });
  const headers = new Headers({ Location: env.RETURN_PATH || "/" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, SESSION_TTL_SECS));
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

function authLogout(env) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: env.RETURN_PATH || "/",
      "Set-Cookie": cookie(SESSION_COOKIE, "", 0),
    },
  });
}

async function apiMe(request, env) {
  const s = await openSession(request, env);
  if (!s) return json(401, { error: "not_logged_in" });
  return json(200, { login: s.l, emails: s.e, is_admin: s.a });
}

/* --------------------------------- submit -------------------------------- */

/**
 * Step 1: validate everything that does not need the .deb bytes, then mint the
 * ticket authorizing the upload. Rejecting here means a squatted name or a
 * stale version number is reported before the developer spends minutes pushing
 * tens of megabytes.
 */
async function apiSubmitPrepare(request, env) {
  const s = await openSession(request, env);
  if (!s) return json(401, { error: "not_logged_in" });

  const body = await request.json().catch(() => ({}));
  const pkg = String(body.package || "").trim();
  const version = String(body.version || "").trim();
  const arch = String(body.arch || "").trim();
  const sha256 = String(body.sha256 || "").trim().toLowerCase();
  const size = Number(body.size);

  const invalid = validateSubmission({
    pkg, version, arch, sourceRepo: String(body.source_repo || "").trim(),
  });
  if (invalid) return invalid;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return json(400, { error: "bad_sha256" });
  if (!Number.isInteger(size) || size <= 0 || size > maxUploadBytes(env)) {
    return json(413, { error: "bad_size", detail: `1B ~ ${maxSizeMb(env)}MB` });
  }

  const blocked = await precheckOwnership(env, s, pkg, version);
  if (blocked) return blocked;

  return json(200, {
    ticket: await seal(env, {
      k: TICKET_KIND,
      l: s.l,
      p: pkg,
      v: version,
      a: arch,
      s: sha256,
      z: size,
      x: Math.floor(Date.now() / 1000) + TICKET_TTL_SECS,
    }),
  });
}

/**
 * Step 2: stream the .deb into the buffer release. Nothing is buffered, so
 * memory stays proportional to a single chunk rather than to the file, and the
 * only remaining ceiling is the Cloudflare plan's request body limit instead
 * of the 128 MB isolate limit.
 */
async function apiSubmitDeb(request, env) {
  const s = await openSession(request, env);
  if (!s) return json(401, { error: "not_logged_in" });
  const ticket = await openTicket(env, s, request.headers.get(TICKET_HEADER));
  if (!ticket) return json(403, { error: "bad_ticket", detail: "上传票据无效或已过期，请重新提交" });
  if (!request.body) return json(400, { error: "missing_deb_file" });

  // The declared length must match what prepare approved. It is also what
  // bounds the transfer: FixedLengthStream fails the upload if the body turns
  // out to be a different size, so the limit is enforced without counting
  // bytes ourselves.
  const length = Number(request.headers.get("content-length"));
  if (!Number.isInteger(length) || length !== ticket.z) {
    return json(400, { error: "length_mismatch", detail: "请求体长度与预检声明不符" });
  }

  // Check the ar magic against the leading bytes only, then put them back in
  // front of the body being forwarded.
  const { bytes, stream } = await peekBytes(request.body, 8);
  if (new TextDecoder().decode(bytes) !== "!<arch>\n") return json(400, { error: "not_a_deb" });

  const release = await ensureBufferRelease(env);
  const assetName = `${s.l}__${canonicalName(ticket)}`;
  await deleteAsset(env, release, assetName);

  // FixedLengthStream gives the outgoing body a known length, which the GitHub
  // upload API requires — it rejects chunked transfer encoding. pipeTo must not
  // be awaited: it only settles once GitHub has drained the whole body.
  const { readable, writable } = new FixedLengthStream(length);
  stream.pipeTo(writable).catch(() => { /* surfaces as a failed upload below */ });
  const upload = await fetch(
    `https://uploads.github.com/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}` +
    `/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    { method: "POST", headers: { ...bot(env), "content-type": "application/octet-stream" }, body: readable },
  );
  if (!upload.ok) return json(502, { error: "upload_failed", detail: await safeText(upload) });
  const asset = await upload.json();

  // The asset id rides along so finalize can discard the bytes if it ends up
  // rejecting the submission.
  return json(200, {
    ticket: await seal(env, { ...ticket, u: asset.browser_download_url, i: asset.id }),
  });
}

/**
 * Step 3: attach the optional store metadata and images, then dispatch the
 * publish event.
 */
async function apiSubmitFinalize(request, env) {
  const s = await openSession(request, env);
  if (!s) return json(401, { error: "not_logged_in" });

  // Only text fields and the store PNGs (≤512 KB each) arrive here, so
  // buffering this form costs little.
  const form = await request.formData();
  const ticket = await openTicket(env, s, request.headers.get(TICKET_HEADER));
  if (!ticket) return json(403, { error: "bad_ticket", detail: "上传票据无效或已过期，请重新提交" });
  if (!ticket.u) return json(409, { error: "deb_not_uploaded", detail: "请先完成 .deb 上传" });

  const sourceRepo = String(form.get("source_repo") || "").trim();
  const invalid = validateSubmission({
    pkg: ticket.p, version: ticket.v, arch: ticket.a, sourceRepo,
  });
  if (invalid) return invalid;
  // Privacy toggle (default: hide). When hidden we only forward the noreply
  // form(s), so the packages-repo Action records a noreply address as the
  // uploader email. When the developer opts in, a verified GitHub email is put
  // first so it becomes the recorded contact address.
  const hideEmail = form.get("hide_email") !== "false";

  // Re-check ownership: minutes can pass while the bytes upload, and the
  // dispatch below cannot be undone. A rejection this late means the bytes are
  // already in the staging release, so drop them rather than leave them behind
  // (a submission abandoned before this step still leaks one asset, which the
  // next upload of the same name overwrites).
  const blocked = await precheckOwnership(env, s, ticket.p, ticket.v);
  if (blocked) {
    if (ticket.i) await deleteAssetById(env, ticket.i).catch(() => { /* best effort */ });
    return blocked;
  }

  const release = await ensureBufferRelease(env);

  // Optional store metadata + screenshots/icon supplied directly from the web
  // form (equivalent to czdev's app-builder.json `store` section). Images go to
  // the same buffer release as the .deb; the Action downloads and commits them
  // as small PNGs into pool/main/<pkg>/ (no Git LFS).
  let store;
  try {
    store = await collectStoreAssets(form, env, release, s.l, ticket.p);
  } catch (e) {
    return json(502, { error: "image_upload_failed", detail: String(e && e.message || e) });
  }
  if (store && store.error) return json(store.status || 400, { error: store.error, detail: store.detail });

  // s.e is [noreply…, …verified]; the Action uses element [0] as the recorded
  // uploader email. Hide → keep only noreply; show → put a verified email first
  // (falling back to noreply when the account exposes none).
  const noreply = s.e.filter((e) => e.endsWith("@users.noreply.github.com"));
  const verified = s.e.filter((e) => !e.endsWith("@users.noreply.github.com"));
  const emailsOut = hideEmail
    ? noreply
    : (verified.length ? [...verified, ...noreply] : s.e);

  const dispatch = await gh(env, `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      event_type: "web-submission",
      client_payload: {
        login: s.l,
        emails: emailsOut,
        is_admin: s.a,
        package: ticket.p,
        version: ticket.v,
        architecture: ticket.a,
        filename: canonicalName(ticket),
        // url/sha256/size are nested under one key: repository_dispatch caps
        // client_payload at 10 top-level properties, and with `store` we'd
        // otherwise hit 12 → GitHub returns HTTP 422.
        binary: { url: ticket.u, sha256: ticket.s, size: ticket.z },
        source_repo: sourceRepo,
        ...(store && store.payload ? { store: store.payload } : {}),
      },
    }),
  });
  if (dispatch.status !== 204) return json(502, { error: "dispatch_failed", detail: await safeText(dispatch) });

  return json(200, {
    ok: true,
    sha256: ticket.s,
    message: "已提交，服务器正在做最终校验；通过后会自动生成发布 PR。",
    // Scope the link to this exact package+version title so it lands on THIS
    // submission's PR, not stale/older PRs for the same package.
    track_url: `https://github.com/${env.TARGET_OWNER}/${env.TARGET_REPO}/pulls?q=${encodeURIComponent(`is:pr in:title ${ticket.p} ${ticket.v}`)}`,
    actions_url: `https://github.com/${env.TARGET_OWNER}/${env.TARGET_REPO}/actions/workflows/process-web-submission.yml`,
  });
}

/* ---------------------------- submit helpers ----------------------------- */

function maxSizeMb(env) {
  return env.MAX_SIZE_MB || "80";
}

function maxUploadBytes(env) {
  return Number(maxSizeMb(env)) * 1024 * 1024;
}

/** The published filename; `~` is not allowed in a GitHub release asset name. */
function canonicalName(ticket) {
  return `${ticket.p}_${ticket.v}_${ticket.a}.deb`.replace(/~/g, ".");
}

/** Returns a Response describing the first invalid field, or null when clean. */
function validateSubmission({ pkg, version, arch, sourceRepo }) {
  if (!/^[a-z0-9][a-z0-9.+-]+$/.test(pkg)) return json(400, { error: "bad_package_name" });
  if (!/^[a-zA-Z0-9.+~:-]+$/.test(version)) return json(400, { error: "bad_version" });
  if (!["arm64", "all"].includes(arch)) return json(400, { error: "bad_arch" });
  if (sourceRepo && !/^https:\/\/[\w.-]+\/[\w./-]+$/.test(sourceRepo)) {
    return json(400, { error: "bad_source_repo" });
  }
  return null;
}

/**
 * Pre-flight against the published index: name squatting + version bump.
 * Ownership is first-come-first-served by GitHub login, resolved from the
 * published owners.json (aggregated from the release manifests' uploaded_by)
 * with a noreply-Maintainer fallback for legacy packages. This pre-check
 * blocks only when the name is positively attributable to a *different*
 * login; the packages-repo Action re-checks authoritatively against the
 * recorded `uploaded_by`. Returns a Response when blocked, null when clear.
 */
async function precheckOwnership(env, s, pkg, version) {
  const [index, owners] = await Promise.all([fetchIndex(env), fetchOwners(env)]);
  const entries = index.get(pkg) || [];
  if (!entries.length) return null;

  const ownerLogin = packageOwner(owners, pkg) || loginFromNoreply(entries[0].maintainer);
  if (!s.a && ownerLogin && ownerLogin !== s.l.toLowerCase()) {
    return json(403, {
      error: "not_owner",
      detail: `包名 "${pkg}" 已被 @${ownerLogin} 占用，只有其本人或管理员可以更新/下架`,
    });
  }
  const latest = entries.map((e) => e.version).sort(compareDebVersions).pop();
  if (compareDebVersions(version, latest) === 0) {
    return json(409, { error: "version_exists", detail: `版本 ${version} 已存在，请提升版本号` });
  }
  if (compareDebVersions(version, latest) < 0) {
    return json(409, { error: "version_too_old", detail: `版本必须高于已发布的 ${latest}` });
  }
  return null;
}

/**
 * Read at least `n` bytes off a stream and hand back both those bytes and a
 * stream still yielding the complete original sequence, so a prefix can be
 * inspected without buffering the body.
 */
export async function peekBytes(stream, n) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  while (size < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const head = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    head.set(chunk, at);
    at += chunk.byteLength;
  }
  return {
    // Shorter than n only when the body ended early, which fails the caller's
    // magic-byte comparison anyway.
    bytes: head.subarray(0, n),
    stream: new ReadableStream({
      start(controller) {
        if (size) controller.enqueue(head);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

/* -------------------------------- unpublish ------------------------------ */

async function apiUnpublish(request, env) {
  const s = await openSession(request, env);
  if (!s) return json(401, { error: "not_logged_in" });

  const { package: pkg, version } = await request.json();
  if (!/^[a-z0-9][a-z0-9.+-]+$/.test(pkg || "")) return json(400, { error: "bad_package_name" });
  if (!/^[a-zA-Z0-9.+~:-]+$/.test(version || "")) return json(400, { error: "bad_version" });

  const [index, owners] = await Promise.all([fetchIndex(env), fetchOwners(env)]);
  const entries = index.get(pkg) || [];
  const entry = entries.find((e) => e.version === version);
  if (!entry) return json(404, { error: "not_published", detail: `${pkg} ${version} 不在线上索引中` });

  const ownerLogin = packageOwner(owners, pkg) || loginFromNoreply(entry.maintainer);
  if (!s.a && ownerLogin && ownerLogin !== s.l.toLowerCase()) {
    return json(403, { error: "not_owner", detail: `包 "${pkg}" 由 @${ownerLogin} 上传，只有其本人或管理员可以下架` });
  }

  const dispatch = await gh(env, `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      event_type: "web-unpublish",
      client_payload: {
        login: s.l,
        emails: s.e,
        is_admin: s.a,
        package: pkg,
        version,
        architecture: entry.architecture || "arm64",
      },
    }),
  });
  if (dispatch.status !== 204) return json(502, { error: "dispatch_failed", detail: await safeText(dispatch) });

  return json(200, {
    ok: true,
    message: "下架请求已提交，将自动生成移除 PR。",
    track_url: `https://github.com/${env.TARGET_OWNER}/${env.TARGET_REPO}/pulls?q=is%3Apr+unpublish+${pkg}`,
  });
}

/* ----------------------------- my submissions ----------------------------- */

/**
 * Recent publish PRs belonging to the caller, so the portal can show
 * just-uploaded packages that are not (yet) in the published APT index:
 * open = under review, merged = published but the index/CDN may still be
 * rebuilding. Portal submissions are matched by the "(portal submission by
 * @login)" title suffix (the PR author is the bot); czdev submissions are
 * matched by the PR author itself. Admins see everyone's submissions.
 */
async function apiMySubmissions(request, env) {
  const s = await openSession(request, env);
  if (!s) return json(401, { error: "not_logged_in" });

  const resp = await gh(
    env,
    `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/pulls?state=all&sort=created&direction=desc&per_page=50`,
  );
  if (!resp.ok) return json(502, { error: "github_failed", detail: await safeText(resp) });
  const prs = await resp.json();

  const me = s.l.toLowerCase();
  const out = [];
  for (const pr of prs) {
    const m = /^publish: (\S+) (\S+)/.exec(pr.title || "");
    if (!m) continue;
    const portal = /\(portal submission by @([\w-]+)\)/i.exec(pr.title);
    const submitter = (portal ? portal[1] : (pr.user && pr.user.login) || "").toLowerCase();
    if (!s.a && submitter !== me) continue;
    out.push({
      package: m[1],
      version: m[2],
      submitter,
      state: pr.merged_at ? "merged" : pr.state, // "open" | "merged" | "closed"
      url: pr.html_url,
      created_at: pr.created_at,
      merged_at: pr.merged_at,
    });
  }
  return json(200, out);
}

/* ------------------------------ APT index -------------------------------- */

/**
 * Authoritative package ownership published by the packages repo's Pages
 * build: { "<package>": { "<version>": "<github login, lowercase>" } },
 * aggregated from the release manifests' `uploaded_by`. Missing for legacy
 * packages — callers fall back to loginFromNoreply(Maintainer).
 */
async function fetchOwners(env) {
  const url = env.PACKAGES_INDEX_URL.replace(/\/dists\/.*$/, "/owners.json");
  try {
    const resp = await fetch(url, { headers: { "user-agent": USER_AGENT }, cf: { cacheTtl: 60 } });
    if (resp.ok) return await resp.json();
  } catch { /* not deployed yet / unreachable — fall back to Maintainer */ }
  return {};
}

/** First recorded login for a package (all versions share one owner). */
function packageOwner(owners, pkg) {
  const versions = owners && owners[pkg];
  if (!versions) return "";
  for (const v of Object.keys(versions)) {
    const login = String(versions[v] || "").toLowerCase();
    if (login) return login;
  }
  return "";
}

/** Parse the published Packages index into Map<name, [{version, maintainer, architecture}]>. */
async function fetchIndex(env) {
  const map = new Map();
  let text = "";
  try {
    const resp = await fetch(env.PACKAGES_INDEX_URL, {
      headers: { "user-agent": USER_AGENT },
      cf: { cacheTtl: 60 },
    });
    if (resp.ok) text = await resp.text();
  } catch { /* index unreachable — treat as empty; Action re-checks anyway */ }

  for (const para of text.split(/\n\n+/)) {
    const fields = {};
    for (const line of para.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx > 0 && !/^\s/.test(line)) fields[line.slice(0, idx)] = line.slice(idx + 2).trim();
    }
    if (!fields.Package) continue;
    if (!map.has(fields.Package)) map.set(fields.Package, []);
    map.get(fields.Package).push({
      version: fields.Version || "",
      maintainer: fields.Maintainer || "",
      architecture: fields.Architecture || "",
    });
  }
  return map;
}

/* ------------------------------ github utils ----------------------------- */

function bot(env) {
  return {
    authorization: `Bearer ${env.BOT_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, { ...init, headers: { ...bot(env), ...(init.headers || {}) } });
}

async function ensureBufferRelease(env) {
  const tag = env.BUFFER_TAG || "web-upload-buffer";
  const existing = await gh(env, `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/releases/tags/${tag}`);
  if (existing.ok) return existing.json();
  if (existing.status !== 404) throw new Error(`release lookup failed: ${existing.status}`);
  const created = await gh(env, `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag,
      name: "web upload buffer",
      prerelease: true,
      body: "Holds .deb files uploaded via the developer portal pending review.",
    }),
  });
  if (!created.ok) throw new Error(`release create failed: ${created.status}`);
  return created.json();
}

async function deleteAsset(env, release, name) {
  const found = (release.assets || []).find((a) => a.name === name);
  if (found) await deleteAssetById(env, found.id);
}

function deleteAssetById(env, id) {
  return gh(env, `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/releases/assets/${id}`, { method: "DELETE" });
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Read a PNG's pixel dimensions from its IHDR chunk without decoding it, or
// null when the bytes are not a PNG. IHDR is always the first chunk, so width
// and height are the two big-endian u32 at byte offset 16.
function pngDims(bytes) {
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

async function uploadImageAsset(env, release, name, buf) {
  await deleteAsset(env, release, name);
  const up = await fetch(
    `https://uploads.github.com/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}` +
    `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { ...bot(env), "content-type": "image/png" }, body: buf },
  );
  if (!up.ok) throw new Error(await safeText(up));
  return { url: (await up.json()).browser_download_url, sha256: hex(await crypto.subtle.digest("SHA-256", buf)) };
}

// Gather optional store metadata + screenshots/icon from the submit form. Returns
// {} when nothing was supplied (submission falls back to source_repo/deb), a
// {payload} describing the store section, or an {error, detail, status} on
// validation failure. Screenshots are enforced at 320×170 (the CardputerZero
// LCD); icons must be square PNGs.
async function collectStoreAssets(form, env, release, login, pkg) {
  const title = String(form.get("title") || "").trim();
  const summary = String(form.get("summary") || "").trim();
  const description = String(form.get("description") || "").trim();
  const categoriesRaw = String(form.get("categories") || "").trim();
  const iconFile = form.get("icon");
  const hasIcon = iconFile && typeof iconFile.arrayBuffer === "function" && iconFile.size > 0;
  const shots = form.getAll("screenshots").filter((f) => f && typeof f.arrayBuffer === "function" && f.size > 0);

  if (!(title || summary || description || categoriesRaw || hasIcon || shots.length)) return {};

  const MAX_IMG = 512 * 1024;
  const categories = categoriesRaw
    ? categoriesRaw.split(",").map((c) => c.trim()).filter(Boolean).slice(0, 6)
    : [];
  const payload = { title, summary, description, categories, icon: null, screenshots: [] };

  if (shots.length > 6) return { error: "too_many_screenshots", detail: "最多 6 张截图" };
  let idx = 0;
  for (const f of shots) {
    const b = await f.arrayBuffer();
    if (b.byteLength > MAX_IMG) return { error: "screenshot_too_large", detail: "单张截图需 < 512KB" };
    const d = pngDims(new Uint8Array(b));
    if (!d) return { error: "screenshot_not_png", detail: "截图必须是 PNG" };
    if (d.w !== 320 || d.h !== 170) {
      return { error: "screenshot_bad_size", detail: `截图必须是 320×170（收到 ${d.w}×${d.h}）` };
    }
    const up = await uploadImageAsset(env, release, `${login}__${pkg}__shot${idx}.png`, b);
    payload.screenshots.push({ name: `screenshot-${idx}.png`, url: up.url, sha256: up.sha256 });
    idx++;
  }

  if (hasIcon) {
    const b = await iconFile.arrayBuffer();
    if (b.byteLength > MAX_IMG) return { error: "icon_too_large", detail: "图标需 < 512KB" };
    const d = pngDims(new Uint8Array(b));
    if (!d) return { error: "icon_not_png", detail: "图标必须是 PNG" };
    if (d.w !== d.h || d.w > 512) return { error: "icon_bad_size", detail: "图标必须是正方形 PNG（≤512×512）" };
    const up = await uploadImageAsset(env, release, `${login}__${pkg}__icon.png`, b);
    payload.icon = { name: `${pkg}_icon.png`, url: up.url, sha256: up.sha256 };
  }

  return { payload };
}

/* -------------------------------- sessions ------------------------------- */

/** Tamper-proof (not secret) envelope: base64url payload + HMAC tag. */
async function seal(env, obj) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function unseal(env, raw) {
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = raw.slice(0, idx);
  if (raw.slice(idx + 1) !== (await hmac(env.SESSION_SECRET, payload))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return null;
  }
}

async function openSession(request, env) {
  const obj = await unseal(env, parseCookies(request)[SESSION_COOKIE]);
  if (!obj || !obj.l || !Array.isArray(obj.e) || obj.x < Date.now() / 1000) return null;
  obj.e = obj.e.map((e) => String(e).toLowerCase());
  return obj;
}

/**
 * Unseal an upload ticket and bind it to the caller. The kind check keeps a
 * session cookie from being replayed as a ticket, and the login check keeps a
 * ticket from being used by anyone but the developer it was issued to.
 */
async function openTicket(env, session, raw) {
  const t = await unseal(env, raw);
  if (!t || t.k !== TICKET_KIND) return null;
  if (!t.x || t.x < Date.now() / 1000) return null;
  if (t.l !== session.l) return null;
  return t;
}

/* --------------------------------- misc ---------------------------------- */

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Best-effort body reader for surfacing upstream (GitHub) error details.
async function safeText(resp) {
  try {
    const t = await resp.text();
    return `HTTP ${resp.status}: ${t.slice(0, 400)}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

