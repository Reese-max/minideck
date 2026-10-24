import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/worker.js";
import { hashProjectToken } from "../src/guard.js";
import "../public/app.js";

const token = "a".repeat(64);
const html = '<!doctype html><html><body><section class="slide">One</section><section class="slide">Two</section><section class="slide">Three</section></body></html>';

async function fixture(fault = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const id = "quota-recovery-project", day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  sqlite.prepare("INSERT INTO projects(id,brief,access_token_hash,current_version,status) VALUES(?,?,?,?,?)").run(id, "Offline test", await hashProjectToken(token), fault.generate ? 0 : 1, fault.generate ? "new" : "ready");
  sqlite.prepare("INSERT INTO versions(project_id,version,r2_key,origin,created_at) VALUES(?,?,?,?,?)").run(id, 1, `decks/${id}/1.html`, "test", Date.now());
  sqlite.prepare("INSERT INTO quotas(scope,day,count) VALUES(?,?,?)").run("global:text", day, 7);
  sqlite.prepare("INSERT INTO quotas(scope,day,count) VALUES(?,?,?)").run(`proj:${id}:revises`, "all", 2);
  const refunds = [], jobs = [], objects = new Map([[`decks/${id}/1.html`, html]]);
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() {
          if (sql.includes("INSERT INTO quotas") && args[0] === fault.insertScope?.replace("PROJECT", id)) throw new Error("offline quota INSERT failure");
          if (sql.startsWith("UPDATE quotas")) {
            refunds.push(args[0]);
            if (args[0] === fault.refundScope) throw new Error("offline quota refund failure");
          }
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.all())); },
  };
  const BUCKET = {
    async get(key) { return objects.has(key) ? { async text() { if (fault.objectText) throw new Error("offline R2 body failure"); return objects.get(key); } } : null; },
    async put(key, body) { objects.set(key, String(body)); },
    async delete(key) { objects.delete(key); },
  };
  const env = { DB, BUCKET, MINIMAX_API_KEY: "offline-fixture-only", LIMIT_GLOBAL_TEXT: String(fault.globalLimit ?? 100), LIMIT_PROJECT_REVISES: String(fault.reviseLimit ?? 5), LIMIT_PROJECT_RETRIES: "3" };
  const ctx = { waitUntil(job) { jobs.push(job); } };
  const request = (action, method = "POST", body = {}) => worker.fetch(new Request(`https://minideck.invalid/api/projects/${id}${action ? `/${action}` : ""}`, { method, headers: { "content-type": "application/json", "X-Project-Token": token }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), env, ctx);
  return { id, day, sqlite, refunds, jobs, request, count(scope, quotaDay = day) { return sqlite.prepare("SELECT count FROM quotas WHERE scope=? AND day=?").get(scope, quotaDay)?.count ?? 0; } };
}

const cases = [
  ["generate global INSERT fails before any reservation", { generate: true, insertScope: "global:text" }, 500, 7, 2, []],
  ["revise global INSERT preserves earlier usage", { insertScope: "global:text" }, 500, 7, 2, []],
  ["revise INSERT fails after the global reservation", { insertScope: "proj:PROJECT:revises" }, 500, 7, 2, ["global:text"]],
  ["R2 body fails after both reservations", { objectText: true }, 500, 7, 2, ["global:text", "revises"]],
  ["refund failure still releases and attempts the other refund", { objectText: true, refundScope: "global:text" }, 500, 8, 2, ["global:text", "revises"]],
  ["full global quota does not refund another request", { generate: true, globalLimit: 7 }, 429, 7, 2, []],
  ["full revise quota refunds only this global reservation", { reviseLimit: 2 }, 429, 7, 2, ["global:text"]],
];

for (const [name, fault, status, globalCount, reviseCount, expectedRefunds] of cases) test(name, async () => {
  const f = await fixture(fault);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error("External network is forbidden in this fixture"); };
  try {
    const response = await f.request(fault.generate ? "generate" : "revise", "POST", { message: "Update the title" });
    assert.equal(response.status, status);
    const state = await f.request("", "GET");
    assert.equal(state.status, 200);
    assert.equal((await state.json()).status, fault.generate ? "new" : "ready", "pre-stream failure must release the project claim");
    assert.equal(f.count("global:text"), globalCount);
    assert.equal(f.count(`proj:${f.id}:revises`, "all"), reviseCount);
    assert.deepEqual(f.refunds, expectedRefunds.map(scope => scope === "revises" ? `proj:${f.id}:revises` : scope));
    assert.equal(f.jobs.length, 0);
    assert.equal(providerCalls, 0);
    assert.equal((await f.request("", "DELETE")).status, 200, "the failed project can be deleted immediately");
  } finally { globalThis.fetch = originalFetch; f.sqlite.close(); }
});

async function withMockStream(run) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.minimax.io/v1/chat/completions"); calls++;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: html } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  try { await run(() => calls); } finally { globalThis.fetch = originalFetch; }
}

test("a successful stream owns its reservations and finishes normally", async () => {
  const f = await fixture();
  try {
    await withMockStream(async calls => {
      const response = await f.request("revise", "POST", { message: "Update the title" });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /event: done/);
      await Promise.all(f.jobs);
      assert.equal(calls(), 1);
      assert.deepEqual(f.refunds, []);
      assert.equal(f.count("global:text"), 8);
      assert.equal(f.count(`proj:${f.id}:revises`, "all"), 3);
      assert.equal((await (await f.request("", "GET")).json()).status, "ready");
    });
  } finally { f.sqlite.close(); }
});

test("12 slides with five WARNs send an optimization accepted by the real revise route", async () => {
  const f = await fixture();
  try {
    const warns = Array.from({ length: 60 }, (_, i) => ({ slide: Math.floor(i / 5) + 1, type: "font-min", detail: `第${Math.floor(i / 5) + 1}頁：內文字級 16px 落在 13–16px 警示區間：「營收成長」` }));
    const message = globalThis.MD.audit.buildOptimizePrompt({ fails: [], warns });
    assert.ok([...message].length <= 1000, "optimization must honor the revise route's Unicode limit");
    await withMockStream(async calls => {
      const response = await f.request("revise", "POST", { message });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /event: done/);
      await Promise.all(f.jobs);
      assert.equal(calls(), 1);
    });
  } finally { f.sqlite.close(); }
});
