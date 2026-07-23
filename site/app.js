/* CardputerZero developer portal front-end. Same-origin API (see worker/). */

import { parseDeb, compareDebVersions, extractEmail, loginFromNoreply } from "/debparse.js";

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

/* ---------------------------------- i18n --------------------------------- */
// Mirrors the main cardputer.cc site: zh-CN / en / ja, choice persists in
// localStorage, falls back to the browser language then zh-CN.
const SUPPORTED_LOCALES = ["zh-CN", "en", "ja"];
const LOCALE_KEY = "dev.locale";
const I18N_TS = Date.now(); // cache-buster for the locale JSON on each load
let dict = {};
let locale = resolveInitialLocale();

function resolveInitialLocale() {
  const stored = localStorage.getItem(LOCALE_KEY);
  if (SUPPORTED_LOCALES.includes(stored)) return stored;
  const b = navigator.language || "";
  if (SUPPORTED_LOCALES.includes(b)) return b;
  if (b.startsWith("zh")) return "zh-CN";
  if (b.startsWith("ja")) return "ja";
  if (b.startsWith("en")) return "en";
  return "zh-CN";
}

async function loadLocale(loc) {
  try {
    const r = await fetch(`/i18n/${loc}.json?t=${I18N_TS}`);
    if (r.ok) return await r.json();
  } catch { /* fall through to zh-CN */ }
  if (loc !== "zh-CN") {
    try { return await (await fetch(`/i18n/zh-CN.json?t=${I18N_TS}`)).json(); } catch { /* offline */ }
  }
  return {};
}

// t("a.b", {name}) -> string with {name} interpolated; missing keys echo back.
function t(key, params = {}) {
  let v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), dict);
  if (typeof v !== "string") v = key;
  return Object.entries(params).reduce((s, [k, val]) => s.replaceAll(`{${k}}`, val), v);
}

function applyStaticI18n() {
  document.documentElement.lang = locale;
  document.title = t("meta.title");
  document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((n) => { n.innerHTML = t(n.dataset.i18nHtml); });
  document.querySelectorAll("[data-i18n-ph]").forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((n) => { n.setAttribute("aria-label", t(n.dataset.i18nAria)); });
  const sel = $("locale-select");
  if (sel) sel.value = locale;
}

// Re-apply everything after a language switch (static chrome + dynamic views).
function relocalize() {
  applyStaticI18n();
  if (me) $("who").textContent = me.login + (me.is_admin ? t("header.admin") : "");
  if (parsed && file) renderPreview();
  if (!$("mine-panel").classList.contains("hidden")) renderMine();
}

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
    throw new Error(t("decompress.loadFailed", { what }));
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
  // Fetch the session and the locale strings in parallel.
  const meP = fetch("/api/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  dict = await loadLocale(locale);
  applyStaticI18n();

  const sel = $("locale-select");
  if (sel) {
    sel.value = locale;
    sel.addEventListener("change", async (e) => {
      locale = e.target.value;
      localStorage.setItem(LOCALE_KEY, locale);
      dict = await loadLocale(locale);
      relocalize();
    });
  }

  me = await meP;
  $("boot-view").classList.add("hidden");
  $(me ? "app-view" : "login-view").classList.remove("hidden");
  if (me) {
    $("who-box").classList.remove("hidden");
    $("who").textContent = me.login + (me.is_admin ? t("header.admin") : "");
    // Honor the tab encoded in the URL hash so a refresh stays put.
    applyRoute();
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
// Each tab is a distinct URL hash (#/upload, #/mine) so a page refresh keeps
// the user on the same tab and the browser back/forward buttons work.

function tabFromHash() {
  return /^#\/?mine\b/.test(location.hash || "") ? "mine" : "upload";
}

// Reflect the current URL hash into the visible tab (no history change).
function applyRoute() {
  showTab(tabFromHash());
}

// Update the visible panels/buttons for a tab, without touching the URL.
function showTab(which) {
  $("tab-upload").classList.toggle("active", which === "upload");
  $("tab-mine").classList.toggle("active", which === "mine");
  $("upload-panel").classList.toggle("hidden", which !== "upload");
  $("mine-panel").classList.toggle("hidden", which !== "mine");
  if (which === "mine") renderMine();
}

// Clicking a tab navigates by hash; the hashchange handler does the rendering.
// (If the hash is already correct, hashchange won't fire, so render directly.)
function switchTab(which) {
  const hash = which === "mine" ? "#/mine" : "#/upload";
  if (location.hash === hash) showTab(which);
  else location.hash = hash;
}

$("tab-upload").addEventListener("click", () => switchTab("upload"));
$("tab-mine").addEventListener("click", () => switchTab("mine"));
window.addEventListener("hashchange", applyRoute);

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
  if (!f.name.endsWith(".deb")) return say("err", t("upload.pickDeb"));
  file = f;
  parsed = null;
  say("", t("upload.localParsing"));
  $("preview-box").classList.add("hidden");
  resetStoreForm();
  try {
    const buf = await f.arrayBuffer();
    parsed = await parseDeb(buf, decompressors);
  } catch (err) {
    return say("err", t("upload.parseFailed", { msg: err.message }));
  }
  say("", "");
  await renderPreview();
}

/* -------------------------------- preview -------------------------------- */

async function renderPreview() {
  const c = parsed.control;
  $("drop-text").innerHTML = t("upload.chosen", { name: file.name, size: (file.size / 1048576).toFixed(1) });
  $("p-name").textContent = (parsed.desktop && parsed.desktop.Name) || c.Package || "?";
  $("p-pkg").textContent = c.Package || "";
  $("p-version").textContent = c.Version || "?";
  $("p-arch").textContent = c.Architecture || "?";
  $("p-size").textContent = `${(parsed.totalInstalledSize / 1048576).toFixed(1)} MB`;
  $("p-maint").textContent = c.Maintainer || t("preview.maintainerMissing");

  $("s-title").placeholder = (parsed.desktop && parsed.desktop.Name) || c.Package || t("preview.titlePlaceholder");

  if (parsed.icon && parsed.icon.isPng) {
    const url = URL.createObjectURL(new Blob([parsed.icon.bytes], { type: "image/png" }));
    $("p-icon").src = url;
    $("p-icon").classList.remove("hidden");
    $("p-noicon").classList.add("hidden");
  } else {
    $("p-icon").classList.add("hidden");
    $("p-noicon").classList.remove("hidden");
  }

  // 上传者归属（包名先到先得，以 GitHub 账号为准，与 deb 里的 Maintainer 邮箱无关）
  $("p-emailmatch").innerHTML = me
    ? `<span class="lv-pass">${t("preview.uploaderAs", { login: me.login })}</span>`
    : `<span class="lv-danger">${t("preview.needLogin")}</span>`;

  // 版本 / 包名占用预检（所有权按上传者 GitHub 账号先到先得）
  const idx = await loadIndex();
  const entries = idx.get(c.Package) || [];
  let verState = "", verOk = true;
  if (!entries.length) {
    verState = `<span class="lv-pass">${me ? t("preview.newPkg", { login: me.login }) : t("preview.newPkgAnon")}</span>`;
  } else {
    // 前端只能读到线上索引里的 Maintainer，尽力从 noreply 地址反推 owner；
    // 服务端会按记录的 uploaded_by 权威复核。
    const ownerLogin = loginFromNoreply(entries[0].Maintainer || "");
    const owned = me && (me.is_admin || (ownerLogin && ownerLogin === me.login.toLowerCase()));
    const latest = entries.map((e) => e.Version).sort(compareDebVersions).pop();
    if (ownerLogin && !owned) {
      verOk = false;
      verState = `<span class="lv-danger">${t("preview.ownedBy", { login: ownerLogin })}</span>`;
    } else if (compareDebVersions(c.Version, latest) <= 0) {
      verOk = false;
      verState = `<span class="lv-danger">${t("preview.versionTooLow", { version: c.Version, latest })}</span>`;
    } else {
      verState = `<span class="lv-pass">${t("preview.versionUpdate", { latest, version: c.Version })}</span>`;
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
  $("p-files-summary").textContent = t("preview.filesSummary", { count: parsed.files.length });
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

  const blocked = parsed.verdict === "danger" || !me || !verOk;
  $("submit-btn").disabled = blocked;
  $("submit-btn").textContent = blocked ? t("preview.blocked") : t("preview.submit");
  $("preview-box").classList.remove("hidden");
}

/* ---------------------------- store metadata form ------------------------ */

let storeIcon = null;     // Blob | null — optional icon override (square PNG)
const storeShots = [];    // [{ blob, url }] — 320×170 PNG screenshots

// Draw an image into a w×h canvas using "cover" fit (scale to fill, then
// center-crop) and return a PNG blob. This is how the browser turns an
// arbitrary user image into an exact 320×170 screenshot or a square icon.
function coverToPng(img, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function fileToImage(f) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("form.imageUnreadable"))); };
    img.src = url;
  });
}

function resetStoreForm() {
  storeIcon = null;
  for (const sh of storeShots) URL.revokeObjectURL(sh.url);
  storeShots.length = 0;
  for (const id of ["s-title", "s-summary", "s-desc", "s-cats"]) $(id).value = "";
  $("s-icon-preview").classList.add("hidden");
  $("s-icon-preview").removeAttribute("src");
  $("s-icon-clear").classList.add("hidden");
  renderShots();
}

function renderShots() {
  const box = $("s-shots");
  box.innerHTML = "";
  storeShots.forEach((sh, i) => {
    const div = document.createElement("div");
    div.className = "shot";
    div.innerHTML = `<img alt="${t("form.shotAlt", { n: i + 1 })}"><button type="button" data-i="${i}">✕</button>`;
    div.querySelector("img").src = sh.url;
    box.appendChild(div);
  });
  $("s-shot-btn").disabled = storeShots.length >= 6;
  $("s-shot-btn").textContent = storeShots.length >= 6 ? t("form.shotLimit") : t("form.addShot");
}

$("s-shots").addEventListener("click", (e) => {
  const i = e.target.getAttribute && e.target.getAttribute("data-i");
  if (i === null || i === undefined) return;
  const [removed] = storeShots.splice(Number(i), 1);
  if (removed) URL.revokeObjectURL(removed.url);
  renderShots();
});

$("s-shot-btn").addEventListener("click", () => $("s-shot-file").click());
$("s-shot-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || storeShots.length >= 6) return;
  try {
    const blob = await coverToPng(await fileToImage(f), 320, 170);
    storeShots.push({ blob, url: URL.createObjectURL(blob) });
    renderShots();
  } catch (err) { say("err", t("form.shotProcessFailed", { msg: err.message })); }
});

$("s-icon-btn").addEventListener("click", () => $("s-icon").click());
$("s-icon-clear").addEventListener("click", () => {
  storeIcon = null;
  $("s-icon-preview").classList.add("hidden");
  $("s-icon-preview").removeAttribute("src");
  $("s-icon-clear").classList.add("hidden");
});
$("s-icon").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    storeIcon = await coverToPng(await fileToImage(f), 128, 128);
    $("s-icon-preview").src = URL.createObjectURL(storeIcon);
    $("s-icon-preview").classList.remove("hidden");
    $("s-icon-clear").classList.remove("hidden");
  } catch (err) { say("err", t("form.iconProcessFailed", { msg: err.message })); }
});

/* --------------------------------- submit -------------------------------- */

$("submit-btn").addEventListener("click", async () => {
  if (!file || !parsed) return;
  $("submit-btn").disabled = true;
  say("", t("upload.uploading"));

  const body = new FormData();
  body.append("deb", file);
  body.append("package", parsed.control.Package);
  body.append("version", parsed.control.Version);
  body.append("arch", parsed.control.Architecture);
  const repo = $("source-repo").value.trim();
  if (repo) body.append("source_repo", repo);

  // Optional store metadata (empty strings + no images ⇒ Worker treats it as
  // "not supplied" and falls back to source_repo/deb-derived metadata).
  body.append("title", $("s-title").value.trim());
  body.append("summary", $("s-summary").value.trim());
  body.append("description", $("s-desc").value.trim());
  body.append("categories", $("s-cats").value.trim());
  if (storeIcon) body.append("icon", storeIcon, "icon.png");
  storeShots.forEach((sh, i) => body.append("screenshots", sh.blob, `shot${i}.png`));

  try {
    const r = await fetch("/api/submit", { method: "POST", body });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
    say("ok", t("upload.submitOk", {
      message: data.message,
      actions: data.actions_url,
      track: data.track_url,
    }));
  } catch (err) {
    say("err", t("upload.submitFailed", { msg: err.message }));
    $("submit-btn").disabled = false;
  }
});

/* ------------------------------ my packages ------------------------------ */

async function renderMine() {
  if (!me) return;
  const rows = $("mine-rows");
  // Show a spinner while the (possibly slow) APT index fetch is in flight, so
  // an empty table never looks like a broken page.
  rows.innerHTML = `<tr><td colspan="4"><div class="loading"><span class="spinner"></span>${t("mine.loading")}</div></td></tr>`;
  const idx = await loadIndex();
  const mine = [];
  for (const [name, entries] of idx) {
    for (const e of entries) {
      const ownerLogin = loginFromNoreply(e.Maintainer || "");
      if (me.is_admin || (ownerLogin && ownerLogin === me.login.toLowerCase())) {
        mine.push({ name, ...e, email: extractEmail(e.Maintainer || "").toLowerCase() });
      }
    }
  }
  if (!mine.length) {
    rows.innerHTML = `<tr><td colspan="4" class="muted">${t("mine.empty")}</td></tr>`;
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
      a.textContent = t("mine.download");
      a.href = dl;
      // Hint the browser to save instead of navigate; the canonical
      // pkg_version_arch.deb name also survives cross-origin redirects.
      a.download = `${p.name}_${p.Version}_${p.Architecture || "arm64"}.deb`;
      a.title = `${p.name} ${p.Version}（${p.Size ? (p.Size / 1048576).toFixed(1) + " MB" : t("mine.sizeUnknown")}）`;
      actions.appendChild(a);
    }
    const btn = document.createElement("button");
    btn.textContent = t("mine.unpublish");
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
  if (!confirm(t("mine.confirmUnpublish", { name: p.name, version: p.Version }))) return;
  btn.disabled = true;
  try {
    const r = await fetch("/api/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: p.name, version: p.Version }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error);
    btn.textContent = t("mine.submitted");
  } catch (err) {
    alert(t("mine.unpublishFailed", { msg: err.message }));
    btn.disabled = false;
  }
}

function say(kind, text) {
  const el = $("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

init();
