import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import worker from "../worker/src/index.js";
import { pendingPortalPR } from "../packages-workflows/pending-portal-pr.mjs";

const repo = "CardputerZero/packages";
function pr(number, ref, full_name = repo) {
  return { number, head: { ref, repo: { full_name } } };
}
const json = data => Response.json(data);

test("uses exact package paths, supports old release branches and paginates", async () => {
  let pages = 0;
  const request = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith("/files")) {
      return json([{ filename: u.pathname.includes("/953/") ? "pool/main/app/meta.json" : "pool/main/app-pro/meta.json" }]);
    }
    assert.equal(u.searchParams.get("state"), "open");
    assert.equal(u.searchParams.get("base"), "main");
    pages++;
    return json(pages === 1 ? [
      pr(20, "publish/app-pro-1-web-10"), pr(21, "metadata/app-web-30", "other/fork"),
      ...Array(98).fill(pr(22, "metadata/app-pro-web-20")),
    ] : [pr(953, "publish/app-0.2.0-web-45972038235")]);
  };
  assert.equal(await pendingPortalPR(repo, "app", "test", request), 953);
  assert.equal(pages, 2);
  assert.equal(await pendingPortalPR(repo, "app", "test", async () => json([])), null);
  await assert.rejects(pendingPortalPR(repo, "app", "test", async () => new Response(null, { status: 503 })), /503/);
});

function signed(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return payload + "." + createHmac("sha256", "test-key").update(payload).digest("hex");
}

test("both submit modes return the existing PR before uploading assets or dispatching", async t => {
  const env = { TARGET_OWNER: "CardputerZero", TARGET_REPO: "packages", BOT_TOKEN: "test",
    SESSION_SECRET: "test-key", PACKAGES_INDEX_URL: "https://catalog.test/dists/stable/Packages" };
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const headers = { Cookie: "cz_session=" + signed({ l: "dev", e: [], x: expiry }) };
  const get = t.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    if (input === env.PACKAGES_INDEX_URL) return new Response("Package: app\nVersion: 1\nMaintainer: Developer\n");
    if (input.endsWith("/owners.json")) return json({ app: { "1": "dev" } });
    assert.ok(input.includes("/pulls?state=open"), input);
    return json([pr(955, "metadata/app-web-123")]);
  });
  for (const path of ["submit/prepare", "submit/finalize", "listing"]) {
    const form = new FormData();
    form.set("package", "app");
    const prepare = path === "submit/prepare";
    const ticket = signed({ k: "upload", l: "dev", e: [], p: "app", v: "2", a: "arm64", s: "0".repeat(64),
      z: 20, u: "https://github.com/test", x: expiry });
    const req = new Request("https://dev.test/api/" + path, { method: "POST",
      headers: { ...headers, "x-cz-upload-ticket": ticket, ...(prepare ? { "content-type": "application/json" } : {}) },
      body: prepare ? JSON.stringify({ package: "app", version: "2", arch: "arm64", size: 20,
        sha256: "0".repeat(64) }) : form });
    const response = await worker.fetch(req, env);
    const data = await response.json();
    assert.equal(response.status, 409, path + " " + JSON.stringify(data));
    assert.equal(data.number, 955);
    assert.equal(data.url, "https://github.com/CardputerZero/packages/pull/955");
  }
  assert.equal(get.mock.calls.filter(call => String(call.arguments[0]).includes("/pulls?")).length, 3);
});

test("overlapping listing uploads keep separate staging images and canonical screenshot paths", async t => {
  const env = { TARGET_OWNER: "CardputerZero", TARGET_REPO: "packages", BOT_TOKEN: "test", SESSION_SECRET: "test-key",
    PACKAGES_INDEX_URL: "https://catalog.test/dists/stable/Packages" };
  const cookie = "cz_session=" + signed({ l: "dev", e: [], x: Date.now() / 1000 + 600 });
  const names = new Set(), dispatches = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    if (input === env.PACKAGES_INDEX_URL) return new Response("Package: app\nVersion: 1\n");
    if (input.endsWith("/owners.json")) return json({ app: { "1": "dev" } });
    if (input.includes("/pulls?")) return json([]);
    if (input.includes("/releases/tags/")) return json({ id: 1, assets: [] });
    if (input.startsWith("https://uploads.github.com/")) {
      const name = new URL(input).searchParams.get("name");
      assert.ok(!names.has(name));
      names.add(name);
      return json({ browser_download_url: "https://github.com/example/" + name });
    }
    assert.ok(input.endsWith("/dispatches"), input);
    dispatches.push(JSON.parse(init.body).client_payload.store.screenshots[0]);
    return new Response(null, { status: 204 });
  });
  const submit = () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.writeUInt32BE(320, 16); png.writeUInt32BE(170, 20);
    const form = new FormData();
    form.set("package", "app");
    form.append("screenshots", new Blob([png]), "test.png");
    return worker.fetch(new Request("https://dev.test/api/listing", { method: "POST", body: form,
      headers: { Cookie: cookie } }), env);
  };
  const responses = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(names.size, 2);
  assert.deepEqual(dispatches.map(s => s.name), ["screenshot-0.png", "screenshot-0.png"]);
  assert.notEqual(dispatches[0].url, dispatches[1].url);
});
