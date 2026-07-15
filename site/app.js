/* CardputerZero developer portal front-end. Same-origin API (see worker/). */

import { parseDeb, compareDebVersions, extractEmail } from "/debparse.js";

// All decompression libraries are vendored at /vendor/ and served same-origin,
// so there is zero runtime dependency on a third-party CDN (availability,
// version drift, supply-chain, or network reachability). Each one is loaded
// lazily and only when a package actually uses that compression: a static
// top-level import would abort the whole module (blanking the page) if a
// bundle's evaluation or export shape ever failed, whereas a dynamic import
// keeps any such failure contained to that one code path.
//   xz-decompress (WASM)  — .tar.xz  (jsDelivr cjs->esm build: the class may
//                           sit on the default export instead of a named one)
//   fzstd (pure JS)       — .tar.zst fallback when DecompressionStream("zstd")
//                           is unavailable (only Chrome 133+ has it natively)
//   bz2 (pure JS)         — .tar.bz2  (legacy debs)
//   LZMA-JS d-min (pure JS)— .tar.lzma (legacy debs, LZMA "alone" format)
const lazyImports = new Map();
function lazyImport(url, pickExport) {
  if (!lazyImports.has(url)) {
    lazyImports.set(url, import(/* @vite-ignore */ url).then(pickExport));
  }
  return lazyImports.get(url);
}
const loadXz = () => lazyImport("/vendor/xz-decompress.js",
  (m) => m.XzReadableStream
    || (m.default && m.default.XzReadableStream)
    || (typeof m.default === "function" ? m.default : null));
const loadFzstd = () => lazyImport("/vendor/fzstd.js", (m) => m.decompress);
const loadBz2 = () => lazyImport("/vendor/bz2.js", (m) => m.decompress);
const loadLzma = () => lazyImport("/vendor/lzma-d.js", (m) => m.LZMA);

const INDEX_URL = "https://cardputer.cc/packages/dists/stable/main/binary-arm64/Packages";

const $ = (id) => document.getElementById(id);
let me = null;
let parsed = null;
let file = null;
let publishedIndex = null;

/* ------------------------------ decompressors ---------------------------- */

async function streamToBytes(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function loadOrExplain(loader, what) {
  let impl = null;
  try {
    impl = await loader();
  } catch { /* fall through to the user-facing error below */ }
  if (!impl) {
    throw new Error(`无法加载 ${what} 解压组件（仅用于本地预览），请刷新重试；仍可直接提交，服务器会完成校验`);
  }
  return impl;
}

const decompressors = {
  gzip: async (data) => streamToBytes(
    new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip")),
  ),
  xz: async (data) => {
    const XzReadableStream = await loadOrExplain(loadXz, "xz");
    return streamToBytes(new XzReadableStream(new Blob([data]).stream()));
  },
  zstd: async (data) => {
    // Chrome 133+/Edge expose zstd in DecompressionStream natively; every
    // other browser falls back to the vendored pure-JS fzstd decoder.
    try {
      return await streamToBytes(
        new Blob([data]).stream().pipeThrough(new DecompressionStream("zstd")),
      );
    } catch { /* native zstd unavailable (or stream failed) — use fzstd */ }
    const fzstdDecompress = await loadOrExplain(loadFzstd, "zstd");
    return fzstdDecompress(data);
  },
  bzip2: async (data) => {
    const bz2Decompress = await loadOrExplain(loadBz2, "bzip2");
    return bz2Decompress(data);
  },
  lzma: async (data) => {
    const LZMA = await loadOrExplain(loadLzma, "lzma");
    // LZMA-JS is callback-based; the result is an array of byte values, or a
    // string when the payload happens to decode as UTF-8 text.
    const result = await new Promise((resolve, reject) => {
      LZMA.decompress(data, (out, err) => (err ? reject(new Error(String(err))) : resolve(out)));
    });
    return typeof result === "string"
      ? new TextEncoder().encode(result)
      : new Uint8Array(result);
  },
};

/* --------------------------------- init ---------------------------------- */

async function init() {
  try {
    const r = await fetch("/api/me");
    if (r.ok) me = await r.json();
  } catch { /* not logged in */ }
  $(me ? "app-view" : "login-view").classList.remove("hidden");
  if (me) {
    $("who-box").classList.remove("hidden");
    $("who").textContent = me.login + (me.is_admin ? "（管理员）" : "");
  }
}

async function loadIndex() {
  if (publishedIndex) return publishedIndex;
  publishedIndex = new Map();
  try {
    const text = await (await fetch(INDEX_URL)).text();
    for (const para of text.split(/\n\n+/)) {
      const f = {};
      for (const line of para.split("\n")) {
        const i = line.indexOf(": ");
        if (i > 0 && !/^\s/.test(line)) f[line.slice(0, i)] = line.slice(i + 2).trim();
      }
      if (!f.Package) continue;
      if (!publishedIndex.has(f.Package)) publishedIndex.set(f.Package, []);
      publishedIndex.get(f.Package).push(f);
    }
  } catch { /* offline preview still works */ }
  return publishedIndex;
}

/* --------------------------------- tabs ---------------------------------- */

$("tab-upload").addEventListener("click", () => switchTab("upload"));
$("tab-mine").addEventListener("click", () => { switchTab("mine"); renderMine(); });

function switchTab(which) {
  $("tab-upload").classList.toggle("active", which === "upload");
  $("tab-mine").classList.toggle("active", which === "mine");
  $("upload-panel").classList.toggle("hidden", which !== "upload");
  $("mine-panel").classList.toggle("hidden", which !== "mine");
}

/* ------------------------------ file picking ----------------------------- */

const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("hover");
  pick(e.dataTransfer.files[0]);
});
$("file").addEventListener("change", (e) => pick(e.target.files[0]));

async function pick(f) {
  if (!f) return;
  if (!f.name.endsWith(".deb")) return say("err", "请选择 .deb 文件");
  file = f;
  parsed = null;
  say("", "本地解析中…");
  $("preview-box").classList.add("hidden");
  try {
    const buf = await f.arrayBuffer();
    parsed = await parseDeb(buf, decompressors);
  } catch (err) {
    return say("err", `解析失败：${err.message}`);
  }
  say("", "");
  await renderPreview();
}

/* -------------------------------- preview -------------------------------- */

async function renderPreview() {
  const c = parsed.control;
  $("drop-text").innerHTML = `已选择 <b>${file.name}</b>（${(file.size / 1048576).toFixed(1)} MB）— 点击可更换`;
  $("p-name").textContent = (parsed.desktop && parsed.desktop.Name) || c.Package || "?";
  $("p-pkg").textContent = c.Package || "";
  $("p-version").textContent = c.Version || "?";
  $("p-arch").textContent = c.Architecture || "?";
  $("p-size").textContent = `${(parsed.totalInstalledSize / 1048576).toFixed(1)} MB`;
  $("p-maint").textContent = c.Maintainer || "（缺失）";

  if (parsed.icon && parsed.icon.isPng) {
    const url = URL.createObjectURL(new Blob([parsed.icon.bytes], { type: "image/png" }));
    $("p-icon").src = url;
    $("p-icon").classList.remove("hidden");
    $("p-noicon").classList.add("hidden");
  } else {
    $("p-icon").classList.add("hidden");
    $("p-noicon").classList.remove("hidden");
  }

  // 邮箱归属预检
  const email = (parsed.email || "").toLowerCase();
  const mine = me && me.emails.includes(email);
  $("p-emailmatch").innerHTML = mine
    ? `<span class="lv-pass">Maintainer 邮箱与你的 GitHub 已验证邮箱匹配</span>`
    : `<span class="lv-danger">Maintainer 邮箱 (${email || "缺失"}) 不在你的 GitHub 已验证邮箱里 — 提交会被拒绝${me && me.is_admin ? "（你是管理员，可豁免）" : ""}</span>`;

  // 版本 / 包名占用预检
  const idx = await loadIndex();
  const entries = idx.get(c.Package) || [];
  let verState = "", verOk = true;
  if (!entries.length) {
    verState = `<span class="lv-pass">新包名，首次提交后归属于你</span>`;
  } else {
    const owner = extractEmail(entries[0].Maintainer || "").toLowerCase();
    const owned = me && (me.emails.includes(owner) || me.is_admin);
    const latest = entries.map((e) => e.Version).sort(compareDebVersions).pop();
    if (!owned) {
      verOk = false;
      verState = `<span class="lv-danger">包名已被他人占用（Maintainer: ${owner.slice(0, 2)}***），无法提交</span>`;
    } else if (compareDebVersions(c.Version, latest) <= 0) {
      verOk = false;
      verState = `<span class="lv-danger">版本 ${c.Version} 不高于线上已发布的 ${latest}，请提升版本号</span>`;
    } else {
      verState = `<span class="lv-pass">已发布 ${latest} → 本次更新为 ${c.Version}</span>`;
    }
  }
  $("p-verstate").innerHTML = verState;

  // 检查报告
  const ul = $("report-list");
  ul.innerHTML = "";
  for (const [level, msg] of parsed.report) {
    const li = document.createElement("li");
    li.className = `lv-${level}`;
    li.textContent = msg;
    ul.appendChild(li);
  }

  // 文件清单 + 脚本
  $("p-filecount").textContent = parsed.files.length;
  $("p-files").textContent = parsed.files
    .filter((f) => f.type !== "dir")
    .map((f) => `${(f.mode & 0o7777).toString(8).padStart(4, "0")}  ${String(f.size).padStart(9)}  ${f.path}${f.linkname ? " -> " + f.linkname : ""}`)
    .join("\n");
  const scriptNames = Object.keys(parsed.scripts);
  if (scriptNames.length) {
    $("p-scripts-box").classList.remove("hidden");
    $("p-scripts").textContent = scriptNames.map((n) => `### ${n}\n${parsed.scripts[n]}`).join("\n\n");
  } else {
    $("p-scripts-box").classList.add("hidden");
  }

  const blocked = parsed.verdict === "danger" || (!mine && !(me && me.is_admin)) || !verOk;
  $("submit-btn").disabled = blocked;
  $("submit-btn").textContent = blocked ? "存在阻断性问题，无法提交" : "提交到 AppStore";
  $("preview-box").classList.remove("hidden");
}

/* --------------------------------- submit -------------------------------- */

$("submit-btn").addEventListener("click", async () => {
  if (!file || !parsed) return;
  $("submit-btn").disabled = true;
  say("", "上传中…");

  const body = new FormData();
  body.append("deb", file);
  body.append("package", parsed.control.Package);
  body.append("version", parsed.control.Version);
  body.append("arch", parsed.control.Architecture);
  const repo = $("source-repo").value.trim();
  if (repo) body.append("source_repo", repo);

  try {
    const r = await fetch("/api/submit", { method: "POST", body });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
    say("ok",
      `✓ ${data.message}\n审核进度：${data.actions_url}\n发布 PR：${data.track_url}`);
  } catch (err) {
    say("err", `提交失败：${err.message}`);
    $("submit-btn").disabled = false;
  }
});

/* ------------------------------ my packages ------------------------------ */

async function renderMine() {
  const rows = $("mine-rows");
  const idx = await loadIndex();
  const mine = [];
  for (const [name, entries] of idx) {
    for (const e of entries) {
      const email = extractEmail(e.Maintainer || "").toLowerCase();
      if (me.emails.includes(email) || me.is_admin) mine.push({ name, ...e, email });
    }
  }
  if (!mine.length) {
    rows.innerHTML = `<tr><td colspan="4" class="muted">没有找到属于你的已发布软件包</td></tr>`;
    return;
  }
  rows.innerHTML = "";
  for (const p of mine.sort((a, b) => a.name.localeCompare(b.name) || compareDebVersions(a.Version, b.Version))) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.name}</td><td>${p.Version}</td><td>${p.email}</td><td class="row-actions"></td>`;
    const actions = tr.lastElementChild;
    const dl = debDownloadUrl(p);
    if (dl) {
      const a = document.createElement("a");
      a.className = "dl-btn";
      a.textContent = "下载 .deb";
      a.href = dl;
      // Hint the browser to save instead of navigate; the canonical
      // pkg_version_arch.deb name also survives cross-origin redirects.
      a.download = `${p.name}_${p.Version}_${p.Architecture || "arm64"}.deb`;
      a.title = `${p.name} ${p.Version}（${p.Size ? (p.Size / 1048576).toFixed(1) + " MB" : "大小未知"}）`;
      actions.appendChild(a);
    }
    const btn = document.createElement("button");
    btn.textContent = "下架";
    btn.addEventListener("click", () => unpublish(p, btn));
    actions.appendChild(btn);
    rows.appendChild(tr);
  }
}

/** Resolve the .deb download URL from the APT index entry (Filename field). */
function debDownloadUrl(entry) {
  const filename = (entry.Filename || "").trim();
  if (!filename) return null;
  // Absolute URL (this repo publishes pool files on GitHub Releases) or a
  // conventional pool path relative to the APT repository root.
  if (/^https?:\/\//.test(filename)) return filename;
  return new URL(filename, INDEX_URL.replace(/dists\/.*$/, "")).toString();
}

async function unpublish(p, btn) {
  if (!confirm(`确认下架 ${p.name} ${p.Version}？将生成移除 PR。`)) return;
  btn.disabled = true;
  try {
    const r = await fetch("/api/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: p.name, version: p.Version }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error);
    btn.textContent = "已提交";
  } catch (err) {
    alert(`下架失败：${err.message}`);
    btn.disabled = false;
  }
}

function say(kind, text) {
  const el = $("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

init();
