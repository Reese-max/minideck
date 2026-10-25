import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const pageOptions = [...html.match(/<select id="page-count"[^>]*>([\s\S]*?)<\/select>/)[1]
  .matchAll(/<option value="(\d+)"( selected)?>/g)];

class Element {
  value = "";
  textContent = "";
  validationMessage = "";
  children = new Map();
  listeners = new Map();
  attributes = new Map();
  dataset = {};
  style = {};
  classes = new Set();
  classList = {
    add: (...names) => names.forEach((name) => this.classes.add(name)),
    remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    contains: (name) => this.classes.has(name),
  };
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  replaceChildren() {}
  setCustomValidity(message) { this.validationMessage = message; }
  checkValidity() { return !this.validationMessage; }
  dispatch(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
}

function formHarness() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)]
    .map(([, id]) => [`#${id}`, new Element()]));
  const brief = elements.get("#brief-input");
  const pages = elements.get("#page-count");
  brief.maxLength = Number(html.match(/<textarea id="brief-input"[^>]*maxlength="(\d+)"/)[1]);
  pages.value = pageOptions.find((option) => option[2])[1];
  const requests = [];
  const errors = [];
  const otherElements = new Element();
  const context = {
    console: { log() {}, error: (...args) => errors.push(args.join(" ")) },
    document: {
      querySelector: (selector) => selector.startsWith("#")
        ? elements.get(selector) ?? null : otherElements.querySelector(selector),
      querySelectorAll: () => [],
    },
    location: { hash: "" },
    URLSearchParams,
    addEventListener() {},
    turnstile: { render(_box, options) { options.callback("test-turnstile"); return 0; } },
    fetch: async (path, init) => {
      if (path === "/api/quota") {
        return Response.json({ ipRemaining: { projects: 3 }, globalRemaining: { projects: 50 } });
      }
      assert.equal(path, "/api/projects");
      requests.push(JSON.parse(init.body));
      // Stop at project creation; deck generation is outside this regression.
      return new Promise(() => {});
    },
  };
  otherElements.querySelector('meta[name="turnstile-sitekey"]').content = "test-sitekey";
  vm.runInNewContext(source, context, { filename: "public/app.js" });
  return { elements, brief, pages, requests, errors, form: elements.get("#brief-form") };
}

test("default brief maxlength reserves the 12-page suffix before typing", () => {
  const { brief, pages } = formHarness();
  assert.equal(pages.value, "12");
  assert.equal(brief.maxLength, 1989);
  assert.match(html, /id="brief-input"[^>]*aria-describedby="brief-limit"/);
  assert.match(html, /id="brief-limit"[^>]*aria-live="polite"/);
});

for (const [, pages] of pageOptions) {
  const suffix = `\n\n請產生 ${pages} 頁。`;
  const limit = 2000 - suffix.length;
  test(`${pages} pages: maxlength boundary reaches createProject with a 2000-character brief`, () => {
    const h = formHarness();
    h.pages.value = pages;
    h.pages.dispatch("change");
    assert.equal(h.brief.maxLength, limit);
    h.brief.value = "字".repeat(h.brief.maxLength);
    h.brief.dispatch("input");
    h.form.dispatch("submit");
    assert.equal(h.requests.length, 1, "maxlength boundary must call createProject");
    assert.equal(h.requests[0].brief, h.brief.value + suffix);
    assert.equal([...h.requests[0].brief].length, 2000);
    assert.equal(h.requests[0].turnstileToken, "test-turnstile");
    assert.equal(h.errors.length, 0);
  });
  test(`${pages} pages: one character over the limit shows an input error and never creates a project`, () => {
    const h = formHarness();
    h.pages.value = pages;
    h.pages.dispatch("change");
    h.brief.value = "字".repeat(limit + 1);
    h.brief.dispatch("input");
    assert.equal(h.brief.checkValidity(), false, "overflow must be invalid before submission");
    assert.match(h.elements.get("#brief-limit").textContent, new RegExp(`最多 ${limit} 字`));
    h.form.dispatch("submit");
    assert.equal(h.requests.length, 0);
    assert.match(h.errors.join("\n"), new RegExp(`最多 ${limit} 字`));
  });
}

test("changing page count flags existing overflow and clearing it restores validity", () => {
  const h = formHarness();
  h.pages.value = "5";
  h.pages.dispatch("change");
  h.brief.value = "字".repeat(1990);
  h.brief.dispatch("input");
  assert.equal(h.brief.checkValidity(), true);
  h.pages.value = "12";
  h.pages.dispatch("change");
  assert.equal(h.brief.value.length, 1990, "changing pages must preserve the user's text");
  assert.equal(h.brief.checkValidity(), false);
  assert.equal(h.brief.attributes.get("aria-invalid"), "true");
  assert.match(h.elements.get("#brief-limit").textContent, /最多 1989 字/);
  h.brief.value = h.brief.value.slice(0, -1);
  h.brief.dispatch("input");
  assert.equal(h.brief.checkValidity(), true);
  assert.equal(h.brief.attributes.get("aria-invalid"), "false");
  assert.match(h.elements.get("#brief-limit").textContent, /1989 \/ 1989/);
});

test("programmatic overflow is rejected on submit even without an input event", () => {
  const h = formHarness();
  h.brief.value = "😀".repeat(995);
  h.form.dispatch("submit");
  assert.equal(h.requests.length, 0);
  assert.match(h.errors.join("\n"), /最多 1989 字/);
});
