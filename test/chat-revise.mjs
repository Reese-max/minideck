import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

class Element {
  children = [];
  selectors = new Map();
  listeners = new Map();
  dataset = {};
  style = {};
  value = "";
  disabled = false;
  className = "";
  textContent = "";
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  querySelector(selector) {
    return this.selectors.get(selector) ?? this.children.find((child) =>
      child.className.split(" ").includes(selector.slice(1))) ?? null;
  }
  querySelectorAll() { return []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set innerHTML(value) { this.children = []; this.markup = value; }
  get innerHTML() { return this.markup ?? ""; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  async fire(type) {
    if (this.disabled && type === "click") return;
    await Promise.all((this.listeners.get(type) ?? []).map((callback) =>
      callback({ preventDefault() {} })));
  }
  set srcdoc(value) { this.deckHtml = value; queueMicrotask(() => this.fire("load")); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});
const done = () => new Response('event: done\ndata: {"version":2}\n\n', {
  headers: { "content-type": "text/event-stream" },
});

async function mount({ project = true, versions = true, revise = done, turnstile = false, audit } = {}) {
  const document = new Element();
  document.createElement = () => new Element();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    document.selectors.set(`#${id}`, new Element());
  }
  assert.match(html, /data-preview-version/);
  document.selectors.set("[data-preview-version]", new Element());
  const get = (selector) => document.querySelector(selector);
  const nest = (parent, selector) => {
    const element = new Element();
    get(parent).selectors.set(selector, element);
    return element;
  };
  nest("#brief-form", 'button[type="submit"]');
  nest("#hq-result", ".hq-result-body");
  nest("#version-list", ".version-rows");
  for (const selector of [".iterate-status", ".iterate-quota", ".iterate-rounds"]) {
    nest("#iterate-panel", selector);
  }
  for (const selector of [".audit-summary", ".audit-list"]) {
    document.selectors.set(selector, nest("#audit-report", selector));
  }
  assert.match(html, /class="chat-composer"[\s\S]*?<button[^>]*aria-label="送出修訂"/);
  const button = new Element();
  document.selectors.set('.chat-composer button', button);
  let turnstileCallbacks;
  if (turnstile) {
    const meta = new Element();
    meta.content = "test-sitekey";
    document.selectors.set('meta[name="turnstile-sitekey"]', meta);
  }
  get("#deck-frame").contentDocument = new Element();
  let version = versions ? 1 : 0;
  const requests = [];
  const storage = new Map();
  const context = {
    document, Response, TextDecoder, URLSearchParams,
    location: { hash: project ? "#p=project" : "" },
    console: { log() {}, error() {} },
    addEventListener() {},
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    turnstile: turnstile ? {
      render(_element, callbacks) {
        turnstileCallbacks = callbacks;
        callbacks.callback("test-token");
        return 0;
      },
    } : undefined,
    fetch: async (path, init = {}) => {
      requests.push({ path, ...init });
      if (path === "/api/quota") return new Response(null, { status: 503 });
      if (path === "/api/projects/project/revise") return revise();
      if (path === "/api/projects/project") return json({
        versions: version ? [{ version, origin: "generate", created_at: "2026-10-25" }] : [],
        messages: [],
      });
      if (path === "/api/projects/project/deck" && init.method === "POST") {
        version = 3;
        return json({ version });
      }
      if (path.startsWith("/api/projects/project/deck?version=")) {
        return new Response("<!doctype html><section class=\"slide\">修訂後</section>");
      }
      throw new Error(`Unexpected fetch: ${path}`);
    },
  };
  vm.runInNewContext(source, context, { filename: "public/app.js" });
  if (audit) context.MD.audit.run = audit;
  await settle();
  await settle();
  return { get, button, requests, turnstileCallbacks };
}

test("chat click posts the input to revise and refreshes preview, versions and messages", async () => {
  const { get, button, requests } = await mount();
  const input = get("#chat-input");
  input.value = "第 2 頁標題更精簡 <img src=x onerror=alert(1)>";
  const message = input.value;
  await button.fire("click");
  const request = requests.find(({ path }) => path.endsWith("/revise"));
  assert.equal(request?.path, "/api/projects/project/revise");
  assert.equal(request.method, "POST");
  assert.equal(JSON.parse(request.body).message, message);
  const log = get("#chat-log");
  assert.equal(log.children[0].className, "message user-message");
  assert.equal(log.children[0].children[0].textContent, message);
  assert.equal(log.children[0].children[0].children.length, 0, "user input stays plain text");
  assert.equal(log.children[1].className, "message assistant-message");
  assert.match(log.children[1].children[0].textContent, /修訂.*v3/);
  assert.equal(get("[data-preview-version]")?.textContent, "版本 v3");
  assert.ok(get("#version-list").querySelector(".version-rows").children.length);
  assert.equal(input.value, "");
  assert.equal(button.disabled, false);
  input.value = "再縮短結論";
  await button.fire("click");
  assert.equal(log.children.length, 4, "later revisions preserve the conversation");
});

test("chat is disabled without a project or deck and ignores blank input", async () => {
  for (const options of [{ project: false }, { versions: false }]) {
    const { get, button, requests } = await mount(options);
    get("#chat-input").value = "縮短標題";
    assert.equal(button.disabled, true);
    await button.fire("click");
    await button.listeners.get("click")[0]();
    assert.equal(requests.some(({ path }) => path.endsWith("/revise")), false);
  }
  const { get, button, requests } = await mount();
  get("#chat-input").value = "   ";
  await button.fire("click");
  assert.equal(requests.some(({ path }) => path.endsWith("/revise")), false);
});

test("chat is disabled while revising and prevents duplicate submissions", async () => {
  let finish;
  const { get, button, requests } = await mount({
    revise: () => new Promise((resolve) => { finish = () => resolve(done()); }),
  });
  get("#chat-input").value = "縮短標題";
  const pending = button.fire("click");
  await settle();
  assert.equal(button.disabled, true);
  assert.equal(get("#chat-input").disabled, true);
  // Invoke the listener directly as well, so the busy guard is tested independently.
  await button.listeners.get("click")[0]();
  assert.equal(requests.filter(({ path }) => path.endsWith("/revise")).length, 1);
  finish();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(get("#chat-input").disabled, false);
});

test("HTTP and SSE failures appear in chat and allow retry without losing the input", async () => {
  for (const revise of [
    () => new Response(JSON.stringify({ error: "今日額度已滿" }), { status: 429 }),
    () => new Response('event: error\ndata: {"message":"今日額度已滿"}\n\n'),
  ]) {
    const { get, button } = await mount({ revise });
    get("#chat-input").value = "保留數據";
    await button.fire("click");
    const reply = get("#chat-log").children.at(-1);
    assert.match(reply.children[0].textContent, /今日額度已滿/);
    assert.equal(get("#chat-input").value, "保留數據");
    assert.equal(button.disabled, false);
  }
});

test("Turnstile token callbacks preserve the busy revision lock", async () => {
  for (const callback of ["callback", "expired-callback", "error-callback"]) {
    let finish;
    const { get, button, requests, turnstileCallbacks } = await mount({
      turnstile: true,
      revise: () => new Promise((resolve) => { finish = () => resolve(done()); }),
    });
    get("#chat-input").value = "縮短標題";
    const pending = button.fire("click");
    await settle();
    try {
      turnstileCallbacks[callback]("renewed-token");
      assert.equal(button.disabled, true, `${callback} must not unlock the revision`);
      assert.equal(get("#chat-input").disabled, true);
      await button.listeners.get("click")[0]();
      assert.equal(requests.filter(({ path }) => path.endsWith("/revise")).length, 1);
    } finally {
      finish();
      await pending;
    }
    assert.equal(button.disabled, false);
  }
});

test("chat stays disabled through automatic revision while resuming a project", async () => {
  let finish;
  const { get, button, requests } = await mount({
    audit: () => ({ fails: [], warns: [{ type: "numbers", detail: "數字過多" }] }),
    revise: () => new Promise((resolve) => { finish = () => resolve(done()); }),
  });
  try {
    assert.equal(requests.filter(({ path }) => path.endsWith("/revise")).length, 1);
    assert.equal(button.disabled, true, "resume must hold the busy lock until auto-revision completes");
    get("#chat-input").value = "縮短標題";
    await button.listeners.get("click")[0]();
    assert.equal(requests.filter(({ path }) => path.endsWith("/revise")).length, 1);
  } finally {
    finish();
    await settle();
    await settle();
  }
  assert.equal(button.disabled, false);
});
