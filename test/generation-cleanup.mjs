import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hashProjectToken } from "../src/guard.js";
import { readQuotaCounts, saveDeckVersion } from "../src/store.js";
import worker from "../src/worker.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const token = "a".repeat(64);
const html = '<!doctype html><html>' + '<section class="slide"></section>'.repeat(3) + "</html>";

async function fixture(t, action) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(schema);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async first() { return statement.get(...bound) ?? null; },
        async all() { return { results: statement.all(...bound) }; },
        async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
  };
  const objects = new Map();
  const faults = { read: false };
  const BUCKET = {
    async put(key, content) { objects.set(key, content); },
    async delete(key) { objects.delete(key); },
    async get(key) {
      if (!objects.has(key)) return null;
      return {
        async text() {
          if (faults.read) throw new Error("R2 body read failed");
          return objects.get(key);
        },
      };
    },
  };
  const env = {
    DB, BUCKET,
    MINIMAX_API_KEY: "test-only",
    LIMIT_GLOBAL_TEXT: "100",
    LIMIT_PROJECT_REVISES: "6",
    LIMIT_PROJECT_RETRIES: "2",
  };
  await DB.prepare("INSERT INTO projects(id, brief, access_token_hash) VALUES(?1, ?2, ?3)")
    .bind("project", "Test deck", await hashProjectToken(token)).run();
  if (action === "revise") await saveDeckVersion(DB, BUCKET, "project", html, "test");
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const entries = [
    { scope: "global:text", day },
    { scope: "proj:project:revises", day: "all" },
    { scope: "proj:project:retries", day: "all" },
  ];
  for (const [index, entry] of entries.entries()) {
    await DB.prepare("INSERT INTO quotas(scope, day, count) VALUES(?1, ?2, ?3)")
      .bind(entry.scope, entry.day, 3 - index).run();
  }
  const jobs = [];
  const ctx = { waitUntil(job) { jobs.push(job); } };
  const request = (method, suffix = "") => worker.fetch(
    new Request(`https://minideck.test/api/projects/project${suffix}`, {
      method,
      headers: { "X-Project-Token": token, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ message: "Shorter title" }) } : {}),
    }), env, ctx,
  );
  return {
    sqlite, env, faults, jobs, request,
    run: () => request("POST", `/${action}`),
    counts: () => readQuotaCounts(DB, entries),
    async assertReleased() {
      const response = await request("GET");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, action === "revise" ? "ready" : "new");
    },
    async assertDeleted() {
      const response = await request("DELETE");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deleted: true, cleanupPending: 0 });
    },
  };
}

for (const action of ["generate", "revise"]) {
  test(`${action}: quota INSERT failure releases the project and allows deletion`, async (t) => {
    const f = await fixture(t, action);
    f.sqlite.exec(`CREATE TRIGGER quota_failure BEFORE INSERT ON quotas
      WHEN NEW.scope = 'global:text' BEGIN SELECT RAISE(ABORT, 'd1 quota write failed'); END`);
    const response = await f.run();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "服務處理失敗" });
    await f.assertReleased();
    assert.deepEqual(await f.counts(), [3, 2, 1]);
    assert.equal(f.jobs.length, 0);
    await f.assertDeleted();
  });

  test(`${action}: pre-stream exception refunds reservations and allows deletion`, async (t) => {
    const f = await fixture(t, action);
    Object.defineProperty(f.env, "MINIMAX_API_KEY", {
      get() { throw new Error("pre-stream setup failed"); },
    });
    assert.equal((await f.run()).status, 500);
    await f.assertReleased();
    assert.deepEqual(await f.counts(), [3, 2, 1]);
    assert.equal(f.jobs.length, 0);
    await f.assertDeleted();
  });

  test(`${action}: exhausted quota releases without refunding existing usage`, async (t) => {
    const f = await fixture(t, action);
    f.env.LIMIT_GLOBAL_TEXT = "3";
    assert.equal((await f.run()).status, 429);
    await f.assertReleased();
    assert.deepEqual(await f.counts(), [3, 2, 1]);
    await f.assertDeleted();
  });

  test(`${action}: retry starts a stream, keeps the lock, then settles failure once`, async (t) => {
    const f = await fixture(t, action);
    f.env.LIMIT_GLOBAL_TEXT = "invalid";
    assert.equal((await f.run()).status, 500);
    await f.assertReleased();
    f.env.LIMIT_GLOBAL_TEXT = "100";
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let respond;
    globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
    const response = await f.run();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(f.jobs.length, 1);
    assert.equal((await f.run()).status, 409);
    assert.equal((await f.request("DELETE")).status, 409);
    respond(new Response("unavailable", { status: 503 }));
    assert.match(await response.text(), /event: error/);
    await Promise.all(f.jobs);
    await f.assertReleased();
    assert.deepEqual(await f.counts(), [3, 2, 2]);
    await f.assertDeleted();
  });

  test(`${action}: successful stream keeps reservations and releases via saved version`, async (t) => {
    const f = await fixture(t, action);
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: html } }] })}\n\ndata: [DONE]\n\n`,
    );
    const response = await f.run();
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
    await Promise.all(f.jobs);
    assert.equal((await (await f.request("GET")).json()).status, "ready");
    assert.deepEqual(await f.counts(), [4, action === "revise" ? 3 : 2, 1]);
    await f.assertDeleted();
  });
}

test("revise: partial quota reservation failure refunds global text", async (t) => {
  const f = await fixture(t, "revise");
  f.sqlite.exec(`CREATE TRIGGER quota_failure BEFORE INSERT ON quotas
    WHEN NEW.scope = 'proj:project:revises' BEGIN SELECT RAISE(ABORT, 'd1 revise write failed'); END`);
  assert.equal((await f.run()).status, 500);
  await f.assertReleased();
  assert.deepEqual(await f.counts(), [3, 2, 1]);
  await f.assertDeleted();
});

test("revise: invalid revise limit refunds global text", async (t) => {
  const f = await fixture(t, "revise");
  f.env.LIMIT_PROJECT_REVISES = "invalid";
  assert.equal((await f.run()).status, 500);
  await f.assertReleased();
  assert.deepEqual(await f.counts(), [3, 2, 1]);
  await f.assertDeleted();
});

test("revise: exhausted revise quota refunds only the reserved text quota", async (t) => {
  const f = await fixture(t, "revise");
  f.env.LIMIT_PROJECT_REVISES = "2";
  assert.equal((await f.run()).status, 429);
  await f.assertReleased();
  assert.deepEqual(await f.counts(), [3, 2, 1]);
  await f.assertDeleted();
});

test("revise: R2 body read failure refunds both quotas without consuming retries", async (t) => {
  const f = await fixture(t, "revise");
  f.faults.read = true;
  assert.equal((await f.run()).status, 500);
  await f.assertReleased();
  assert.deepEqual(await f.counts(), [3, 2, 1]);
  assert.equal(f.jobs.length, 0);
  await f.assertDeleted();
});
