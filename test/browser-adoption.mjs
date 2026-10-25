import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const { Miniflare } = createRequire(import.meta.resolve("wrangler"))("miniflare");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const results = { localOnly: true, realWorker: "workerd with isolated local D1/R2", controls: [], errors: [],
  unexpectedBrowserEgress: [], bridgeErrors: [], actualProviderCalls: 0, mockedTextCalls: 0, mockedTurnstileCalls: 0, apiRequests: 0 };
results.source = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) };
const token = "ab".repeat(32), projectId = "owned-browser-fixture";
const tokenHash = createHash("sha256").update(token).digest("hex");
const deck = (label) => `<!doctype html><html><head><style>html,body{margin:0;width:1920px;height:1080px}.slide{width:1920px;height:1080px;padding:80px;box-sizing:border-box;font:36px Arial}h1{font-size:72px}</style></head><body><section class="slide"><h1>${label}</h1><p>Owned synthetic publication fixture. No customer facts or external assets.</p></section><section class="slide"><h1>Second slide</h1></section><section class="slide"><h1>Third slide</h1></section><script>globalThis.deckScriptRan=true<\/script></body></html>`;
let mf, browser, server, origin, failNextRead = false, beforePut, mockHtml = deck("DRAFT_REVISION"), heldSave, releaseHeldSave;
const started = Date.now();
async function assets(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const path = resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
  const rel = relative(publicDir, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return new Response(null, { status: 404 });
  try {
    const content = await readFile(path);
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(path)] || "application/octet-stream";
    return new Response(content, { headers: { "content-type": `${type};charset=utf-8` } });
  } catch { return new Response(null, { status: 404 }); }
}
async function control(name, run) { await run(); results.controls.push(name); process.stderr.write(`PASS ${name}\n`); }
async function waitFor(predicate, detail) {
  const until = Date.now() + 10000;
  while (!predicate() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate(), detail);
}
try {
  mf = new Miniflare({ modules: true, scriptPath: resolve(root, "test/fixtures/browser-worker.js"), modulesRoot: root,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }, { type: "Text", include: ["**/*.md"] }],
    compatibilityDate: "2026-07-29", d1Databases: ["DB"], r2Buckets: ["BUCKET"],
    bindings: { MINIMAX_API_KEY: "local-fixture-only", TURNSTILE_SECRET_KEY: "local-fixture-only", IP_SALT: "local-fixture-only",
      LIMIT_IP_PROJECTS: "10", LIMIT_GLOBAL_PROJECTS: "20", LIMIT_GLOBAL_TEXT: "40", LIMIT_GLOBAL_IMAGES: "40",
      LIMIT_PROJECT_REVISES: "20", LIMIT_PROJECT_IMAGES: "20", LIMIT_PROJECT_RETRIES: "3" },
    serviceBindings: {
      ASSETS: assets,
      BEFORE_PUT: async (request) => { await beforePut?.(decodeURIComponent(new URL(request.url).pathname.slice(1))); return new Response(null, { status: 204 }); },
      BEFORE_GET: () => { const fail = failNextRead; failNextRead = false; return new Response(null, { status: fail ? 503 : 204 }); },
    },
    outboundService: (request) => {
      const url = new URL(request.url);
      if (url.href === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
        results.mockedTurnstileCalls++; return Response.json({ success: true });
      }
      assert.equal(url.href, "https://api.minimax.io/v1/chat/completions", "all Worker outbound requests are intercepted; no provider connection");
      results.mockedTextCalls++;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: mockHtml } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const db = await mf.getD1Database("DB"), bucket = await mf.getR2Bucket("BUCKET");
  const schema = await readFile(resolve(root, "schema.sql"), "utf8");
  for (const statement of schema.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare("INSERT INTO projects(id,brief,access_token_hash,current_version,status) VALUES(?1,'Owned browser fixture',?2,1,'ready')").bind(projectId, tokenHash).run();
  await db.prepare("INSERT INTO versions(project_id,version,r2_key,origin,created_at) VALUES(?1,1,?2,'fixture',?3)").bind(projectId, `decks/${projectId}/1.html`, Date.now()).run();
  await bucket.put(`decks/${projectId}/1.html`, deck("RELEASE_V1"));
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  await db.prepare("INSERT INTO quotas(scope,day,count) VALUES('global:text',?1,7)").bind(day).run();
  await db.prepare("INSERT INTO quotas(scope,day,count) VALUES(?1,'all',2)").bind(`proj:${projectId}:revises`).run();
  server = createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert.ok(length <= 3 * 1024 * 1024); chunks.push(chunk); }
      if (request.url.startsWith("/api/")) results.apiRequests++;
      const init = { method: request.method,
        headers: { ...request.headers, "CF-Connecting-IP": "127.0.0.1" },
        ...(["GET", "HEAD"].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) };
      // Match Wrangler assets.run_worker_first; workerd handles the API/player,
      // while unchanged public files are served through the platform asset path.
      const result = /^\/(api|img|p)(\/|$)/.test(new URL(request.url, origin).pathname)
        ? await mf.dispatchFetch(`${origin}${request.url}`, init)
        : await assets(new Request(`${origin}${request.url}`, init));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        const reader = result.body.getReader();
        while (true) { const chunk = await reader.read(); if (chunk.done) break; response.write(chunk.value); }
      }
      response.end();
    } catch {
      results.bridgeErrors.push("Local bridge failure");
      if (!response.headersSent) response.writeHead(500);
      response.end("Local bridge failure");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"] });
  results.browser = browser.version();
  const owner = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1100 } });
  const anonymous = await browser.newContext({ serviceWorkers: "block" });
  for (const context of [owner, anonymous]) {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://challenges.cloudflare.com/turnstile/v0/api.js") {
        await route.fulfill({ contentType: "text/javascript", body: "globalThis.turnstile={render(_box,o){o.callback('local-turnstile-fixture');return 1},reset(){}}" }); return;
      }
      if (url.origin !== origin) { results.unexpectedBrowserEgress.push(url.origin); await route.abort(); return; }
      await route.continue();
    });
  }
  await owner.addInitScript(({ projectId, token }) => sessionStorage.setItem(`minideck:project-token:${projectId}`, token), { projectId, token });
  const page = await owner.newPage(), publicPage = await anonymous.newPage();
  for (const p of [page, publicPage]) p.on("pageerror", (error) => results.errors.push(error.message));
  const state = () => db.prepare("SELECT current_version,published_version,status FROM projects WHERE id=?1").bind(projectId).first();
  const quota = async () => (await db.prepare("SELECT scope,day,count FROM quotas ORDER BY scope,day").all()).results;
  const idle = () => page.waitForFunction(() => document.querySelector("#brief-form").getAttribute("aria-busy") === "false");
  const ready = async () => { await page.goto(`${origin}/#p=${projectId}`); await page.waitForFunction(() => document.querySelector("[data-preview-version]").textContent.includes("v1")); };
  await control("unpublished draft is owner-only in real Worker and anonymous browser", async () => {
    await ready(); assert.equal((await publicPage.goto(`${origin}/p/${projectId}`)).status(), 404);
    assert.equal(await publicPage.evaluate(async ({ id }) => (await fetch(`/api/projects/${id}/preview`)).status, { id: projectId }), 403);
    assert.equal((await state()).published_version, null);
  });
  await control("native nested preview navigates three slides and blocks deck JavaScript", async () => {
    await page.locator("#btn-player-preview").click();
    const player = page.frameLocator("#player-preview iframe");
    await player.locator("#play-counter").filter({ hasText: "1 / 3" }).waitFor();
    await player.locator("#play-stage").press("ArrowRight");
    await player.locator("#play-counter").filter({ hasText: "2 / 3" }).waitFor();
    assert.equal(await player.frameLocator("#play-deck").locator("[data-md-active]").count(), 1);
    assert.equal(await player.frameLocator("#play-deck").locator("html").evaluate(() => globalThis.deckScriptRan === true), false);
    await page.locator("#player-preview button").click();
  });
  await control("explicit UI publish pins anonymous release and returns a real D1 receipt", async () => {
    await page.locator("#btn-publish").click();
    await page.locator("#publication-feedback").filter({ hasText: "已發布 v1" }).waitFor();
    assert.equal((await state()).published_version, 1);
    assert.equal((await publicPage.goto(`${origin}/p/${projectId}`)).status(), 200);
    assert.match(await publicPage.locator("#deck-source").inputValue(), /RELEASE_V1/);
  });
  await control("real R2 read failure refunds only new quota and releases the project for UI retry", async () => {
    const before = await quota(); failNextRead = true;
    await page.locator("#chat-input").fill("請更新草稿，保留已發布版本");
    await page.locator("#chat-submit").click(); await idle();
    await page.locator("#chat-log").filter({ hasText: "服務處理失敗" }).waitFor();
    assert.equal((await state()).status, "ready"); assert.deepEqual(await quota(), before);
    assert.equal(results.mockedTextCalls, 0); assert.equal(await page.locator("#chat-input").inputValue(), "請更新草稿，保留已發布版本");
  });
  await control("native revision click reaches Worker SSE and keeps public head pinned", async () => {
    await page.locator("#chat-submit").click();
    await waitFor(() => results.mockedTextCalls > 0, "revision must reach mocked model transport"); await idle();
    const current = await state(); assert.ok(current.current_version > 1); assert.equal(current.published_version, 1);
    await publicPage.goto(`${origin}/p/${projectId}`);
    assert.match(await publicPage.locator("#deck-source").inputValue(), /RELEASE_V1/);
    assert.doesNotMatch(await publicPage.locator("#deck-source").inputValue(), /DRAFT_REVISION/);
  });
  await control("publish during actual in-flight R2 save rejects and preserves the public snapshot", async () => {
    let release, entered = false;
    heldSave = new Promise((resolve) => { release = resolve; releaseHeldSave = resolve; });
    beforePut = async () => { entered = true; await heldSave; };
    await page.evaluate(({ id, html }) => { globalThis.pendingSave = MD.api.saveDeck(id, html).then(() => { globalThis.saveFinished = true; }); }, { id: projectId, html: deck("CONCURRENT_DRAFT") });
    await waitFor(() => entered, "native Worker must pause before its actual R2 put");
    await page.locator("#btn-publish").click();
    await page.locator("#publication-feedback").filter({ hasText: "失敗" }).waitFor();
    assert.equal((await state()).published_version, 1);
    release(); releaseHeldSave = undefined; heldSave = undefined; beforePut = undefined;
    await page.waitForFunction(() => globalThis.saveFinished);
    await page.reload(); await page.waitForFunction(() => document.querySelector("#btn-publish").disabled === false);
    await page.locator("#btn-publish").click();
    await page.locator("#publication-feedback").filter({ hasText: "已發布" }).waitFor();
    const current = await state(); assert.equal(current.published_version, current.current_version);
    await publicPage.goto(`${origin}/p/${projectId}`);
    assert.match(await publicPage.locator("#deck-source").inputValue(), /CONCURRENT_DRAFT/);
  });
  await control("native rollback stays a draft until another explicit publish", async () => {
    const published = (await state()).published_version;
    await page.locator('button[data-version="1"]').click();
    await page.waitForFunction(() => !document.querySelector("#btn-publish").disabled);
    const current = await state(); assert.ok(current.current_version > published); assert.equal(current.published_version, published);
    await publicPage.goto(`${origin}/p/${projectId}`); assert.match(await publicPage.locator("#deck-source").inputValue(), /CONCURRENT_DRAFT/);
  });
  await control("native unpublish revokes anonymous access while owner versions remain", async () => {
    await page.locator("#btn-unpublish").click();
    await page.locator("#publication-feedback").filter({ hasText: "已下線" }).waitFor();
    assert.equal((await publicPage.goto(`${origin}/p/${projectId}`)).status(), 404);
    assert.equal((await state()).published_version, null);
    assert.ok((await db.prepare("SELECT count(*) AS n FROM versions WHERE project_id=?1").bind(projectId).first()).n > 1);
  });
  await control("native brief boundary preserves the page suffix and wrong owner cannot publish", async () => {
    const maximum = await page.locator("#brief-input").evaluate((input) => input.maxLength); assert.equal(maximum, 1989);
    await page.locator("#brief-input").fill("字".repeat(maximum));
    assert.equal(await page.locator("#brief-input").evaluate((input) => input.checkValidity()), true);
    await page.locator("#page-count").selectOption("5");
    assert.equal(await page.locator("#brief-input").evaluate((input) => input.maxLength), 1990);
    const status = await publicPage.evaluate(async (id) => (await fetch(`/api/projects/${id}/publish`, { method: "POST", headers: { "content-type": "application/json", "X-Project-Token": "cd".repeat(32) }, body: JSON.stringify({ version: 1 }) })).status, projectId);
    assert.equal(status, 403); assert.equal((await state()).published_version, null);
  });
  await control("project deletion cleans actual local D1/R2 and keeps anonymous URLs invalid", async () => {
    const response = await mf.dispatchFetch(`${origin}/api/projects/${projectId}`, { method: "DELETE", headers: { "X-Project-Token": token } });
    assert.equal(response.status, 200); assert.equal(await state(), null);
    assert.equal((await bucket.list({ prefix: `decks/${projectId}/` })).objects.length, 0);
    assert.equal((await publicPage.goto(`${origin}/p/${projectId}`)).status(), 404);
  });
  assert.deepEqual(results.errors, []); assert.deepEqual(results.bridgeErrors, []); assert.deepEqual(results.unexpectedBrowserEgress, []); assert.equal(results.actualProviderCalls, 0);
  results.ok = true;
} catch (error) { results.ok = false; results.failure = error.stack; process.exitCode = 1; }
finally {
  releaseHeldSave?.(); beforePut = undefined;
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mf) await mf.dispose();
  results.elapsedMs = Date.now() - started;
  if (process.env.MINIDECK_BROWSER_REPORT) await writeFile(process.env.MINIDECK_BROWSER_REPORT, JSON.stringify(results, null, 2) + "\n");
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
}
