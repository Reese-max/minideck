import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import worker from "../src/worker.js";

// Helper to mock Cloudflare D1 over node:sqlite
function createD1() {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }

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
  };
}

// Helper to mock Cloudflare R2 bucket
function createBucket() {
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

  // 4. Test Scenario: anonymous recipient sees nothing until the owner publishes
  const anonUnpublished = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(anonUnpublished.status, 404);
  console.log("PASS 未發佈專案的匿名分享連結不回傳草稿 (404)");

  const publishRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Project-Token": projectToken,
      },
      body: JSON.stringify({ version: 2 }),
    }),
    mockEnv,
  );
  assert.equal(publishRes.status, 200);
  assert.equal((await publishRes.json()).version, 2);

  const anonPlayerRes = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(anonPlayerRes.status, 200);
  const anonPlayerHtml = await anonPlayerRes.text();
  assert.match(anonPlayerHtml, /公司估值公開版/);
  assert.doesNotMatch(anonPlayerHtml, new RegExp(DRAFT_SECRET));
  assert.doesNotMatch(anonPlayerHtml, new RegExp(projectToken));
  console.log("PASS 公開分享頁只呈現已發佈版本，未洩露草稿機密與權杖");

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

  // 8. Test: Anonymous caller visits /p/:id?version=2 (matching published_version)
  const anonPlayerV2Res = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}?version=2`),
    mockEnv,
  );
  assert.equal(anonPlayerV2Res.status, 200);
  assert.match(await anonPlayerV2Res.text(), /公司估值公開版/);
  console.log("PASS 匿名存取已發佈版本播放頁 /p/:id?version=2 正常播放");

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

  // 10. Test: Rollback creates a new draft but never moves the public head
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

  // Anonymous user still sees published v2 — the rolled-back draft stays private
  const anonRolledRes = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(anonRolledRes.status, 200);
  const anonRolledHtml = await anonRolledRes.text();
  assert.match(anonRolledHtml, /公司估值公開版/);
  assert.doesNotMatch(anonRolledHtml, new RegExp(DRAFT_SECRET));

  const anonPlayerV3Res = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}?version=3`),
    mockEnv,
  );
  assert.equal(anonPlayerV3Res.status, 403);
  console.log("PASS 回退產生的 v3 為草稿，公開連結仍播放已發佈的 v2");

  // Anonymous user cannot access superseded version v2 through deck API
  const anonV2DeckRes = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/deck?version=2`),
    mockEnv,
  );
  assert.equal(anonV2DeckRes.status, 403);

  // Only an explicit publish exposes the rolled-back content
  const publishV3Res = await worker.fetch(
    new Request(`https://minideck.test/api/projects/${projectId}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Project-Token": projectToken,
      },
      body: JSON.stringify({ version: 3 }),
    }),
    mockEnv,
  );
  assert.equal(publishV3Res.status, 200);

  const anonPublishedV3 = await worker.fetch(
    new Request(`https://minideck.test/p/${projectId}`),
    mockEnv,
  );
  assert.equal(anonPublishedV3.status, 200);
  assert.match(await anonPublishedV3.text(), new RegExp(DRAFT_SECRET));
  console.log("PASS 僅 explicit publish 才讓回退版本對外公開");

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

  console.log("ALL PERSONA C04 / J04 ACCEPTANCE CRITERIA PASSED");
} finally {
  globalThis.fetch = originalFetch;
}
