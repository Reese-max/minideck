import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import worker from "../src/worker.js";

// Helper to mock Cloudflare D1 over node:sqlite
function createD1(beforeRun = () => {}) {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }

  let failGlobalTextInsert = false;
  return {
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        async first() {
          const stmt = db.prepare(sql);
          return stmt.get(...bound) ?? null;
        },
        async all() {
          const stmt = db.prepare(sql);
          return { results: stmt.all(...bound) };
        },
        async run() {
          beforeRun(sql, bound);
          if (
            failGlobalTextInsert &&
            sql.includes("INSERT INTO quotas") &&
            bound[0] === "global:text"
          ) {
            throw new Error("d1 quota write failed");
          }
          const stmt = db.prepare(sql);
          const info = stmt.run(...bound);
          return { meta: { changes: Number(info.changes) } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.all());
      }
      return results;
    },
    setFailGlobalTextInsert(value) {
      failGlobalTextInsert = value;
    },
  };
}

// Helper to mock Cloudflare R2 bucket
function createBucket(beforeText = () => {}) {
  const store = new Map();
  return {
    async put(key, body, options = {}) {
      let content;
      if (typeof body === "string") {
        content = body;
      } else if (body && typeof body.text === "function") {
        content = await body.text();
      } else {
        content = String(body);
      }
      store.set(key, {
        content,
        httpMetadata: options.httpMetadata ?? {},
      });
      return { key };
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        writeHttpMetadata(headers) {
          if (item.httpMetadata?.contentType) {
            headers.set("content-type", item.httpMetadata.contentType);
          }
        },
        body: item.content,
        async text() {
          beforeText();
          return item.content;
        },
      };
    },
    async head(key) {
      return store.has(key) ? {} : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// Helper to mock Cloudflare Assets
const playHtmlContent = await readFile(
  new URL("../public/play.html", import.meta.url),
  "utf8",
);
const assets = {
  async fetch(reqUrl) {
    const url = new URL(reqUrl);
    if (url.pathname === "/play.html") {
      return new Response(playHtmlContent, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

const mockEnv = {
  DB: createD1(),
  BUCKET: createBucket(),
  ASSETS: assets,
  IP_SALT: "test-salt-12345",
  LIMIT_IP_PROJECTS: "10",
  LIMIT_GLOBAL_PROJECTS: "100",
  LIMIT_GLOBAL_TEXT: "100",
  LIMIT_GLOBAL_IMAGES: "100",
  LIMIT_PROJECT_REVISES: "5",
  LIMIT_PROJECT_IMAGES: "10",
  TURNSTILE_SECRET: "test-turnstile-secret",
};

// Intercept Turnstile siteverify requests in mock global fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("challenges.cloudflare.com/turnstile")) {
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (String(url) === "https://api.minimax.io/v1/chat/completions") {
    const html = `<!doctype html><html><body>${'<section class="slide">測試</section>'.repeat(3)}</body></html>`;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: html } }] })}\n\ndata: [DONE]\n\n`);
  }
  return originalFetch(url, init);
};

try {
  // 1. Create project
  const createRes = await worker.fetch(
    new Request("https://minideck.test/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "2001:db8::1",
      },
      body: JSON.stringify({
        brief: "Persona C04 / J04 confidential deck",
        turnstileToken: "valid-token",
      }),
    }),
    mockEnv,
  );
  assert.equal(createRes.status, 200);
  const { id: projectId, token: projectToken } = await createRes.json();
  assert.match(projectId, /^[a-f0-9]{40}$/);
  assert.match(projectToken, /^[a-f0-9]{64}$/);

  // 2. Save v1 containing a sentinel secret (Persona C04 / J04 draft)
  const DRAFT_SECRET = "SENTINEL_C04_CONFIDENTIAL_VALUATION_2026";
  const v1Html = `<!doctype html><html lang="zh-Hant-TW"><body>
<section class="slide"><h1>公司估值初稿</h1><p>${DRAFT_SECRET}</p></section>
<section class="slide"><h1>市場分析</h1></section>
<section class="slide"><h1>結語</h1></section>
</body></html>`;

  const saveV1Res = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Project-Token": projectToken,
      },
      body: JSON.stringify({ html: v1Html, origin: "imagefill" }),
    }),
    mockEnv,
  );
  assert.equal(saveV1Res.status, 200);
  assert.deepEqual(await saveV1Res.json(), { version: 1 });

  // 3. Save v2 with sensitive material redacted away
  const v2Html = `<!doctype html><html lang="zh-Hant-TW"><body>
<section class="slide"><h1>公司估值公開版</h1><p>數據待公布</p></section>
<section class="slide"><h1>市場分析</h1></section>
<section class="slide"><h1>結語</h1></section>
</body></html>`;

  const saveV2Res = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Project-Token": projectToken,
      },
      body: JSON.stringify({ html: v2Html, origin: "mechfix" }),
    }),
    mockEnv,
  );
  assert.equal(saveV2Res.status, 200);
  assert.deepEqual(await saveV2Res.json(), { version: 2 });

  // 4. Test Scenario: Unrelated anonymous recipient views the normal shared link /p/<id>
  const anonPlayerRes = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(anonPlayerRes.status, 200);
  const anonPlayerHtml = await anonPlayerRes.text();
  assert.match(anonPlayerHtml, /公司估值公開版/);
  assert.doesNotMatch(anonPlayerHtml, new RegExp(DRAFT_SECRET));
  assert.doesNotMatch(anonPlayerHtml, new RegExp(projectToken));
  console.log("PASS 公開分享頁正常載入最新版，未洩露草稿機密與權杖");

  // 5. Test Regression: Anonymous caller derives /api/projects/:id/deck?version=1
  const anonV1DeckRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck?version=1`),
    mockEnv,
  );
  assert.equal(anonV1DeckRes.status, 403);
  const anonV1Json = await anonV1DeckRes.json();
  assert.equal(anonV1Json.error, "專案權杖無效");
  console.log("PASS 匿名存取歷史版本 /api/projects/:id/deck?version=1 被拒絕 (403)");

  // 6. Test Regression: Anonymous caller derives raw /api/projects/:id/deck
  const anonLatestDeckRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck`),
    mockEnv,
  );
  assert.equal(anonLatestDeckRes.status, 403);
  console.log("PASS 匿名存取最新版本 /api/projects/:id/deck 被拒絕 (403)");

  // 7. Test Regression: Anonymous caller tries /p/:id?version=1
  const anonPlayerV1Res = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}?version=1`),
    mockEnv,
  );
  assert.equal(anonPlayerV1Res.status, 403);
  console.log("PASS 匿名存取歷史播放頁 /p/:id?version=1 被拒絕 (403)");

  // 8. Test: Anonymous caller visits /p/:id?version=2 (matching current_version)
  const anonPlayerV2Res = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}?version=2`),
    mockEnv,
  );
  assert.equal(anonPlayerV2Res.status, 200);
  assert.match(await anonPlayerV2Res.text(), /公司估值公開版/);
  console.log("PASS 匿名存取當前版本播放頁 /p/:id?version=2 正常播放");

  // 9. Test: Owner with X-Project-Token can inspect historical v1 and current v2
  const ownerV1Res = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck?version=1`, {
      headers: { "X-Project-Token": projectToken },
    }),
    mockEnv,
  );
  assert.equal(ownerV1Res.status, 200);
  const ownerV1Html = await ownerV1Res.text();
  assert.match(ownerV1Html, new RegExp(DRAFT_SECRET));
  console.log("PASS 擁有者使用 X-Project-Token 可正常讀取歷史版本 v1 (含機密)");

  const ownerV2Res = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck?version=2`, {
      headers: { "X-Project-Token": projectToken },
    }),
    mockEnv,
  );
  assert.equal(ownerV2Res.status, 200);
  const ownerV2Html = await ownerV2Res.text();
  assert.match(ownerV2Html, /公司估值公開版/);
  console.log("PASS 擁有者使用 X-Project-Token 可正常讀取版本 v2");

  // 10. Test: Rollback does not silently expose unintended historical versions
  const rollbackRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Project-Token": projectToken,
      },
      body: JSON.stringify({ version: 1 }),
    }),
    mockEnv,
  );
  assert.equal(rollbackRes.status, 200);
  assert.deepEqual(await rollbackRes.json(), { version: 3 });

  // Anonymous user accessing /p/:id now sees v3 (rolled-back to v1)
  const anonRolledRes = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(anonRolledRes.status, 200);
  assert.match(await anonRolledRes.text(), new RegExp(DRAFT_SECRET));

  // Anonymous user cannot access superseded version v2
  const anonV2DeckRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck?version=2`),
    mockEnv,
  );
  assert.equal(anonV2DeckRes.status, 403);

  const anonPlayerV2AfterRollback = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}?version=2`),
    mockEnv,
  );
  assert.equal(anonPlayerV2AfterRollback.status, 403);
  console.log("PASS 回退至 v1 後，被取代的歷史版本 v2 仍嚴格受保護 (403)");

  // 11. Test: Revocation & Deletion semantics
  const deleteRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { "X-Project-Token": projectToken },
    }),
    mockEnv,
  );
  assert.equal(deleteRes.status, 200);

  // Deleted project player and decks return 404
  const deletedPlayerRes = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(deletedPlayerRes.status, 404);

  const deletedDeckRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck?version=1`, {
      headers: { "X-Project-Token": projectToken },
    }),
    mockEnv,
  );
  assert.equal(deletedDeckRes.status, 404);
  console.log("PASS 專案刪除後公開播放頁與歷史簡報皆立即失效 (404)");

  // Regression (#39): 額度寫入例外後專案不得卡在 generating，DELETE 與再次生成皆須可行。
  const failDb = createD1();
  const failBucket = createBucket();
  const failEnv = { ...mockEnv, DB: failDb, BUCKET: failBucket };

  const failCreateRes = await worker.fetch(
    new Request("https://minideck.test/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "2001:db8::1",
      },
      body: JSON.stringify({
        brief: "額度寫入失敗釋放鎖定回歸測試",
        turnstileToken: "valid-token",
      }),
    }),
    failEnv,
  );
  assert.equal(failCreateRes.status, 200);
  const { id: failId, token: failToken } = await failCreateRes.json();

  failDb.setFailGlobalTextInsert(true);
  const failGenerateRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${failId}/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Project-Token": failToken,
      },
    }),
    failEnv,
  );
  assert.equal(failGenerateRes.status, 500);

  const failStateRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${failId}`, {
      headers: { "X-Project-Token": failToken },
    }),
    failEnv,
  );
  assert.equal(failStateRes.status, 200);
  const failState = await failStateRes.json();
  assert.notEqual(failState.status, "generating", "專案不得停留在 generating");

  const failDeleteRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${failId}`, {
      method: "DELETE",
      headers: { "X-Project-Token": failToken },
    }),
    failEnv,
  );
  assert.equal(failDeleteRes.status, 200);
  assert.deepEqual(await failDeleteRes.json(), { deleted: true, cleanupPending: 0 });
  console.log("PASS 額度寫入例外後專案不卡在 generating，DELETE 可成功");

  console.log("ALL PERSONA C04 / J04 ACCEPTANCE CRITERIA PASSED");

  for (const scenario of [
    { name: "generate preserves existing quota when reservation fails", action: "generate", insertFailure: "global:text" },
    { name: "revise preserves existing quotas when global reservation fails", insertFailure: "global:text" },
    { name: "revise refunds only global quota when revise reservation fails", insertFailure: "revises" },
    { name: "revise refunds both reservations when R2 text fails", readFailure: true },
    { name: "revise unlocks and refunds revise quota even if global refund fails", readFailure: true, refundFailure: "global:text", globalCount: 8 },
    { name: "revise unlocks even if revise refund fails", readFailure: true, refundFailure: "revises", reviseCount: 3 },
    { name: "revise unlocks when partial reservation refund fails", insertFailure: "revises", refundFailure: "global:text", globalCount: 8 },
    { name: "revise refunds the reservation day across UTC midnight", readFailure: true, midnight: true },
  ]) {
    await test(scenario.name, async () => {
      const RealDate = globalThis.Date;
      let now = RealDate.parse("2026-10-24T23:59:59Z");
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
      };
      try {
        let injectFailure = false;
        const db = createD1((sql, [scope]) => {
          if (!injectFailure) return;
          const matches = (target) => target === scope || (target === "revises" && scope?.endsWith(":revises"));
          if (sql.includes("INSERT INTO quotas") && matches(scenario.insertFailure)) {
            throw new Error("d1 quota insert failed");
          }
          if (sql.startsWith("UPDATE quotas") && matches(scenario.refundFailure)) {
            throw new Error("d1 quota refund failed");
          }
        });
        const bucket = createBucket(() => {
          if (!injectFailure) return;
          if (scenario.midnight) now += 2000;
          if (scenario.readFailure) throw new Error("r2 text failed");
        });
        const env = { ...mockEnv, DB: db, BUCKET: bucket, MINIMAX_API_KEY: "test-key" };
        const create = await worker.fetch(new Request("https://minideck.test/api/projects", {
          method: "POST",
          body: JSON.stringify({ brief: scenario.name, turnstileToken: "valid-token" }),
        }), env);
        assert.equal(create.status, 200);
        const { id, token } = await create.json();
        const headers = { "content-type": "application/json", "X-Project-Token": token };
        const request = (path = "", method = "GET", body) => new Request(`https://minideck.test/api/projects/${id}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        });
        const action = scenario.action ?? "revise";
        if (action === "revise") {
          const save = await worker.fetch(request("/deck", "POST", { html: v2Html }), env);
          assert.equal(save.status, 200);
        }
        for (const [scope, day, count] of [
          ["global:text", "20261024", 7],
          ["global:text", "20261025", 11],
          [`proj:${id}:revises`, "all", 2],
        ]) {
          await db.prepare("INSERT INTO quotas(scope, day, count) VALUES(?1, ?2, ?3)").bind(scope, day, count).run();
        }

        injectFailure = true;
        const response = await worker.fetch(request(`/${action}`, "POST", { message: "修訂" }), env);
        assert.equal(response.status, 500);
        const state = await worker.fetch(request(), env);
        assert.equal(state.status, 200);
        assert.equal((await state.json()).status, action === "generate" ? "new" : "ready", "cleanup must release the project lock");
        const count = async (scope, day) => (await db.prepare("SELECT count FROM quotas WHERE scope = ?1 AND day = ?2").bind(scope, day).first()).count;
        assert.equal(await count("global:text", "20261024"), scenario.globalCount ?? 7, "refund only this request's successful global reservation");
        assert.equal(await count("global:text", "20261025"), 11, "do not refund another UTC day");
        assert.equal(await count(`proj:${id}:revises`, "all"), scenario.reviseCount ?? 2, "refund only this request's successful revise reservation");

        injectFailure = false;
        const jobs = [];
        const retry = await worker.fetch(request(`/${action}`, "POST", { message: "重試修訂" }), env, { waitUntil(job) { jobs.push(job); } });
        assert.equal(retry.status, 200, "a new generation/revision must be accepted after cleanup");
        assert.match(await retry.text(), /event: done/);
        await Promise.all(jobs);
        const deleted = await worker.fetch(request("", "DELETE"), env);
        assert.equal(deleted.status, 200);
        assert.deepEqual(await deleted.json(), { deleted: true, cleanupPending: 0 });
      } finally {
        globalThis.Date = RealDate;
      }
    });
  }
} finally {
  globalThis.fetch = originalFetch;
}
