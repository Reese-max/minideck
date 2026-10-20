import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { Miniflare } = createRequire(import.meta.resolve("wrangler"))("miniflare");

const root = new URL("../", import.meta.url);
const schema = await readFile(new URL("schema.sql", root), "utf8");
const template = await readFile(new URL("public/play.html", root), "utf8");
let generatedHtml;
let providerCalls = 0;
const mf = new Miniflare({
  modules: true,
  scriptPath: fileURLToPath(new URL("src/worker.js", root)),
  modulesRoot: fileURLToPath(root),
  modulesRules: [
    { type: "ESModule", include: ["**/*.js"] },
    { type: "Text", include: ["**/*.md"] },
  ],
  compatibilityDate: "2026-07-29",
  d1Databases: ["DB"],
  r2Buckets: ["BUCKET"],
  bindings: {
    MINIMAX_API_KEY: "fixture-only", LIMIT_GLOBAL_TEXT: "100",
    LIMIT_PROJECT_REVISES: "20", LIMIT_PROJECT_RETRIES: "2",
  },
  serviceBindings: { ASSETS: () => new Response(template) },
  outboundService: (request) => {
    assert.equal(new URL(request.url).hostname, "api.minimax.io");
    providerCalls++;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: generatedHtml } }] })}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
after(() => mf.dispose());
const db = await mf.getD1Database("DB");
const bucket = await mf.getR2Bucket("BUCKET");
async function sql(source) {
  for (const statement of source.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
await sql(schema);
const token = "a".repeat(64);
const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
const html = (label) => `<!doctype html><html><body><section class="slide">${label}</section><section class="slide">Second</section><section class="slide">Third</section></body></html>`;
let sequence = 0;
async function project() {
  const id = `publication-${++sequence}`;
  await db.prepare("INSERT INTO projects(id, brief, access_token_hash) VALUES(?1, 'Fixture', ?2)").bind(id, tokenHash).run();
  return id;
}
function request(path, { method = "GET", body, owner = true, headers = {} } = {}) {
  return mf.dispatchFetch(`https://minideck.test${path}`, {
    method,
    headers: { ...(owner ? { "X-Project-Token": token } : {}), "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const action = (id, name, body, options = {}) => request(`/api/projects/${id}/${name}`, { method: "POST", body, ...options });
async function save(id, label) {
  const response = await action(id, "deck", { html: html(label) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).version;
}
const state = async (id) => (await request(`/api/projects/${id}`)).json();
async function publish(id, version) {
  const before = providerCalls;
  const response = await action(id, "publish", { version });
  assert.equal(response.status, 200, await response.clone().text());
  const receipt = await response.json();
  assert.equal(receipt.published_version, version);
  assert.ok(Number.isInteger(receipt.published_at) && receipt.published_at > 0);
  assert.equal(providerCalls, before, "publishing must not generate content");
  return receipt;
}
async function publicDeck(id, label) {
  const response = await request(`/p/${id}`, { owner: false });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.ok(body.includes(label));
  assert.ok(!body.includes(token));
  return body;
}

test("new projects and saved drafts are private until explicitly published", async () => {
  const id = await project();
  await save(id, "PRIVATE_DRAFT");
  assert.equal((await request(`/p/${id}`, { owner: false })).status, 404, "unpublished draft must not be public");
  assert.equal((await state(id)).published_version, null);
  assert.equal((await state(id)).published_at, null);
  assert.equal((await state(id)).current_version, 1);
});

test("saving preserves the previous incomplete HTML behavior while publish validates completion", async () => {
  const id = await project();
  const response = await action(id, "deck", { html: html("INCOMPLETE").replace("</html>", "") });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 1 });
  assert.equal((await action(id, "publish", { version: 1 })).status, 400);
  assert.equal((await state(id)).published_version, null);
});

test("publish receipts pin the public head across saves and republishing", async () => {
  const id = await project();
  await save(id, "RELEASE_V1");
  const receipt = await publish(id, 1);
  await save(id, "DRAFT_V2");
  assert.ok(!(await publicDeck(id, "RELEASE_V1")).includes("DRAFT_V2"));
  assert.equal((await state(id)).published_at, receipt.published_at);
  assert.equal((await state(id)).current_version, 2);
  await publish(id, 2);
  await publicDeck(id, "DRAFT_V2");
  await publish(id, 1);
  await publicDeck(id, "RELEASE_V1");
});

test("owner preview uses the exact public renderer for current and historical drafts", async () => {
  const id = await project();
  await save(id, "HISTORY_DRAFT");
  await save(id, "CURRENT_DRAFT");
  const preview = await request(`/api/projects/${id}/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const previewHtml = await preview.text();
  assert.ok(previewHtml.includes("CURRENT_DRAFT"));
  assert.ok(!previewHtml.includes(token));
  assert.ok((await (await request(`/api/projects/${id}/preview?version=1`)).text()).includes("HISTORY_DRAFT"));
  await publish(id, 2);
  assert.equal(await (await request(`/p/${id}`, { owner: false })).text(), previewHtml);
});

test("preview and unpublished player versions reject missing, invalid and URL tokens", async () => {
  const id = await project();
  await save(id, "PRIVATE_ONE");
  await publish(id, 1);
  await save(id, "PRIVATE_TWO");
  for (const path of [`/api/projects/${id}/preview`, `/api/projects/${id}/preview?version=1`, `/p/${id}?version=2`]) {
    assert.equal((await request(path, { owner: false })).status, 403);
    assert.equal((await request(path, { headers: { "X-Project-Token": "invalid" } })).status, 403);
    assert.equal((await request(`${path}${path.includes("?") ? "&" : "?"}token=${token}`, { owner: false })).status, 403);
  }
  assert.equal((await request(`/p/${id}?version=2`)).status, 200);
  assert.equal((await request(`/p/${id}?version=1`, { owner: false })).status, 200);
});

test("publication mutations require a project token and valid version input", async () => {
  const id = await project();
  await save(id, "VALID");
  for (const name of ["publish", "unpublish"]) {
    assert.equal((await action(id, name, { version: 1 }, { owner: false })).status, 403);
    assert.equal((await action(id, name, { version: 1 }, { headers: { "X-Project-Token": "wrong" } })).status, 403);
  }
  for (const version of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await action(id, "publish", { version })).status, 400);
  }
  assert.equal((await action(id, "publish", {})).status, 400);
  assert.equal((await state(id)).published_version, null);
});

test("publish rejects missing, foreign, deleted and invalid stored versions", async () => {
  const id = await project();
  const other = await project();
  await save(other, "OTHER_PROJECT");
  assert.equal((await action(id, "publish", { version: 1 })).status, 404);
  await save(id, "VALID");
  await publish(id, 1);
  await save(id, "INVALID");
  const key = `decks/${id}/2.html`;
  for (const invalid of ["<html>incomplete</html>", html("x").replace("</html>", ""), html("x") + '<img data-gen-prompt="x">'.repeat(13), html("x".repeat(2 * 1024 * 1024))]) {
    await bucket.put(key, invalid);
    assert.equal((await action(id, "publish", { version: 2 })).status, 400);
    assert.equal((await state(id)).published_version, 1);
    assert.equal((await state(id)).status, "ready");
  }
  await bucket.delete(key);
  assert.equal((await action(id, "publish", { version: 2 })).status, 404);
  await db.prepare("DELETE FROM versions WHERE project_id = ?1 AND version = 2").bind(id).run();
  assert.equal((await action(id, "publish", { version: 2 })).status, 404);
  await publicDeck(id, "VALID");
});

test("rollback creates only a draft; explicit publish is still required", async () => {
  const id = await project();
  await save(id, "FIRST");
  await save(id, "SECOND");
  await publish(id, 2);
  const rollback = await action(id, "rollback", { version: 1 });
  assert.deepEqual(await rollback.json(), { version: 3 });
  await publicDeck(id, "SECOND");
  assert.equal((await state(id)).current_version, 3);
  await publish(id, 3);
  await publicDeck(id, "FIRST");
});

test("generate and revise leave the published version untouched", async () => {
  const id = await project();
  await save(id, "RELEASE");
  await publish(id, 1);
  for (const name of ["generate", "revise"]) {
    generatedHtml = html(`PRIVATE_${name}`);
    const response = await action(id, name, name === "revise" ? { message: "Revise fixture" } : {});
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
    await publicDeck(id, "RELEASE");
  }
  assert.equal((await state(id)).current_version, 3);
  assert.equal(providerCalls, 2);
});

test("unpublish revokes anonymous URLs without removing any owner versions", async () => {
  const id = await project();
  await save(id, "RELEASE");
  await publish(id, 1);
  await save(id, "DRAFT");
  for (let i = 0; i < 2; i++) {
    const response = await action(id, "unpublish");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { published_version: null, published_at: null });
  }
  for (const suffix of ["", "?version=1", "?version=2"]) {
    const response = await request(`/p/${id}${suffix}`, { owner: false, headers: { "If-None-Match": "old" } });
    assert.ok([403, 404, 410].includes(response.status));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!(await response.text()).includes("RELEASE"));
  }
  assert.equal((await state(id)).versions.length, 2);
  for (const version of [1, 2]) assert.equal((await request(`/api/projects/${id}/deck?version=${version}`)).status, 200);
  assert.equal((await request(`/api/projects/${id}/preview`)).status, 200);
  await publish(id, 2);
  await publicDeck(id, "DRAFT");
});

test("publish during an in-flight save is rejected before its version exists", async () => {
  const id = await project();
  await save(id, "COMPLETE_ONE");
  await publish(id, 1);
  let enteredPut;
  const putStarted = new Promise((resolve) => { enteredPut = resolve; });
  let releasePut;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  const originalPut = bucket.put.bind(bucket);
  bucket.put = async (key, ...args) => {
    if (key === `decks/${id}/2.html`) {
      enteredPut();
      await putGate;
    }
    return originalPut(key, ...args);
  };
  try {
    const saving = action(id, "deck", { html: html("COMPLETE_TWO") });
    await putStarted;
    const publishing = await action(id, "publish", { version: 2 });
    assert.equal(publishing.status, 409);
    releasePut();
    const saved = await saving;
    assert.equal(saved.status, 200);
  } finally {
    releasePut();
    bucket.put = originalPut;
  }
  assert.equal((await state(id)).current_version, 2);
  assert.equal((await state(id)).published_version, 1);
  await publicDeck(id, "COMPLETE_ONE");
  await db.prepare("UPDATE projects SET status = 'generating' WHERE id = ?1").bind(id).run();
  for (const name of ["publish", "unpublish"]) assert.equal((await action(id, name, { version: 1 })).status, 409);
  assert.equal((await state(id)).published_version, 1);
});

test("project deletion invalidates public/preview URLs and cleans every deck in R2", async () => {
  const id = await project();
  await save(id, "PUBLISHED");
  await publish(id, 1);
  await save(id, "DRAFT");
  const race = await Promise.all([
    action(id, "publish", { version: 2 }),
    request(`/api/projects/${id}`, { method: "DELETE" }),
  ]);
  assert.ok([200, 404, 409].includes(race[0].status));
  assert.ok([200, 409].includes(race[1].status));
  if (race[1].status === 409) assert.equal((await request(`/api/projects/${id}`, { method: "DELETE" })).status, 200);
  for (const path of [`/p/${id}`, `/p/${id}?version=1`, `/api/projects/${id}/preview`, `/api/projects/${id}/deck?version=2`, `/api/projects/${id}`]) assert.equal((await request(path)).status, 404);
  assert.equal((await bucket.list({ prefix: `decks/${id}/` })).objects.length, 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM versions WHERE project_id = ?1").bind(id).first()).n, 0);
});

test("legacy migration pins only the existing current version and leaves empty projects private", async () => {
  await sql("DROP TABLE versions; DROP TABLE projects; DROP TABLE messages; DROP TABLE quotas;");
  await sql(schema.replace(/\s*published_version[^,]*,/g, "").replace(/\s*published_at[^,]*,/g, ""));
  await db.prepare("INSERT INTO projects(id, current_version, access_token_hash) VALUES('legacy', 2, ?1), ('empty', 0, ?1), ('missing', 9, ?1)").bind(tokenHash).run();
  await db.prepare("INSERT INTO versions(project_id, version, r2_key) VALUES('legacy', 2, 'decks/legacy/2.html')").run();
  await bucket.put("decks/legacy/2.html", html("LEGACY_RELEASE"));
  await sql(await readFile(new URL("migrations/published/0002_published_version.sql", root), "utf8"));
  const legacy = await state("legacy");
  assert.equal(legacy.current_version, 2);
  assert.equal(legacy.published_version, 2);
  assert.ok(legacy.published_at > 0);
  await publicDeck("legacy", "LEGACY_RELEASE");
  assert.equal((await state("empty")).published_version, null);
  assert.equal((await state("missing")).published_version, null);
  await save("legacy", "PRIVATE_AFTER_MIGRATION");
  await publicDeck("legacy", "LEGACY_RELEASE");
});
