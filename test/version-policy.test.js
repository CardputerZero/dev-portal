import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../packages-workflows/catalog_cleanup.py", import.meta.url).pathname;
const validation = readFileSync(new URL("../packages-workflows/validate-pr.yml", import.meta.url), "utf8");

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

test("a manifest replacement recognized as a Git rename is validated and withdrawn as D+A", () => {
  const root = mkdtempSync(join(tmpdir(), "portal-manifest-replacement-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Tests");
    git("config", "user.email", "tests@example.test");
    git("config", "commit.gpgsign", "false");
    git("config", "diff.renames", "true");
    const dir = "pool/main/sample";
    mkdirSync(join(root, dir), { recursive: true });
    const manifest = (version, hash) => {
      const filename = `sample_${version}_arm64.deb`;
      const path = `${dir}/${filename}.release.json`;
      writeFileSync(join(root, path), JSON.stringify({ filename, package: "sample", version,
        architecture: "arm64", uploaded_by: "example-application-developer",
        uploader_email: "example-application-developer@users.noreply.github.com",
        url: `https://example.test/releases/download/czdev-buffer/${filename}`,
        sha256: hash.repeat(64), size: 1024 }, null, 2) + "\n");
      return path;
    };
    const oldPath = manifest("1.0", "a");
    git("add", "-A");
    git("commit", "-qm", "publish old version");
    unlinkSync(join(root, oldPath));
    const newPath = manifest("2.0", "b");
    git("add", "-A");
    git("commit", "-qm", "replace old version");
    assert.match(git("diff", "--find-renames", "--name-status", "HEAD^", "HEAD"), /^R\d+\t/);

    const lines = validation.split("\n").map(line => line.trim());
    const select = name => lines.find(line => line.startsWith(`${name}=`));
    const immutable = validation.match(/for m in \$\(git diff[^\n]+\n[^\n]+\n\s+done/)[0];
    const checks = ["set -uo pipefail", "BASE_SHA=HEAD^", "HEAD_SHA=HEAD", 'ERRORS=""',
      select("OUTSIDE"), select("TOUCHED_PKGS"), immutable,
      select("ADDED_MANIFESTS"), select("DELETED"),
      'printf "%s\\0" "$OUTSIDE" "$TOUCHED_PKGS" "$ERRORS" "$ADDED_MANIFESTS" "$DELETED"'].join("\n");
    const fields = execFileSync("bash", ["-c", checks], { cwd: root, encoding: "utf8" }).split("\0");
    assert.deepEqual(fields, ["", "sample", "", newPath, oldPath, ""]);

    const plan = JSON.parse(execFileSync("python3", [script, "plan"], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(plan.active.map(m => m.version), ["2.0"]);
    assert.deepEqual(plan.withdrawn.map(m => m.version), ["1.0"]);
    assert.deepEqual(plan.superseded, []);
    const historical = JSON.parse(execFileSync("python3", [script, "lookup", oldPath], { cwd: root, encoding: "utf8" }));
    assert.equal(historical.version, "1.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
