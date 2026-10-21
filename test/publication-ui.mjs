import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function editor() {
  const nodes = new Map();
  function node(key) {
    if (nodes.has(key)) return nodes.get(key);
    const listeners = new Map();
    const element = {
      value: "Fixture", textContent: "", disabled: false, checked: false, open: false,
      dataset: {}, style: {}, clientWidth: 960, clientHeight: 540,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      querySelector: (selector) => node(`${key} ${selector}`),
      querySelectorAll: () => [],
      createElement: (tag) => node(`${tag}-${nodes.size}`),
      append() {}, prepend() {}, replaceChildren() {}, remove() {},
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      addEventListener(event, callback, options) { listeners.set(event, { callback, once: options?.once }); },
      async fire(event) {
        const listener = listeners.get(event);
        if (listener?.once) listeners.delete(event);
        return listener?.callback({ preventDefault() {} });
      },
      showModal() { this.open = true; },
      close() { this.open = false; return this.fire("close"); },
      set srcdoc(html) { this.html = html; queueMicrotask(() => this.fire("load")); },
    };
    nodes.set(key, element);
    return element;
  }
  node("#deck-frame").contentDocument = node("deck-document");
  node("deck-document").head = node("deck-head");
  node('meta[name="turnstile-sitekey"]').content = "fixture-site-key";
  const project = {
    current_version: 2, published_version: 1, published_at: 1, messages: [],
    versions: [1, 2].map((version) => ({ version, origin: "generate", created_at: 1 })),
  };
  const context = {
    Response, URLSearchParams, TextDecoder, Blob, queueMicrotask,
    console: { log() {}, error(...args) { console.error(...args); } },
    document: { querySelector: node, querySelectorAll: () => [], createElement: (tag) => node(`${tag}-${nodes.size}`) },
    location: { hash: "#p=first", origin: "https://minideck.test" },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => "a".repeat(64), setItem() {} },
    turnstile: { render(_element, options) { options.callback("fixture"); return 0; }, reset() {} },
    addEventListener() {},
    async fetch(path, init = {}) {
      if (path === "/api/quota") return Response.json({ ipRemaining: { projects: 3 }, globalRemaining: { projects: 3 } });
      if (path === "/api/projects") return Response.json({ id: "second", token: "b".repeat(64) });
      if (path.includes("/generate")) return Response.json({ error: "Fixture generation failure" }, { status: 502 });
      if (path.includes("/deck")) return new Response("<html>draft</html>");
      if (path.includes("/preview")) return new Response("<html>player preview</html>");
      if (path.endsWith("/unpublish")) project.published_version = project.published_at = null;
      else if (path.endsWith("/publish")) {
        project.published_version = JSON.parse(init.body).version;
        project.published_at = 1000;
      }
      if (path.endsWith("/publish") || path.endsWith("/unpublish")) return Response.json({ published_version: project.published_version, published_at: project.published_at });
      return Response.json(path.endsWith("/second") ? { current_version: 0, published_version: null, published_at: null, versions: [], messages: [] } : project);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "public/app.js" });
  return { node, context };
}
async function ready(ui) {
  for (let i = 0; i < 30 && !ui.node("[data-preview-version]").textContent.includes("v2"); i++) await setImmediate();
  assert.match(ui.node("[data-preview-version]").textContent, /v2/);
}

test("editor shows both heads and publication buttons apply only explicit clicks", async () => {
  const ui = editor();
  await ready(ui);
  assert.match(ui.node("#publication-status").textContent, /草稿 v2 · 已發布 v1 · 有 1 個未發布變更/);
  assert.equal(ui.node("#btn-publish").disabled, false);
  await ui.node("#btn-publish").fire("click");
  assert.match(ui.node("#publication-status").textContent, /已發布 v2 · 所有變更已發布/);
  assert.equal(ui.node("#btn-publish").disabled, true);
  await ui.node("#btn-player-preview").fire("click");
  assert.equal(ui.node("#player-preview").open, true);
  assert.equal(ui.node("#player-preview iframe").html, "<html>player preview</html>");
  await ui.node("#player-preview button").fire("click");
  await ui.node("#btn-unpublish").fire("click");
  assert.match(ui.node("#publication-status").textContent, /草稿 v2 · 尚未發布/);
  assert.equal(ui.node("#btn-share").disabled, true);
  assert.equal(ui.node("#btn-unpublish").disabled, true);
  assert.equal(ui.node("#btn-publish").disabled, false);
});

test("a new project with failed generation cannot inherit the previous publication", async () => {
  const ui = editor();
  await ready(ui);
  await ui.node("#brief-form").fire("submit");
  assert.match(ui.node("#publication-status").textContent, /草稿 v0 · 尚未發布/);
  for (const id of ["#btn-publish", "#btn-unpublish", "#btn-share", "#btn-player-preview"]) assert.equal(ui.node(id).disabled, true, id);
});

test("a closed preview's delayed response cannot overwrite a newly opened preview", async () => {
  const ui = editor();
  await ready(ui);
  let finishOld;
  ui.context.MD.api.preview = () => new Promise((resolve) => { finishOld = resolve; });
  const oldPreview = ui.node("#btn-player-preview").fire("click");
  await ui.node("#player-preview button").fire("click");
  ui.context.MD.api.preview = async () => "<html>new preview</html>";
  await ui.node("#btn-player-preview").fire("click");
  finishOld("<html>stale preview</html>");
  await oldPreview;
  assert.equal(ui.node("#player-preview iframe").html, "<html>new preview</html>");
});

test("owner preview lets the trusted player access slides while deck scripts stay blocked", async () => {
  const [editor, player] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/play.html", import.meta.url), "utf8"),
  ]);
  const previewFrame = editor.match(/<iframe\b[^>]*title="公開播放器預覽"[^>]*>/i)?.[0] ?? "";
  assert.match(previewFrame, /\bsandbox="[^"]*\ballow-scripts\b/);
  assert.match(previewFrame, /\bsandbox="[^"]*\ballow-same-origin\b/, "opaque ancestor sandbox prevents the player from reading its deck DOM");
  const deckFrame = player.match(/<iframe\b[^>]*id="play-deck"[^>]*>/i)?.[0] ?? "";
  assert.match(deckFrame, /\bsandbox="allow-same-origin"/);
  assert.doesNotMatch(deckFrame, /allow-scripts/);
});
