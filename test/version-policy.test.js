import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../packages-workflows/catalog_cleanup.py", import.meta.url).pathname;

test("portal update replaces older Debian versions across architecture changes", () => {
  const root = mkdtempSync(join(tmpdir(), "portal-version-policy-"));
  try {
    const directory = join(root, "pool/main/sample");
    mkdirSync(directory, { recursive: true });
    const versions = ["1.9", "1.10~rc1", "1.10-2", "1.10-10", "1:0.1"];
    const paths = versions.map((version, i) => {
      const architecture = i === versions.length - 1 ? "all" : "arm64";
      const filename = `sample_${version.replace(/[~:]/g, ".")}_${architecture}.deb`;
      const path = join(directory, filename + ".release.json");
      writeFileSync(path, JSON.stringify({ package: "sample", version, filename, architecture }));
      return path;
    });
    const listing = join(directory, "meta.json");
    writeFileSync(listing, "{}");
    execFileSync("python3", [script, "supersede", "sample", "1:0.1"], { cwd: root });
    assert.ok(existsSync(paths.at(-1)));
    assert.ok(existsSync(listing));
    assert.ok(paths.slice(0, -1).every((path) => !existsSync(path)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
