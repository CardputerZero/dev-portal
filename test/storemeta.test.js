/**
 * Store metadata policy. packages-workflows/store_meta_policy.py is the single
 * authoritative implementation, called by both submission channels' CI and by
 * czdev's local pre-check; these cases pin what it accepts and how it phrases
 * a rejection, so a change over in the packages repo shows up here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../packages-workflows/store_meta_policy.py", import.meta.url).pathname;

/** A minimal PNG whose IHDR reports w×h — all the policy reads is the header. */
function fakePng(w, h) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);                    // IHDR length
  buf.write("IHDR", 12);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function goodMeta() {
  return {
    title: "Font Preview",
    summary: "Preview installed fonts on the device.",
    description: "Browse and preview every installed font.",
    locales: { "zh-CN": { title: "字体预览" } },
    categories: ["System Tools"],
    screenshots: ["screenshots/main.png"],
    icon: "icon.png",
    author: { github: "someone", display_name: "Someone" },
    license: "MIT",
    source_repo: "https://github.com/someone/fontpreview",
    share_code: "FONT",
    permissions: {
      camera: false, microphone: false, imu: false, network: false,
      additional_hardware: false, background_service: false, external_display: false,
    },
  };
}

/**
 * Materializes a pool/main/-shaped tree, runs the policy for `pkg`, and
 * returns { errors, warnings, help } (each "" when the file wasn't written).
 * `packages` maps pkg name -> meta object (goodMeta-shaped); PNG files are
 * generated to match unless `broken` names paths to corrupt or drop.
 */
function runPolicy(pkg, packages, { skipPool = false, broken = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "storemeta-"));
  const pool = join(root, "pool");
  for (const [name, meta] of Object.entries(packages)) {
    const dir = join(pool, name);
    mkdirSync(join(dir, "screenshots"), { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    if (typeof meta.icon === "string" && !meta.icon.includes("/")) {
      writeFileSync(join(dir, meta.icon), fakePng(256, 256));
    }
    for (const rel of Array.isArray(meta.screenshots) ? meta.screenshots : []) {
      if (typeof rel === "string" && rel.startsWith("screenshots/") && !rel.slice("screenshots/".length).includes("/")) {
        writeFileSync(join(dir, rel), fakePng(320, 170));
      }
    }
  }
  for (const [rel, content] of broken) {
    const p = join(pool, rel);
    if (content === null) rmSync(p, { force: true });
    else writeFileSync(p, content);
  }
  const [err, warn, help] = ["err.txt", "warn.txt", "help.md"].map((f) => join(root, f));
  execFileSync("python3", [SCRIPT, pkg, join(pool, pkg), skipPool ? "-" : pool, err, warn, help]);
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return { errors: read(err), warnings: read(warn), help: read(help) };
}

test("a fully specified package passes with no warnings", () => {
  const r = runPolicy("fontpreview", { fontpreview: goodMeta() });
  assert.equal(r.errors, "");
  assert.equal(r.warnings, "");
  assert.equal(r.help, "");
});

test("every required field is individually enforced", () => {
  const cases = [
    [(m) => { delete m.title; }, /title.*必填/],
    [(m) => { m.summary = "  "; }, /summary.*必填/],
    [(m) => { m.summary = "长".repeat(81); }, /summary 不能超过 80/],
    [(m) => { delete m.license; }, /license.*必填/],
    [(m) => { m.categories = []; }, /categories 必填/],
    [(m) => { m.categories = ["Games", "Media", "AI"]; }, /categories 必填/],
    [(m) => { m.categories = ["Utilities"]; }, /'Utilities' 不在枚举里/],
    [(m) => { m.author = { github: "x" }; }, /author\.display_name.*必填/],
    [(m) => { delete m.share_code; }, /share_code 必填/],
    [(m) => { m.share_code = "TOOLONG"; }, /share_code 必填/],
    [(m) => { m.share_code = "AB!"; }, /share_code 必填/],
    [(m) => { delete m.permissions; }, /permissions 必填/],
    [(m) => { delete m.permissions.camera; }, /permissions 缺少布尔声明：camera/],
    [(m) => { m.permissions.audio_output = true; }, /permissions 含未定义的键：audio_output/],
    [(m) => { delete m.icon; }, /icon 必填/],
    [(m) => { m.icon = "art/icon.png"; }, /不能带路径/],
    [(m) => { m.screenshots = []; }, /screenshots 必填/],
    [(m) => { m.screenshots = Array.from({ length: 7 }, (_, i) => `screenshots/s${i}.png`); },
      /截图最多 6 张（现在 7 张）/],
    [(m) => { m.screenshots = ["shots/a.png"]; }, /必须形如 screenshots\/<文件名>/],
    [(m) => { m.source_repo = "git@github.com:x/y.git"; }, /source_repo 必须是 http\(s\) 链接/],
  ];
  for (const [mutate, want] of cases) {
    const meta = goodMeta();
    mutate(meta);
    const r = runPolicy("fontpreview", { fontpreview: meta });
    assert.match(r.errors, want, `case: ${mutate}`);
  }
});

test("image files are checked on disk, not just referenced", () => {
  // Missing screenshot file.
  let r = runPolicy("fontpreview", { fontpreview: goodMeta() },
    { broken: [["fontpreview/screenshots/main.png", null]] });
  assert.match(r.errors, /截图文件缺失或不是 PNG/);

  // Wrong screenshot dimensions.
  r = runPolicy("fontpreview", { fontpreview: goodMeta() },
    { broken: [["fontpreview/screenshots/main.png", fakePng(640, 340)]] });
  assert.match(r.errors, /必须是 320×170，现在是 640×340/);

  // Icon not square / out of range.
  r = runPolicy("fontpreview", { fontpreview: goodMeta() },
    { broken: [["fontpreview/icon.png", fakePng(100, 100)]] });
  assert.match(r.errors, /icon 必须是正方形 PNG，边长 128~512/);

  // Icon is not a PNG at all.
  r = runPolicy("fontpreview", { fontpreview: goodMeta() },
    { broken: [["fontpreview/icon.png", Buffer.from("JFIF not png")]] });
  assert.match(r.errors, /icon 文件缺失或不是 PNG/);
});

test("share_code and title must be unique across the pool", () => {
  const other = goodMeta();
  other.title = "Other App";
  other.share_code = "OTHR";

  // Same share_code, case-insensitively.
  let mine = goodMeta();
  mine.share_code = "othr";
  let r = runPolicy("fontpreview", { fontpreview: mine, otherapp: other });
  assert.match(r.errors, /share_code 'othr' 已被 otherapp 使用/);

  // Same title module case and whitespace.
  mine = goodMeta();
  mine.title = "  other   APP ";
  r = runPolicy("fontpreview", { fontpreview: mine, otherapp: other });
  assert.match(r.errors, /已被 otherapp 使用，显示名必须全局唯一/);

  // Skipping the pool (czdev local pre-check) skips uniqueness only.
  mine = goodMeta();
  mine.share_code = "OTHR";
  r = runPolicy("fontpreview", { fontpreview: mine, otherapp: other }, { skipPool: true });
  assert.equal(r.errors, "");
});

test("missing description, locales or source_repo warn without blocking", () => {
  const meta = goodMeta();
  delete meta.description;
  delete meta.locales;
  delete meta.source_repo;
  const r = runPolicy("fontpreview", { fontpreview: meta });
  assert.equal(r.errors, "");
  assert.match(r.warnings, /description/);
  assert.match(r.warnings, /locales/);
  assert.match(r.warnings, /source_repo/);
});

test("a rejection hands over the rules and an AI prompt naming the problems", () => {
  const meta = goodMeta();
  delete meta.share_code;
  meta.categories = ["Utilities"];
  const r = runPolicy("fontpreview", { fontpreview: meta });
  assert.match(r.help, /可直接交给 AI 的提示词/);
  assert.match(r.help, /我的包名是 fontpreview/);
  assert.match(r.help, /share_code 必填/);
  assert.match(r.help, /'Utilities' 不在枚举里/);
  // The prompt teaches the fix, not just the rule.
  assert.match(r.help, /app-builder\.json 的 store 段示例/);
});

test("a package without meta.json is a single clear error", () => {
  const r = runPolicy("fontpreview", {}, { skipPool: true });
  assert.match(r.errors, /缺少 meta\.json/);
});
