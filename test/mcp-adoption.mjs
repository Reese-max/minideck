// Actual bundled MCP handler in local workerd, with native D1/R2. Opaque tokens
// below are owned fixtures, not a claim that GitHub OAuth or cloud deployment ran.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPreviewConfigs, ownedStudioSeed } from "../scripts/isolated-preview.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = resolve(root, "workers/presentation-studio-mcp");
const { Miniflare, convertV4MiniflareOptions } = createRequire(resolve(worker, "node_modules/wrangler/package.json"))("miniflare");
const plan = { scope: "minideck-qa-native01", siteD1Id: "11111111-1111-4111-8111-111111111111",
  studioD1Id: "22222222-2222-4222-8222-222222222222", bucket: "minideck-qa-native01-assets" };
const result = { localOnly: true, runtime: "actual bundled MCP in workerd with native isolated D1/R2", controls: [],
  source: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) },
  outboundRequests: 0, actualProviderCalls: 0, realOAuth: false, cloudWrites: 0 };
let mf, serial = 0;
async function control(name, run) { await run(); result.controls.push(name); console.error(`PASS ${name}`); }
const token = (owner) => `owned-local-native-token-${owner}-` + "x".repeat(32);
const hash = (text) => createHash("sha256").update(text).digest("hex");
try {
  execFileSync(process.execPath, [resolve(worker, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", ".wrangler/adoption-mcp"],
    { cwd: worker, env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" }, stdio: "pipe" });
  const config = buildPreviewConfigs(plan).mcp;
  result.compatibilityDate = config.compatibility_date; result.compatibilityFlags = config.compatibility_flags;
  mf = new Miniflare(convertV4MiniflareOptions({ name: "owned-native-mcp", modules: true, scriptPath: resolve(worker, ".wrangler/adoption-mcp/index.js"),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, d1Databases: ["DB"], r2Buckets: ["BUCKET"],
    bindings: { ...config.vars, MCP_ALLOWED_HOSTNAMES: "owned.invalid,127.0.0.1" },
    outboundService: () => { result.outboundRequests++; throw new Error("No outbound transport allowed in native fixture"); } }));
  const db = await mf.getD1Database("DB"), bucket = await mf.getR2Bucket("BUCKET");
  const apply = async (sql) => { for (const statement of sql.replace(/^--.*$/gm, "").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run(); };
  await apply(await readFile(resolve(worker, "migrations/0001_init.sql"), "utf8"));
  await apply(ownedStudioSeed(plan));
  for (const owner of [42, 43]) await db.prepare("INSERT INTO presentation_oauth_tokens(access_token_hash,refresh_token_hash,owner_login,scopes_json,access_expires_at,refresh_expires_at) VALUES(?1,?2,?3,?4,?5,?6)")
    .bind(hash(token(owner)), hash(`owned-refresh-${owner}`), `github:${owner}`, '["presentation:read","presentation:write"]', new Date(Date.now() + 60000).toISOString(), new Date(Date.now() + 120000).toISOString()).run();
  const rpc = async (owner, method, params = {}) => {
    const response = await mf.dispatchFetch("https://owned.invalid/mcp", { method: "POST", headers: { authorization: `Bearer ${token(owner)}`,
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28",
      "mcp-method": method, ...(params.name ? { "mcp-name": params.name } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "owned-local-fixture", version: "1" } } } }) });
    assert.equal(response.status, 200, `${method}: ${await response.clone().text()}`);
    const text = await response.text();
    return response.headers.get("content-type").includes("text/event-stream")
      ? JSON.parse(text.split("\n").find((s) => s.startsWith("data: ")).slice(6)) : JSON.parse(text);
  };
  const payload = (rpcResult) => { assert.equal(rpcResult.error, undefined); assert.equal(rpcResult.result.isError, undefined); return JSON.parse(rpcResult.result.content[0].text); };
  await control("health and authentication fail closed without provider transport", async () => {
    const health = await (await mf.dispatchFetch("https://owned.invalid/health")).json();
    assert.equal(health.phase, "A"); assert.equal(health.renderer, "dashi");
    assert.equal((await mf.dispatchFetch("https://owned.invalid/mcp", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await mf.dispatchFetch("https://owned.invalid/mcp", { headers: { authorization: "Bearer invalid" } })).status, 401);
  });
  await control("real modern Streamable HTTP MCP lists all eight tools and the owned profile", async () => {
    assert.equal((await rpc(42, "tools/list")).result.tools.length, 8);
    assert.equal(payload(await rpc(42, "tools/call", { name: "list_presentation_profiles", arguments: {} })).profiles[0].id, `${plan.scope}-profile`);
  });
  let first, second;
  const args = { title: "Owned synthetic native project", brief: "No customer or provider content. Queue only.", requestedFormats: ["html"], idempotencyKey: "owned-same-key-123" };
  await control("same owner idempotency reuses one native job and real R2 source map", async () => {
    first = payload(await rpc(42, "tools/call", { name: "create_presentation", arguments: args }));
    const repeat = payload(await rpc(42, "tools/call", { name: "create_presentation", arguments: args }));
    assert.equal(first.projectId, repeat.projectId);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM presentation_jobs").first()).n, 1);
    assert.equal((await bucket.list()).objects.length, 1);
  });
  await control("distinct immutable owners separate same key and deny cross-owner project reads", async () => {
    second = payload(await rpc(43, "tools/call", { name: "create_presentation", arguments: args }));
    assert.notEqual(first.projectId, second.projectId);
    const denied = await rpc(43, "tools/call", { name: "get_presentation", arguments: { projectId: first.projectId } });
    assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /PROJECT_NOT_FOUND/);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM presentation_jobs").first()).n, 2);
  });
  await control("revocation rejects cached idempotent calls before any mutation", async () => {
    await db.prepare("UPDATE presentation_oauth_tokens SET revoked_at=datetime('now') WHERE owner_login='github:42'").run();
    const response = await mf.dispatchFetch("https://owned.invalid/mcp", { method: "POST", headers: { authorization: `Bearer ${token(42)}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "create_presentation", arguments: args } }) });
    assert.equal(response.status, 401); assert.equal((await db.prepare("SELECT count(*) AS n FROM presentation_jobs").first()).n, 2);
  });
  await control("native OAuth rejects oversized body before client inserts and accepts small fixture", async () => {
    const content = { client_name: "Owned fixture", redirect_uris: ["https://example.invalid/callback"] };
    const before = (await db.prepare("SELECT count(*) AS n FROM presentation_oauth_clients").first()).n;
    const large = await mf.dispatchFetch("https://owned.invalid/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...content, padding: "x".repeat(33000) }) });
    assert.equal(large.status, 400); assert.equal((await db.prepare("SELECT count(*) AS n FROM presentation_oauth_clients").first()).n, before);
    assert.equal((await mf.dispatchFetch("https://owned.invalid/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(content) })).status, 201);
  });
  assert.equal(result.outboundRequests, 0); result.status = "PASS";
} catch (error) { result.status = "FAIL"; result.error = error.stack; process.exitCode = 1; }
finally {
  try { await mf?.dispose(); } catch (error) { result.cleanupError = error.message; result.status = "FAIL"; process.exitCode = 1; }
  if (process.env.MCP_ADOPTION_REPORT) await writeFile(process.env.MCP_ADOPTION_REPORT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
