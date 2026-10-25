import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith(".ts") && /^\.\.?\/[^.]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { handleOAuthRequest } = await import("../src/auth.ts");
const { sha256Hex } = await import("../src/crypto.ts");
hooks.deregister();
const schema = await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const LIMIT = 32 * 1024, refresh = "fixture-refresh-" + "a".repeat(48);

async function fixture() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(schema);
  let calls = 0;
  const DB = {
    prepare(sql) {
      let values = [];
      return { bind(...args) { values = args; return this; },
        async first() { calls++; return sqlite.prepare(sql).get(...values) ?? null; },
        async run() { calls++; return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const rows = []; for (const statement of statements) rows.push(await statement.run()); sqlite.exec("COMMIT"); return rows; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  await sqlite.prepare("INSERT INTO presentation_oauth_tokens(access_token_hash,refresh_token_hash,owner_login,scopes_json,access_expires_at,refresh_expires_at) VALUES(?,?,?,?,?,?)")
    .run(await sha256Hex("fixture-access"), await sha256Hex(refresh), "github:42", '["presentation:read","presentation:write"]', new Date(Date.now() + 60000).toISOString(), new Date(Date.now() + 120000).toISOString());
  return { sqlite, DB, calls: () => calls,
    clients: () => Number(sqlite.prepare("SELECT count(*) AS n FROM presentation_oauth_clients").get().n),
    tokens: () => Number(sqlite.prepare("SELECT count(*) AS n FROM presentation_oauth_tokens").get().n),
  };
}
function streamedRequest(path, content, { type = "application/json", declared, width = 8192, holdCancel = false } = {}) {
  const bytes = new TextEncoder().encode(content), stats = { cancelled: false, pulled: 0 };
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      stats.pulled++;
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + width); controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel() { stats.cancelled = true; if (holdCancel) return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  return { request: new Request(`https://owned.invalid/oauth/${path}`, { method: "POST", body, duplex: "half",
    headers: { "content-type": type, ...(declared === undefined ? {} : { "content-length": String(declared) }) } }), stats, bytes: bytes.length };
}
function registration(bytes, unicode = false) {
  const base = { client_name: unicode ? "節點😀 Fixture" : "Owned fixture", redirect_uris: ["https://example.invalid/callback"], padding: "" };
  const available = bytes - new TextEncoder().encode(JSON.stringify(base)).length;
  assert.ok(available >= 0);
  base.padding = unicode ? "😀".repeat(Math.floor(available / 4)) + "x".repeat(available % 4) : "x".repeat(available);
  const text = JSON.stringify(base); assert.equal(new TextEncoder().encode(text).length, bytes); return text;
}
for (const [name, options] of [
  ["headerless JSON", {}], ["understated length JSON", { declared: 1 }],
  ["headerless UTF8 JSON", { unicode: true, width: 7 }], ["declared oversized JSON", { declared: LIMIT + 1 }],
]) test(`OAuth rejects ${name} over32KiB before database effects and cancels remaining input`, async () => {
  const f = await fixture();
  try {
    const r = streamedRequest("register", registration(LIMIT + 1, options.unicode), options);
    const response = await handleOAuthRequest(r.request, { DB: f.DB });
    assert.equal(response.status, 400); assert.equal(f.clients(), 0); assert.equal(f.calls(), 0);
    assert.equal(r.stats.cancelled, true); assert.ok(r.stats.pulled <= Math.ceil(r.bytes / (options.width || 8192)));
  } finally { f.sqlite.close(); }
});
test("OAuth accepts exact-byte-limit Unicode registration split across UTF8 boundaries", async () => {
  const f = await fixture();
  try {
    const r = streamedRequest("register", registration(LIMIT, true), { width: 7 });
    const response = await handleOAuthRequest(r.request, { DB: f.DB });
    assert.equal(response.status, 201); assert.equal(f.clients(), 1); assert.equal(r.stats.cancelled, false);
  } finally { f.sqlite.close(); }
});
test("oversized form refresh is rejected before rotation while normal form and JSON retain semantics", async () => {
  const f = await fixture();
  try {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, padding: "x".repeat(LIMIT) }).toString();
    const r = streamedRequest("token", form, { type: "application/x-www-form-urlencoded", width: 4096 });
    assert.equal((await handleOAuthRequest(r.request, { DB: f.DB })).status, 400);
    assert.equal(f.calls(), 0); assert.equal(f.tokens(), 1); assert.equal(r.stats.cancelled, true);
    const small = streamedRequest("token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(), { type: "application/x-www-form-urlencoded", width: 13 });
    assert.equal((await handleOAuthRequest(small.request, { DB: f.DB })).status, 200);
    assert.equal(f.tokens(), 2);
    const register = streamedRequest("register", JSON.stringify({ client_name: "small", redirect_uris: ["https://example.invalid/callback"] }));
    assert.equal((await handleOAuthRequest(register.request, { DB: f.DB })).status, 201);
  } finally { f.sqlite.close(); }
});
test("rejection does not wait on an untrusted stream's non-settling cancel callback", async () => {
  const f = await fixture(); let timer;
  try {
    const r = streamedRequest("register", registration(LIMIT + 1), { holdCancel: true });
    const response = await Promise.race([handleOAuthRequest(r.request, { DB: f.DB }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Body rejection hung on cancel")), 1000); })]);
    assert.equal(response.status, 400); assert.equal(r.stats.cancelled, true); assert.equal(f.calls(), 0);
  } finally { clearTimeout(timer); f.sqlite.close(); }
});
