import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [deckFileArg, projectRootArg] = process.argv.slice(2);
if (!deckFileArg || !projectRootArg) {
  console.error("Usage: node runner/inspect-dashi-bespoke.mjs <deck/index.html> <dashi/project>");
  process.exit(2);
}

const deckFile = resolve(deckFileArg);
const projectRoot = resolve(projectRootArg);
const deckDir = dirname(deckFile);
const require = createRequire(resolve(projectRoot, "package.json"));
const { chromium } = require("playwright-core");
const html = await readFile(deckFile, "utf8");

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.route("http://dashi.local/**", async route => {
    const requestUrl = new URL(route.request().url());
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    const file = resolve(deckDir, relative || "index.html");
    if (file !== deckDir && !file.startsWith(`${deckDir}/`)) {
      await route.fulfill({ status: 403, body: "Forbidden" });
      return;
    }
    try {
      const body = await readFile(file);
      await route.fulfill({
        status: 200,
        contentType: contentTypeForFile(file),
        body,
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.setContent(withDeckBase(html), { waitUntil: "load" });
  await page.waitForFunction(() => (
    document.querySelector("#deck")
    && typeof window.__getExportSlides === "function"
    && typeof window.__materializeExportSlide === "function"
    && typeof window.__restoreExportSlide === "function"
  ));
  const descriptor = await page.evaluate(() => (
    window.__getExportSlides("comparison").find(item => item.variantKind === "bespoke")
  ));
  if (!descriptor) throw new Error("No bespoke comparison candidate found");
  const materialized = await page.evaluate(async candidate => {
    const slides = window.__getVisibleSlides?.()
      || [...document.querySelectorAll("#deck > .slide:not([hidden])")];
    const slide = slides.find(item => item.dataset.vmSlideId === candidate.sourceSlideId)
      || slides.find(item => window.__getSlideSourceId?.(item) === candidate.sourceSlideId);
    if (!slide) return { found: false, token: null, logicalIndex: null };
    const logicalIndex = slides.indexOf(slide);
    window.go?.(logicalIndex, { animate: false, force: true });
    const token = await window.__materializeExportSlide({
      sourceSlideId: candidate.sourceSlideId,
      logicalIndex,
      variantStateId: candidate.variantStateId,
      variantKind: candidate.variantKind,
      exportIndex: candidate.exportIndex,
    });
    return { found: true, token, logicalIndex };
  }, descriptor);
  if (!materialized.found) throw new Error("Could not materialize bespoke candidate");
  await page.evaluate(() => new Promise(resolve => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  const inspection = await page.evaluate(({ candidate, logicalIndex }) => {
    const slide = document.querySelectorAll("#deck > .slide:not([hidden])")[logicalIndex];
    const selector = "#deck .bespoke-slide .bespoke-root > div[data-bespoke-theme-source] > div[aria-hidden=\"true\"][data-editable-skip=\"true\"]";
    const describe = element => ({
      tag: element.tagName.toLowerCase(),
      className: element.className || "",
      attrs: {
        ariaHidden: element.getAttribute("aria-hidden"),
        editableSkip: element.getAttribute("data-editable-skip"),
        themeSource: element.getAttribute("data-bespoke-theme-source"),
      },
      inlineStyle: element.getAttribute("style") || "",
      computedOverflow: getComputedStyle(element).overflow,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      outerHTML: element.outerHTML.slice(0, 700),
    });
    const clipping = [...slide.querySelectorAll("*")]
      .filter(element => {
        const style = getComputedStyle(element);
        return element.clientWidth > 0
          && element.clientHeight > 0
          && ["hidden", "clip", "auto", "scroll"].includes(style.overflowX)
          && element.scrollWidth > element.clientWidth + 1;
      })
      .slice(0, 12)
      .map(describe);
    return {
      candidate,
      slideClass: slide.className,
      bespokeRootCount: slide.querySelectorAll(".bespoke-root").length,
      themeRootCount: slide.querySelectorAll(".bespoke-root > div[data-bespoke-theme-source]").length,
      broadDecorationCount: slide.querySelectorAll("[aria-hidden=\"true\"][data-editable-skip=\"true\"]").length,
      exactDecorationCount: document.querySelectorAll(selector).length,
      policyStyleCount: document.querySelectorAll("#data-presentation-studio-decoration-overflow-policy").length,
      policyStyleText: document.querySelector("style[id=\"data-presentation-studio-decoration-overflow-policy\"]")?.textContent || "",
      decorations: [...slide.querySelectorAll("[aria-hidden=\"true\"][data-editable-skip=\"true\"]")].map(describe),
      clipping,
    };
  }, { candidate: descriptor, logicalIndex: materialized.logicalIndex });
  console.log(JSON.stringify(inspection, null, 2));
  await page.evaluate(async token => window.__restoreExportSlide(token), materialized.token);
} finally {
  await browser.close();
}

function withDeckBase(value) {
  const base = '<base href="http://dashi.local/">';
  return /<head(?:\s[^>]*)?>/i.test(value)
    ? value.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${base}`)
    : `${base}${value}`;
}

function contentTypeForFile(file) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }[file.slice(file.lastIndexOf(".")).toLowerCase()] || "application/octet-stream";
}
