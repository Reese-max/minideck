import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const deck = '<!doctype html><html><head></head><body><section class="slide"><h1>Offline deck</h1></section></body></html>';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate, detail) {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await tick();
  assert.ok(predicate(), detail);
}

function browser({ project = false, report = { fails: [], warns: [] }, holdRevision = false, revisionError = false } = {}) {
  const dom = new JSDOM(shell, { url: `https://minideck.test/${project ? "#p=owned-project" : ""}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const calls = [], errors = [];
  let version = project ? 1 : 0, turnstileCallback, resolveRevision;
  window.console = { log() {}, error(...args) { errors.push(args); } };
  window.TextDecoder = TextDecoder;
  window.alert = () => {};
  window.turnstile = { render(_box, options) { turnstileCallback = options.callback; return 1; }, reset() {} };
  window.sessionStorage.setItem("minideck:project-token:owned-project", "offline-owner-token");
  const frame = window.document.querySelector("#deck-frame");
  // jsdom does not navigate srcdoc; preserve the real iframe document and dispatch
  // its load event after writing the offline deck, as a browser would.
  Object.defineProperty(frame, "srcdoc", { set(value) {
    frame.contentDocument.open(); frame.contentDocument.write(value); frame.contentDocument.close();
    queueMicrotask(() => frame.dispatchEvent(new window.Event("load")));
  } });
  const complete = (nextVersion) => new Response(`event: done\ndata: ${JSON.stringify({ version: nextVersion })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  window.fetch = async (path, options = {}) => {
    const method = options.method || "GET";
    calls.push({ path, method, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers });
    if (path === "/api/quota") return Response.json({ ipRemaining: { projects: 3 }, globalRemaining: { projects: 3 } });
    if (path === "/api/projects" && method === "POST") return Response.json({ id: "owned-project", token: "offline-owner-token" });
    if (path === "/api/projects/owned-project") return Response.json({ versions: version ? [{ version, origin: "generate", created_at: 0 }] : [], messages: [] });
    if (path.startsWith("/api/projects/owned-project/deck") && method === "GET") return new Response(deck);
    if (path === "/api/projects/owned-project/generate") return complete(++version);
    if (path === "/api/projects/owned-project/revise") {
      if (holdRevision) await new Promise((resolve) => { resolveRevision = resolve; });
      if (revisionError) return Response.json({ error: "離線修訂失敗" }, { status: 502 });
      return complete(++version);
    }
    if (path === "/api/projects/owned-project/deck" && method === "POST") return Response.json({ version: ++version });
    throw new Error(`Unexpected offline request: ${method} ${path}`);
  };
  window.eval(script);
  // Geometry is outside these handler contracts; transport, inputs, state changes,
  // iframe load, version refresh and DOM messages still execute production code.
  window.MD.audit.run = () => report;
  const $ = (selector) => window.document.querySelector(selector);
  return {
    window, $, calls, errors, close: () => window.close(),
    verify: () => turnstileCallback("offline-turnstile"),
    releaseRevision: () => resolveRevision(),
    reviseCalls: () => calls.filter((call) => call.path.endsWith("/revise")),
    createCalls: () => calls.filter((call) => call.path === "/api/projects"),
    ready: () => until(() => $("[data-preview-version]").textContent.includes("v1"), "owned deck should finish resuming"),
    idle: () => until(() => $("#brief-form").getAttribute("aria-busy") === "false", "operation should release busy state"),
    input(selector, value) { $(selector).value = value; $(selector).dispatchEvent(new window.Event("input", { bubbles: true })); },
    submit() { $("#brief-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
  };
}

test("revision composer is disabled without a deck and sends no request", async () => {
  const b = browser();
  try {
    b.input("#chat-input", "修改結論");
    const button = b.$('[aria-label="送出修訂"]');
    assert.equal(button.disabled, true);
    button.dispatchEvent(new b.window.Event("click")); await tick();
    assert.equal(b.reviseCalls().length, 0);
  } finally { b.close(); }
});

test("revision click sends owner-bound input once, updates messages and reloads the saved deck", async () => {
  const b = browser({ project: true, holdRevision: true });
  try {
    await b.ready();
    const message = '<img src=x onerror=alert(1)> 請調整結論';
    b.input("#chat-input", message);
    const button = b.$('[aria-label="送出修訂"]');
    assert.equal(button.disabled, false);
    button.click();
    await until(() => b.reviseCalls().length === 1, "click should invoke the revision API");
    assert.deepEqual(b.reviseCalls()[0].body, { message });
    assert.equal(b.reviseCalls()[0].headers["X-Project-Token"], "offline-owner-token");
    assert.equal(button.disabled, true); assert.equal(b.$("#chat-input").disabled, true);
    button.dispatchEvent(new b.window.Event("click")); await tick();
    assert.equal(b.reviseCalls().length, 1, "busy click must not dispatch twice");
    assert.ok(b.$("#chat-log").textContent.includes(message));
    assert.equal(b.$("#chat-log img"), null, "user messages must be text, not markup");
    b.releaseRevision(); await b.idle();
    assert.match(b.$("#chat-log .assistant-message:last-child").textContent, /v3/);
    assert.equal(b.$("#chat-input").value, "");
    assert.match(b.$("[data-preview-version]").textContent, /v3/);
    assert.ok(b.calls.some((call) => call.path === "/api/projects/owned-project/deck" && call.method === "POST"));
  } finally { b.close(); }
});

test("revision failure remains visible and leaves the instruction available to retry", async () => {
  const b = browser({ project: true, revisionError: true });
  try {
    await b.ready(); b.input("#chat-input", "重寫摘要"); b.$('[aria-label="送出修訂"]').click();
    await until(() => b.reviseCalls().length === 1, "revision should be attempted"); await b.idle();
    assert.match(b.$("#chat-log").textContent, /離線修訂失敗/);
    assert.equal(b.$("#chat-input").value, "重寫摘要");
    assert.equal(b.$('[aria-label="送出修訂"]').disabled, false);
  } finally { b.close(); }
});

test("brief maxlength includes the page suffix and the exact displayed boundary can create a project", async () => {
  const b = browser();
  try {
    b.verify();
    const input = b.$("#brief-input");
    assert.equal(input.maxLength, 1989);
    b.input("#brief-input", "字".repeat(input.maxLength)); b.submit();
    await until(() => b.createCalls().length === 1, "maximum permitted brief should be sent"); await b.idle();
    assert.equal([...b.createCalls()[0].body.brief].length, 2000);
    assert.ok(b.createCalls()[0].body.brief.endsWith("\n\n請產生 12 頁。"));
  } finally { b.close(); }
});

test("brief over the boundary is explained before dispatch, and page changes update the limit", async () => {
  const b = browser();
  try {
    b.verify();
    const pages = b.$("#page-count");
    pages.value = "5"; pages.dispatchEvent(new b.window.Event("change"));
    assert.equal(b.$("#brief-input").maxLength, 1990);
    b.input("#brief-input", "字".repeat(1990));
    pages.value = "12"; pages.dispatchEvent(new b.window.Event("change"));
    assert.equal(b.$("#brief-input").maxLength, 1989);
    assert.equal(b.$("#brief-input").checkValidity(), false);
    assert.match(b.$("#brief-limit").textContent, /1989/);
    b.submit(); await tick();
    assert.equal(b.createCalls().length, 0);
    assert.match(b.$('[data-stage="generate"] p').textContent, /1989/);
  } finally { b.close(); }
});

test("optimize click submits a bounded prompt for twelve pages with five WARNs each", async () => {
  const warns = Array.from({ length: 60 }, (_, i) => ({ slide: Math.floor(i / 5) + 1, type: "font-min", detail: `第${Math.floor(i / 5) + 1}頁：內文字級 16px 落在 13–16px 警示區間：「營收成長」` }));
  const b = browser({ project: true, report: { fails: [], warns } });
  try {
    await b.ready(); b.$("#btn-optimize").click();
    await until(() => b.reviseCalls().length === 1, "optimize should invoke revision"); await b.idle();
    const { message } = b.reviseCalls()[0].body;
    assert.ok([...message].length <= 1000, `optimize sent ${[...message].length} characters`);
    assert.match(message, /目前稽核 WARN 清單/);
    assert.match(message, /不要新增或清空圖片佔位符/);
  } finally { b.close(); }
});
