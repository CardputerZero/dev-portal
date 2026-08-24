/* CardputerZero developer portal front-end. Same-origin API (see worker/). */

import { parseDeb, compareDebVersions, extractEmail, loginFromNoreply, installPathPrompt } from "/debparse.js";

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
// The live store registry — used to prefill the form when updating a published
// package and to warn about share-code collisions before submitting.
const REGISTRY_URL = "https://cardputer.cc/generated/registry.json";

// Canonical category enum (CP0_dev.md). Shown untranslated: these exact
// strings are what the device store displays and what CI validates.
const CATEGORIES = [
  "System Tools", "Development", "Hardware & IoT", "Security",
  "Radio & Comms", "AI", "Creative & Office", "Media", "Games",
  "Emulators", "Education", "Lifestyle", "Other",
];
// The seven declared permission keys, in display order.
const PERMISSIONS = [
  "camera", "microphone", "imu", "network",
  "additional_hardware", "background_service", "external_display",
];

// The upload is a three-step handshake (see worker/): /api/submit/prepare
// mints a signed ticket, the ticket authorizes streaming the bytes to
// /api/submit/deb, and /api/submit/finalize attaches the store assets.
const TICKET_HEADER = "x-cz-upload-ticket";

const $ = (id) => document.getElementById(id);
let me = null;
let parsed = null;
let file = null;
// The Worker streams the .deb straight through to GitHub and never sees it as
// one buffer, so the digest is computed here, where the bytes already are.
let debSha256 = "";
// Server-advertised upload cap; 0 until /api/config answers, in which case the
// pre-flight request reports an oversized file instead.
let maxSizeMb = 0;
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
  // Permission chip labels are built dynamically; retranslate without
  // touching the checked state.
  document.querySelectorAll("#s-perms label").forEach((label) => {
    label.lastChild.textContent = t(`form.perm.${label.dataset.perm}`);
  });
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
  // Fetch the session, the upload limit and the locale strings in parallel.
  const meP = fetch("/api/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const configP = fetch("/api/config").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  dict = await loadLocale(locale);
  applyStaticI18n();
  buildStoreChoices();

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
  const config = await configP;
  if (config && config.max_size_mb) maxSizeMb = config.max_size_mb;
  $("boot-view").classList.add("hidden");
  $(me ? "app-view" : "login-view").classList.remove("hidden");
  if (me) {
    $("who-box").classList.remove("hidden");
    $("who").textContent = me.login + (me.is_admin ? t("header.admin") : "");
    // Honor the tab encoded in the URL hash so a refresh stays put.
    applyRoute();
  }
}

// The index/owners caches expire quickly (and are dropped entirely after a
// successful submit) so "My packages" reflects a fresh publish without a full
// page reload; the ?t= cache-buster defeats stale CDN/browser copies.
const INDEX_TTL_MS = 30 * 1000;
let indexFetchedAt = 0;
let ownersCache = null;

function invalidateIndexCache() {
  publishedIndex = null;
  ownersCache = null;
  indexFetchedAt = 0;
}

async function loadIndex() {
  if (publishedIndex && Date.now() - indexFetchedAt < INDEX_TTL_MS) return publishedIndex;
  publishedIndex = new Map();
  indexFetchedAt = Date.now();
  try {
    const text = await (await fetch(`${INDEX_URL}?t=${Date.now()}`)).text();
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

/**
 * Authoritative ownership map published alongside the APT index:
 * { "<package>": { "<version>": "<github login, lowercase>" } }, aggregated
 * from the release manifests' `uploaded_by`. Legacy packages predating the
 * ownership record are absent — callers fall back to loginFromNoreply.
 */
async function loadOwners() {
  if (ownersCache && Date.now() - indexFetchedAt < INDEX_TTL_MS) return ownersCache;
  ownersCache = {};
  try {
    const url = INDEX_URL.replace(/dists\/.*$/, "owners.json");
    const r = await fetch(`${url}?t=${Date.now()}`);
    if (r.ok) ownersCache = await r.json();
  } catch { /* fall back to Maintainer-derived ownership */ }
  return ownersCache;
}

/** Owner login of a published package: owners.json first, noreply fallback. */
function packageOwner(owners, pkg, entries) {
  const versions = owners && owners[pkg];
  if (versions) {
    for (const v of Object.keys(versions)) {
      const login = String(versions[v] || "").toLowerCase();
      if (login) return login;
    }
  }
  return loginFromNoreply((entries && entries[0] && entries[0].Maintainer) || "");
}

/** Recent publish PRs of mine (open = under review, merged = index rebuilding). */
async function loadMySubmissions() {
  try {
    const r = await fetch("/api/my-submissions");
    if (r.ok) return await r.json();
  } catch { /* portal API unreachable — published list still renders */ }
  return [];
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
  if (maxSizeMb && f.size > maxSizeMb * 1048576) {
    return say("err", t("upload.tooLarge", { size: (f.size / 1048576).toFixed(1), max: maxSizeMb }));
  }
  file = f;
  parsed = null;
  debSha256 = "";
  say("", t("upload.localParsing"));
  $("preview-box").classList.add("hidden");
  resetStoreForm();
  try {
    const buf = await f.arrayBuffer();
    debSha256 = hex(await crypto.subtle.digest("SHA-256", buf));
    parsed = await parseDeb(buf, decompressors);
  } catch (err) {
    return say("err", t("upload.parseFailed", { msg: err.message }));
  }
  say("", "");
  await renderPreview();
}

/* -------------------------------- preview -------------------------------- */

// The deb's own Maintainer field is what dpkg-scanpackages publishes into the
// APT index. When "hide my email" is checked (default) we mask the address in
// the preview so the developer isn't surprised to see it; the published record
// (release manifest) is separately kept to a noreply form by the Worker.
function maintainerDisplay(maintainer) {
  const m = (maintainer || "").trim();
  if (!m) return t("preview.maintainerMissing");
  if (!$("hide-email").checked) return m;
  const name = m.split("<")[0].trim();
  const masked = t("preview.emailHiddenTag");
  return name ? `${name} ${masked}` : masked;
}

// Re-mask the preview when the checkbox is toggled (only meaningful once a deb
// has been parsed).
$("hide-email").addEventListener("change", () => {
  if (parsed && file) $("p-maint").textContent = maintainerDisplay(parsed.control.Maintainer);
});

$("p-pathhelp-copy").addEventListener("click", async (e) => {
  try {
    await navigator.clipboard.writeText($("p-pathhelp-prompt").textContent);
    e.target.textContent = t("pathHelp.copied");
    setTimeout(() => { e.target.textContent = t("pathHelp.copy"); }, 1500);
  } catch {
    // Denied clipboard permission or an insecure origin: the prompt is on the
    // page anyway, so just let the developer select it.
    e.target.textContent = t("pathHelp.copyFailed");
  }
});

async function renderPreview() {
  const c = parsed.control;
  $("drop-text").innerHTML = t("upload.chosen", { name: file.name, size: (file.size / 1048576).toFixed(1) });
  $("p-name").textContent = (parsed.desktop && parsed.desktop.Name) || c.Package || "?";
  $("p-pkg").textContent = c.Package || "";
  $("p-version").textContent = c.Version || "?";
  $("p-arch").textContent = c.Architecture || "?";
  $("p-size").textContent = `${(parsed.totalInstalledSize / 1048576).toFixed(1)} MB`;
  $("p-maint").textContent = maintainerDisplay(c.Maintainer);

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
  const [idx, owners] = await Promise.all([loadIndex(), loadOwners()]);
  const entries = idx.get(c.Package) || [];
  let verState = "", verOk = true, ownedUpdate = false;
  if (!entries.length) {
    verState = `<span class="lv-pass">${me ? t("preview.newPkg", { login: me.login }) : t("preview.newPkgAnon")}</span>`;
  } else {
    // owners.json 是发布侧聚合的权威归属（uploaded_by）；老包缺记录时退回
    // 从 noreply Maintainer 反推。服务端会按 uploaded_by 权威复核。
    const ownerLogin = packageOwner(owners, c.Package, entries);
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
      ownedUpdate = true;
    }
  }
  $("p-verstate").innerHTML = verState;

  // Updating an owned, published package: start the form from the current
  // store page (fields + screenshots + icon) instead of a blank slate.
  if (ownedUpdate && !storeShots.length && !$("s-title").value) {
    prefillStore(c.Package).catch(() => { /* registry unreachable */ });
  }

  // 检查报告
  const ul = $("report-list");
  ul.innerHTML = "";
  for (const [level, msg] of parsed.report) {
    const li = document.createElement("li");
    li.className = `lv-${level}`;
    li.textContent = msg;
    ul.appendChild(li);
  }

  // Path problems block the upload, so the fix has to be available right here —
  // the same prompt the packages repo puts in its failure issue.
  const pathHelp = $("p-pathhelp-box");
  if (parsed.badPaths.length) {
    $("p-pathhelp-prompt").textContent = installPathPrompt(c.Package, parsed.badPaths);
    pathHelp.classList.remove("hidden");
  } else {
    pathHelp.classList.add("hidden");
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

let storeIcon = null;     // Blob | null — icon override (square PNG)
const storeShots = [];    // [{ blob, url }] — 320×170 PNG screenshots
let registryCache = null; // parsed registry.json, for prefill + code checks
let prefilledIcon = false; // true when the shown icon came from the registry

async function loadRegistry() {
  if (registryCache) return registryCache;
  try {
    const r = await fetch(`${REGISTRY_URL}?t=${Date.now()}`);
    if (r.ok) registryCache = await r.json();
  } catch { /* registry unreachable — prefill and code checks degrade */ }
  return registryCache;
}

// Build the category chips and permission toggles once at startup. Category
// selection is capped at 2 by disabling the rest, matching the store policy.
function buildStoreChoices() {
  const cats = $("s-cats");
  cats.innerHTML = "";
  for (const c of CATEGORIES) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = c;
    input.addEventListener("change", enforceCategoryLimit);
    label.appendChild(input);
    label.appendChild(document.createTextNode(c));
    cats.appendChild(label);
  }
  const perms = $("s-perms");
  perms.innerHTML = "";
  for (const p of PERMISSIONS) {
    const label = document.createElement("label");
    label.dataset.perm = p;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = p;
    label.appendChild(input);
    label.appendChild(document.createTextNode(t(`form.perm.${p}`)));
    perms.appendChild(label);
  }
}

function enforceCategoryLimit() {
  const boxes = [...$("s-cats").querySelectorAll("input")];
  const picked = boxes.filter((b) => b.checked).length;
  for (const b of boxes) b.disabled = !b.checked && picked >= 2;
}

function selectedCategories() {
  return [...$("s-cats").querySelectorAll("input:checked")].map((b) => b.value);
}

function selectedPermissions() {
  const out = {};
  for (const p of PERMISSIONS) out[p] = false;
  for (const b of $("s-perms").querySelectorAll("input:checked")) out[b.value] = true;
  return out;
}

// Live share-code feedback against the registry (CI enforces authoritatively).
$("s-code").addEventListener("input", async () => {
  const el = $("s-code");
  el.value = el.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4);
  const state = $("s-code-state");
  if (el.value.length < 4) { state.textContent = ""; return; }
  const reg = await loadRegistry();
  if (!reg || !parsed) return;
  const mine = parsed.control.Package;
  const clash = (reg.apps || []).find((a) => a.download && a.download.package !== mine
    && String(a.share_code || "").toUpperCase() === el.value);
  state.innerHTML = clash
    ? `<span class="lv-danger">${t("form.codeTaken", { pkg: clash.download.package })}</span>`
    : `<span class="lv-pass">${t("form.codeFree")}</span>`;
});

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
  prefilledIcon = false;
  for (const sh of storeShots) URL.revokeObjectURL(sh.url);
  storeShots.length = 0;
  for (const id of ["s-title", "s-summary", "s-desc", "s-author", "s-license", "s-code"]) $(id).value = "";
  $("s-code-state").textContent = "";
  $("s-prefill-note").classList.add("hidden");
  for (const b of $("s-cats").querySelectorAll("input")) { b.checked = false; b.disabled = false; }
  for (const b of $("s-perms").querySelectorAll("input")) b.checked = false;
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
    div.innerHTML = `<img alt="${t("form.shotAlt", { n: i + 1 })}">`
      + `<button type="button" class="del" data-del="${i}">✕</button>`
      + (i > 0 ? `<button type="button" class="mvl" data-mvl="${i}" title="${t("form.moveLeft")}">←</button>` : "")
      + (i < storeShots.length - 1 ? `<button type="button" class="mvr" data-mvr="${i}" title="${t("form.moveRight")}">→</button>` : "");
    div.querySelector("img").src = sh.url;
    box.appendChild(div);
  });
  $("s-shot-btn").disabled = storeShots.length >= 6;
  $("s-shot-btn").textContent = storeShots.length >= 6 ? t("form.shotLimit") : t("form.addShot");
}

$("s-shots").addEventListener("click", (e) => {
  const el = e.target;
  if (!el.getAttribute) return;
  const del = el.getAttribute("data-del");
  if (del !== null) {
    const [removed] = storeShots.splice(Number(del), 1);
    if (removed) URL.revokeObjectURL(removed.url);
    return renderShots();
  }
  const mvl = el.getAttribute("data-mvl");
  const mvr = el.getAttribute("data-mvr");
  const i = mvl !== null ? Number(mvl) : (mvr !== null ? Number(mvr) : null);
  if (i === null) return;
  const j = mvl !== null ? i - 1 : i + 1;
  [storeShots[i], storeShots[j]] = [storeShots[j], storeShots[i]];
  renderShots();
});

/**
 * Prefill the store form from the live registry when the developer is
 * updating their own published package: every field plus the published
 * screenshots and icon (fetched back into editable blobs), so an update
 * starts from the current store page instead of a blank form.
 */
async function prefillStore(pkg) {
  const reg = await loadRegistry();
  const app = reg && (reg.apps || []).find((a) => a.download && a.download.package === pkg);
  if (!app) return;
  $("s-title").value = app.title || "";
  $("s-summary").value = app.summary || "";
  $("s-desc").value = app.description || "";
  $("s-author").value = (app.author && app.author.display_name) || "";
  $("s-license").value = app.license || "";
  $("s-code").value = String(app.share_code || "").toUpperCase();
  if (!$("source-repo").value && app.source_repo) $("source-repo").value = app.source_repo;
  for (const b of $("s-cats").querySelectorAll("input")) {
    b.checked = (app.categories || []).includes(b.value);
  }
  enforceCategoryLimit();
  const perms = app.permissions || {};
  for (const b of $("s-perms").querySelectorAll("input")) b.checked = perms[b.value] === true;

  // Published images, refetched as editable blobs. Failures degrade to an
  // empty slot — the developer can re-add images by hand.
  const fetchBlob = async (url) => {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.blob();
    } catch { /* unreachable asset */ }
    return null;
  };
  for (const url of (app.screenshots || []).slice(0, 6)) {
    if (storeShots.length >= 6) break;
    const blob = await fetchBlob(url);
    if (!blob) continue;
    try {
      // Legacy screenshots may be off-size (e.g. 640×340); normalize them to
      // the policy's 320×170 here so an untouched update passes validation.
      const img = await fileToImage(blob);
      const fixed = (img.naturalWidth === 320 && img.naturalHeight === 170)
        ? blob : await coverToPng(img, 320, 170);
      storeShots.push({ blob: fixed, url: URL.createObjectURL(fixed) });
    } catch { /* unreadable screenshot — skip */ }
  }
  renderShots();
  if (app.icon) {
    const blob = await fetchBlob(app.icon);
    // Only prefill an icon the current policy would accept (square, 128–512);
    // a legacy undersized icon is left out so the developer picks a new one
    // instead of getting rejected by CI for an image they never touched.
    if (blob) {
      try {
        const img = await fileToImage(blob);
        if (img.naturalWidth === img.naturalHeight
            && img.naturalWidth >= 128 && img.naturalWidth <= 512) {
          storeIcon = blob;
          prefilledIcon = true;
          $("s-icon-preview").src = URL.createObjectURL(blob);
          $("s-icon-preview").classList.remove("hidden");
          $("s-icon-clear").classList.remove("hidden");
        }
      } catch { /* unreadable icon — leave the slot empty */ }
    }
  }
  $("s-prefill-note").classList.remove("hidden");
}

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
  prefilledIcon = false;
  $("s-icon-preview").classList.add("hidden");
  $("s-icon-preview").removeAttribute("src");
  $("s-icon-clear").classList.add("hidden");
});
$("s-icon").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    storeIcon = await coverToPng(await fileToImage(f), 256, 256);
    prefilledIcon = false;
    $("s-icon-preview").src = URL.createObjectURL(storeIcon);
    $("s-icon-preview").classList.remove("hidden");
    $("s-icon-clear").classList.remove("hidden");
  } catch (err) { say("err", t("form.iconProcessFailed", { msg: err.message })); }
});

/* --------------------------------- submit -------------------------------- */

// The store policy's required fields, checked here so a rejection costs no
// upload time; CI re-validates authoritatively with the same rules.
function missingStoreFields() {
  const missing = [];
  if (!$("s-title").value.trim()) missing.push(t("form.appName"));
  if (!$("s-summary").value.trim()) missing.push(t("form.summary"));
  if (!selectedCategories().length) missing.push(t("form.categories"));
  if (!$("s-author").value.trim()) missing.push(t("form.authorName"));
  if (!$("s-license").value.trim()) missing.push(t("form.license"));
  if (!/^[A-Za-z0-9]{4}$/.test($("s-code").value.trim())) missing.push(t("form.shareCode"));
  if (!storeShots.length) missing.push(t("form.screenshotsLabel"));
  if (!storeIcon && !(parsed && parsed.icon && parsed.icon.isPng)) missing.push(t("form.iconLabel"));
  return missing;
}

$("submit-btn").addEventListener("click", async () => {
  if (!file || !parsed) return;

  const missing = missingStoreFields();
  if (missing.length) {
    return say("err", t("form.missingRequired", { fields: missing.join("、") }));
  }
  $("submit-btn").disabled = true;

  const repo = $("source-repo").value.trim();
  try {
    // 1. Everything that can be judged without the package itself — ownership,
    //    version bump, size — so a rejection costs no upload time.
    say("", t("upload.checking"));
    let ticket = await postJson("/api/submit/prepare", {
      package: parsed.control.Package,
      version: parsed.control.Version,
      arch: parsed.control.Architecture,
      sha256: debSha256,
      size: file.size,
      source_repo: repo,
    });

    // 2. The bytes, which the Worker forwards to the release as they arrive.
    ticket = await putDeb(ticket, file);

    // 3. Store metadata and the small PNGs, then the publish dispatch. Empty
    //    strings + no images ⇒ the Worker treats the store section as "not
    //    supplied" and falls back to source_repo/deb-derived metadata.
    say("", t("upload.finalizing"));
    const body = new FormData();
    if (repo) body.append("source_repo", repo);
    // Privacy: when checked (default) the Worker records a noreply address;
    // when unchecked it publishes the developer's verified GitHub email.
    body.append("hide_email", $("hide-email").checked ? "true" : "false");
    body.append("title", $("s-title").value.trim());
    body.append("summary", $("s-summary").value.trim());
    body.append("description", $("s-desc").value.trim());
    body.append("categories", selectedCategories().join(","));
    body.append("display_name", $("s-author").value.trim());
    body.append("license", $("s-license").value.trim());
    body.append("share_code", $("s-code").value.trim().toUpperCase());
    body.append("permissions", JSON.stringify(selectedPermissions()));
    if (storeIcon) body.append("icon", storeIcon, "icon.png");
    storeShots.forEach((sh, i) => body.append("screenshots", sh.blob, `shot${i}.png`));

    const r = await fetch("/api/submit/finalize", {
      method: "POST",
      headers: { [TICKET_HEADER]: ticket },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);

    // Drop the cached index/owners so "My packages" immediately shows this
    // submission (as a pending row) instead of a stale snapshot.
    invalidateIndexCache();
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

async function postJson(path, obj) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
  return data.ticket;
}

/**
 * Send the .deb and report progress while it goes. This is the one request
 * that uses XMLHttpRequest: fetch() cannot report upload progress, and a
 * package this size takes long enough that a silent wait looks like a hang.
 * Resolves with the ticket extended to reference the stored asset.
 */
function putDeb(ticket, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/submit/deb");
    xhr.setRequestHeader(TICKET_HEADER, ticket);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    const total = (blob.size / 1048576).toFixed(1);
    say("", t("upload.uploading"));
    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      say("", t("upload.progress", {
        percent: Math.floor((e.loaded / e.total) * 100),
        done: (e.loaded / 1048576).toFixed(1),
        total,
      }));
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 200 && data.ticket) resolve(data.ticket);
      else reject(new Error(data.detail || data.error || `HTTP ${xhr.status}`));
    });
    xhr.addEventListener("error", () => reject(new Error(t("upload.networkFailed"))));
    xhr.addEventListener("abort", () => reject(new Error(t("upload.aborted"))));
    xhr.send(blob);
  });
}

/* ------------------------------ my packages ------------------------------ */

async function renderMine() {
  if (!me) return;
  const rows = $("mine-rows");
  // Show a spinner while the (possibly slow) APT index fetch is in flight, so
  // an empty table never looks like a broken page.
  rows.innerHTML = `<tr><td colspan="4"><div class="loading"><span class="spinner"></span>${t("mine.loading")}</div></td></tr>`;
  const [idx, owners, submissions] = await Promise.all([loadIndex(), loadOwners(), loadMySubmissions()]);

  const mine = [];
  for (const [name, entries] of idx) {
    // Ownership is per-package (first-come): resolve once from owners.json,
    // falling back to a noreply Maintainer for legacy packages.
    const ownerLogin = packageOwner(owners, name, entries);
    if (!(me.is_admin || (ownerLogin && ownerLogin === me.login.toLowerCase()))) continue;
    for (const e of entries) {
      mine.push({ name, ...e, owner: ownerLogin, email: extractEmail(e.Maintainer || "").toLowerCase() });
    }
  }

  // Submissions not yet in the published index: open PR = under review;
  // merged PR = published but the index/CDN is still rebuilding (~minutes).
  const pending = submissions.filter((sub) => {
    if (sub.state !== "open" && sub.state !== "merged") return false;
    return !(idx.get(sub.package) || []).some((e) => e.Version === sub.version);
  });

  if (!mine.length && !pending.length) {
    rows.innerHTML = `<tr><td colspan="4" class="muted">${t("mine.empty")}</td></tr>`;
    return;
  }
  rows.innerHTML = "";
  for (const sub of pending) {
    const tr = document.createElement("tr");
    const status = sub.state === "open" ? t("mine.statusReview") : t("mine.statusPublishing");
    tr.innerHTML = `<td>${sub.package}</td><td>${sub.version}</td><td>@${sub.submitter}</td><td class="row-actions"></td>`;
    const actions = tr.lastElementChild;
    const badge = document.createElement("span");
    badge.className = "muted";
    badge.textContent = status;
    actions.appendChild(badge);
    const a = document.createElement("a");
    a.className = "dl-btn";
    a.textContent = t("mine.viewPr");
    a.href = sub.url;
    a.target = "_blank";
    a.rel = "noopener";
    actions.appendChild(a);
    rows.appendChild(tr);
  }
  for (const p of mine.sort((a, b) => a.name.localeCompare(b.name) || compareDebVersions(a.Version, b.Version))) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.name}</td><td>${p.Version}</td><td>${p.owner ? "@" + p.owner : p.email}</td><td class="row-actions"></td>`;
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

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

init();
