import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingSubmissions } from "../site/submissions.js";

const submission = (version, state = "merged", pkg = "sample") => ({ package: pkg, version, state });
const index = (version) => new Map([["sample", [{ Version: version }]]]);

test("retired merged versions do not reappear as index rebuilding", () => {
  const subs = [submission("1.9"), submission("1.10~rc1"), submission("1.10"), submission("1.11")];
  assert.deepEqual(pendingSubmissions(subs, index("1.10")), [subs[3]]);
});

test("epochs and revisions follow Debian ordering", () => {
  const subs = [submission("99.0"), submission("1:0.1-2"), submission("1:0.1-10")];
  assert.deepEqual(pendingSubmissions(subs, index("1:0.1-10")), []);
});

test("open submissions and first releases stay visible", () => {
  const subs = [submission("1.0", "open"), submission("1.0", "merged", "newapp"), submission("3.0", "closed")];
  assert.deepEqual(pendingSubmissions(subs, index("2.0")), subs.slice(0, 2));
});

test("equivalent Debian versions already published are not pending", () => {
  assert.deepEqual(pendingSubmissions([submission("1.0-0")], index("1.0")), []);
});
