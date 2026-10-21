import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import worker from "../src/worker.js";

// issue #4：草稿 current_version 與公開 published_version 分離。
// 匿名 /p/:id 只能讀取明確發布的版本；草稿、歷史與未發布版本需專案權杖。

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

function createBucket() {
  const store = new Map();
  return {
    async put(key, body, options = {}) {
      const content =
        typeof body === "string"
          ? body
          : body && typeof body.text === "function"
            ? await body.text()
            : String(body);
      store.set(key, { content, httpMetadata: options.httpMetadata ?? {} });
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

const env = {
  DB: createD1(),
  BUCKET: createBucket(),
  ASSETS: assets,
  IP_SALT: "test-salt-publish",
  LIMIT_IP_PROJECTS: "10",
  LIMIT_GLOBAL_PROJECTS: "100",
  LIMIT_GLOBAL_TEXT: "100",
  LIMIT_GLOBAL_IMAGES: "100",
  LIMIT_PROJECT_REVISES: "5",
  LIMIT_PROJECT_IMAGES: "10",
  TURNSTILE_SECRET: "test-turnstile-secret",
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("challenges.cloudflare.com/turnstile")) {
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(url, init);
};

const BASE = "https://minideck.test";
const api = (path, init = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, init), env);
const tokenHeaders = (token, json = false) => ({
  ...(json ? { "content-type": "application/json" } : {}),
  "X-Project-Token": token,
});
const deckHtml = (label) =>
  `<!doctype html><html><body><section class="slide"><h1>${label}</h1></section>` +
  `<section class="slide"><p>b</p></section><section class="slide"><p>c</p></section></body></html>`;

async function createProject() {
  const res = await api("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": "2001:db8::9",
    },
    body: JSON.stringify({ brief: "publish boundary", turnstileToken: "t" }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function saveVersion(id, token, label) {
  const res = await api(`/api/projects/${id}/deck`, {
    method: "POST",
    headers: tokenHeaders(token, true),
    body: JSON.stringify({ html: deckHtml(label), origin: "mechfix" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).version;
}

const publish = (id, token, version) =>
  api(`/api/projects/${id}/publish`, {
    method: "POST",
    headers: tokenHeaders(token, true),
    body: JSON.stringify({ version }),
  });
const unpublish = (id, token) =>
  api(`/api/projects/${id}/unpublish`, {
    method: "POST",
    headers: tokenHeaders(token, true),
    body: "{}",
  });
const anonPlayer = (id, version) =>
  api(`/p/${id}${version === undefined ? "" : `?version=${version}`}`);
const ownerPlayer = (id, token, version) =>
  api(`/p/${id}?version=${version}`, { headers: tokenHeaders(token) });

try {
  const { id, token } = await createProject();

  // 1. 未發布：匿名 /p/:id 不可讀
  const v1 = await saveVersion(id, token, "v1-public");
  assert.equal(v1, 1);
  assert.equal((await anonPlayer(id)).status, 404, "未發布專案不應公開草稿");
  console.log("PASS 未發布草稿匿名 404");

  // 2. publish v1 → 匿名看到 v1
  const pub1 = await publish(id, token, v1);
  assert.equal(pub1.status, 200);
  const receipt = await pub1.json();
  assert.equal(receipt.published_version, 1);
  assert.ok(Number.isInteger(receipt.published_at));
  const anon1 = await anonPlayer(id);
  assert.equal(anon1.status, 200);
  assert.match(await anon1.text(), /v1-public/);
  console.log("PASS publish v1 → 匿名可讀 v1，回傳 receipt");

  // 3. 存 v2 草稿：匿名仍看到 v1；owner 可用權杖預覽 v2
  const v2 = await saveVersion(id, token, "v2-draft-secret");
  assert.equal(v2, 2);
  const anonStill1 = await anonPlayer(id);
  assert.match(await anonStill1.text(), /v1-public/);
  assert.equal((await anonPlayer(id, 2)).status, 403, "草稿 v2 匿名不可讀");
  const ownerV2 = await ownerPlayer(id, token, 2);
  assert.equal(ownerV2.status, 200);
  assert.match(await ownerV2.text(), /v2-draft-secret/);
  console.log("PASS draft v2 匿名仍看 v1；owner 權杖可預覽 v2");

  // 4. publish v2 → 匿名切到 v2
  assert.equal((await publish(id, token, 2)).status, 200);
  const anon2 = await anonPlayer(id);
  assert.match(await anon2.text(), /v2-draft-secret/);
  // 已發布的 v1 仍可匿名讀（舊連結 v1 不再公開，因 public head 是 v2）
  assert.equal((await anonPlayer(id, 1)).status, 403);
  console.log("PASS publish v2 → 匿名切換；舊版不再公開");

  // 5. rollback v1 → v3 草稿；匿名仍看 v2 直到 publish v3
  const rb = await api(`/api/projects/${id}/rollback`, {
    method: "POST",
    headers: tokenHeaders(token, true),
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(rb.status, 200);
  const { version: v3 } = await rb.json();
  assert.equal(v3, 3);
  assert.match(await (await anonPlayer(id)).text(), /v2-draft-secret/);
  assert.equal((await anonPlayer(id, 3)).status, 403, "rollback 草稿不自動公開");
  assert.equal((await publish(id, token, 3)).status, 200);
  assert.match(await (await anonPlayer(id)).text(), /v1-public/);
  console.log("PASS rollback→v3 需再 publish 才公開");

  // 6. 無效權杖／不存在版本／無版本專案
  assert.equal((await publish(id, "deadbeef".repeat(8), 3)).status, 403);
  assert.equal((await publish(id, token, 99)).status, 404);
  const other = await createProject();
  assert.equal((await publish(other.id, other.token, 1)).status, 404,
    "無版本專案 publish → 404");
  assert.equal((await unpublish(id, "deadbeef".repeat(8))).status, 403);
  console.log("PASS 無效 token→403、不存在版本→404");

  // 7. unpublish → 匿名 404；owner 仍可讀版本
  assert.equal((await unpublish(id, token)).status, 200);
  assert.equal((await anonPlayer(id)).status, 404);
  assert.equal((await anonPlayer(id, 3)).status, 403);
  const ownerV3 = await ownerPlayer(id, token, 3);
  assert.equal(ownerV3.status, 200);
  console.log("PASS unpublish → 匿名 404、owner 權杖仍可取版本");

  // 8. 專案狀態回傳 draft/published head
  const state = await api(`/api/projects/${id}`, { headers: tokenHeaders(token) });
  const stateJson = await state.json();
  assert.equal(stateJson.current_version, 3);
  assert.equal(stateJson.published_version, null);
  assert.ok(Array.isArray(stateJson.versions));
  console.log("PASS GET project 狀態含 current/published head");

  // 9. DELETE 後公開連結與所有版本失效
  const del = await api(`/api/projects/${id}`, {
    method: "DELETE",
    headers: tokenHeaders(token),
  });
  assert.equal(del.status, 200);
  assert.equal((await anonPlayer(id)).status, 404);
  console.log("PASS DELETE → 公開連結失效");

  // 10. legacy migration：舊 schema（無 published 欄位）+ current_version=2
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`CREATE TABLE projects(
    id TEXT PRIMARY KEY, created_at INTEGER, ip_hash TEXT, title TEXT,
    brief TEXT, access_token_hash TEXT,
    current_version INTEGER DEFAULT 0, status TEXT DEFAULT 'new');`);
  legacy.exec(`CREATE TABLE versions(
    project_id TEXT, version INTEGER, r2_key TEXT, origin TEXT,
    created_at INTEGER, PRIMARY KEY(project_id, version));`);
  legacy.prepare(
    "INSERT INTO projects(id, created_at, current_version, status) VALUES('lp',1,2,'ready')",
  ).run();
  legacy.prepare(
    "INSERT INTO versions(project_id, version, r2_key, created_at) VALUES('lp',2,'k2',111)",
  ).run();
  const migration = readFileSync(
    new URL("../migrations/0002_published_version.sql", import.meta.url), "utf8");
  for (const stmt of migration.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) legacy.exec(trimmed);
  }
  const migrated = legacy
    .prepare("SELECT published_version, published_at FROM projects WHERE id='lp'")
    .get();
  assert.equal(migrated.published_version, 2, "既有專案 migration 保留公開 head");
  assert.equal(migrated.published_at, 111, "published_at 取版本建立時間");
  const fresh = legacy
    .prepare(
      "INSERT INTO projects(id, created_at, current_version, status) VALUES('np',2,0,'new')",
    )
    .run();
  assert.ok(fresh);
  const newRow = legacy
    .prepare("SELECT published_version FROM projects WHERE id='np'")
    .get();
  assert.equal(newRow.published_version, null, "新專案預設未發布");
  console.log("PASS migration：既有專案保留公開、新專案預設未發布");

  console.log("publish-boundary: all assertions passed");
} finally {
  globalThis.fetch = originalFetch;
}
