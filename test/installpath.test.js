/**
 * Install path policy. The same rule is implemented twice — here in JS for the
 * browser pre-check, and in Python inside the packages repo's
 * process-web-submission.yml, which is authoritative. These cases are the
 * contract between the two: test/installpath.policy.py runs the identical table
 * against the Python side.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPathIssue, installPathPrompt, unitRunsAsRoot } from "../site/debparse.js";

const PKG = "fontpreview";

const ALLOWED = [
  // Executables belong in /usr/bin (Policy 10.1). Separators are ignored when
  // matching the name, since a deb package name cannot contain an underscore.
  "usr/bin/fontpreview",
  "usr/bin/font_preview",
  "usr/bin/font-preview",
  "usr/bin/fontpreview-cli",
  // Data directories, likewise spelled freely.
  "usr/share/font_preview/fonts/NotoSansCJK-Regular.ttc",
  "usr/share/fontpreview/audio/select.wav",
  "usr/lib/font_preview/plugin.so",
  "opt/fontpreview/bundled/thing",
  "etc/font_preview/config.toml",
  // A lone conffile, the way rsyslog.conf and logrotate.conf are shipped.
  "etc/font_preview.conf",
  "var/lib/fontpreview/state.db",
  // Project-specific launcher and the standard documentation location.
  "usr/share/APPLaunch/applications/fontpreview.desktop",
  "usr/share/APPLaunch/icons/anything.png",
  "usr/share/doc/fontpreview/changelog.Debian.gz",
  // Units, under either the legacy or the merged-usr location.
  "lib/systemd/system/fontpreview.service",
  "usr/lib/systemd/system/font_preview.timer",
];

const BLOCKED = [
  // The point of the whole check: no quietly taking over a system command,
  // a system unit, or another package's data directory.
  ["usr/bin/ls", /覆盖系统命令/],
  ["usr/bin/python3", /覆盖系统命令/],
  ["lib/systemd/system/sshd.service", /覆盖系统服务/],
  ["usr/share/otherapp/data.bin", /目录名必须与包名/],
  ["usr/lib/aarch64-linux-gnu/libfoo.so", /目录名必须与包名/],
  ["etc/sudoers.d/fontpreview", /etc\/ 下只能放/],
  ["etc/passwd", /etc\/ 下只能放/],
  // Debian hard prohibitions.
  ["usr/local/bin/fontpreview", /9\.1\.2/],
  ["bin/fontpreview", /10\.1/],
  ["sbin/fontpreview", /10\.1/],
  ["lib/libfontpreview.so", /10\.1/],
  // Structural mistakes.
  ["usr/share/loose-file.txt", /不能直接放在/],
  ["usr/bin/fontpreview/helper", /不应有子目录/],
  ["usr/lib/systemd/system/sub/fontpreview.service", /不应再有子目录/],
  // Nothing claims these roots.
  ["home/pi/thing", /不在允许的安装位置内/],
  ["srv/fontpreview/x", /不在允许的安装位置内/],
];

test("allows Debian-standard locations named after the package", () => {
  for (const path of ALLOWED) {
    assert.equal(installPathIssue(path, PKG), null, `${path} should be allowed`);
  }
});

test("blocks hijacking, Debian-prohibited roots and structural mistakes", () => {
  for (const [path, reason] of BLOCKED) {
    const issue = installPathIssue(path, PKG);
    assert.ok(issue, `${path} should be blocked`);
    assert.match(issue, reason, `${path} blocked for the wrong reason: ${issue}`);
  }
});

test("a package whose name prefixes the file name is still its own", () => {
  // Either direction counts: package font-preview-app shipping font_preview,
  // and package fp shipping fp-helper, are both the package's own files.
  assert.equal(installPathIssue("usr/bin/font_preview", "font-preview-app"), null);
  assert.equal(installPathIssue("usr/share/fp/x", "fp-helper"), null);
  assert.ok(installPathIssue("usr/bin/preview", "fontpreview"));
});

test("a unit is root unless it says otherwise", () => {
  // What the Action's root-service scan concludes, reproduced in the browser so
  // the developer is stopped before uploading rather than after.
  const unit = (body) => `[Unit]\nDescription=x\n\n[Service]\n${body}\n`;
  assert.equal(unitRunsAsRoot(unit("ExecStart=/usr/bin/fontpreview")), true);
  assert.equal(unitRunsAsRoot(unit("User=root")), true);
  assert.equal(unitRunsAsRoot(unit("User=0")), true);
  assert.equal(unitRunsAsRoot(unit("User=fontpreview")), false);
  assert.equal(unitRunsAsRoot(unit("DynamicUser=yes")), false);
  // User= outside [Service] does not count, and comments are ignored.
  assert.equal(unitRunsAsRoot("[Unit]\nUser=pi\n\n[Service]\nExecStart=/x\n"), true);
  assert.equal(unitRunsAsRoot(unit("# User=pi\n;User=pi")), true);
});

/** A marked block of the Action, dedented the way the YAML block scalar is. */
function actionBlock(name) {
  const workflow = readFileSync(
    new URL("../packages-workflows/process-web-submission.yml", import.meta.url), "utf8");
  // Leading blanks included, so the first line's indent counts toward the dedent.
  const block = new RegExp(`[ \\t]*# ${name}:begin[\\s\\S]*?# ${name}:end`).exec(workflow);
  assert.ok(block, `${name} block missing from process-web-submission.yml`);
  const lines = block[0].split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim())
    .map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

/** Runs the Action's own policy code, so a drift between the two shows up here. */
function runActionPolicy(cases) {
  const driver = `import re, sys\n${actionBlock("policy")}\n${actionBlock("prompt")}\n` +
    'if sys.argv[1:] == ["prompt"]:\n' +
    '    sys.stdout.write(PROMPT)\n' +
    'else:\n' +
    '    for line in sys.stdin.read().splitlines():\n' +
    '        pkg, path = line.split("\\t", 1)\n' +
    '        print(install_path_issue(path, pkg) or "")\n';
  const file = join(mkdtempSync(join(tmpdir(), "policy-")), "policy.py");
  writeFileSync(file, driver);
  const verdicts = execFileSync("python3", [file], {
    input: cases.map(([pkg, p]) => `${pkg}\t${p}`).join("\n"),
    encoding: "utf8",
  }).split("\n");
  const prompt = execFileSync("python3", [file, "prompt"], { encoding: "utf8" });
  return { verdicts, prompt };
}

test("the Action's Python copy of the policy agrees, verbatim", (t) => {
  try {
    execFileSync("python3", ["-c", ""]);
  } catch {
    return t.skip("python3 not available");
  }
  const cases = [
    ...ALLOWED.map((p) => [PKG, p]),
    ...BLOCKED.map(([p]) => [PKG, p]),
    ["font-preview-app", "usr/bin/font_preview"],
    ["fp-helper", "usr/share/fp/x"],
    ["fontpreview", "usr/bin/preview"],
  ];
  const { verdicts, prompt } = runActionPolicy(cases);

  cases.forEach(([pkg, p], i) => {
    // Identical wording, not just an identical verdict: this text is what the
    // developer reads, in the browser and in the failure issue alike.
    assert.equal(verdicts[i], installPathIssue(p, pkg) ?? "", `disagreement on ${p}`);
  });

  // The fix-it prompt too: whether the rule is hit in the browser or in CI, the
  // developer should be handed the same thing.
  assert.equal(
    prompt.replace("{pkg}", PKG).replace("{paths}", "usr/bin/ls"),
    installPathPrompt(PKG, ["usr/bin/ls"]));
});
