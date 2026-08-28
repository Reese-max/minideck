import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DECORATION_OVERFLOW_POLICY = "data-presentation-studio-decoration-overflow-policy";

export async function normalizeIntentionalDecorationOverflow(deckFile) {
  const html = await readFile(deckFile, "utf8");
  if (html.includes(DECORATION_OVERFLOW_POLICY)) return false;
  const bespokeRootSelector = "#deck .bespoke-slide > .bespoke-root";
  const themeRootSelector = "#deck .bespoke-slide .bespoke-root > div[data-bespoke-theme-source]";
  const decorationSelector = `${themeRootSelector} > div[aria-hidden=\"true\"][data-editable-skip=\"true\"]`;
  const selectors = [bespokeRootSelector, themeRootSelector, decorationSelector];
  const style = `<style id="${DECORATION_OVERFLOW_POLICY}">\n`
    + `${selectors.join(",\n")} {\n`
    + `  overflow: visible !important;\n`
    + `}\n`
    + `${bespokeRootSelector} {\n`
    + `  clip-path: inset(0) !important;\n`
    + `}\n</style>`;
  const script = `<script id="${DECORATION_OVERFLOW_POLICY}-runtime">\n`
    + `(() => {\n`
    + `  const selectors = ${JSON.stringify(selectors)};\n`
    + `  const rootSelector = ${JSON.stringify(bespokeRootSelector)};\n`
    + `  const normalize = () => {\n`
    + `    for (const selector of selectors) {\n`
    + `      for (const element of document.querySelectorAll(selector)) {\n`
    + `        element.style.setProperty("overflow", "visible", "important");\n`
    + `      }\n`
    + `    }\n`
    + `    for (const element of document.querySelectorAll(rootSelector)) {\n`
    + `      element.style.setProperty("clip-path", "inset(0)", "important");\n`
    + `    }\n`
    + `  };\n`
    + `  normalize();\n`
    + `  new MutationObserver(normalize).observe(document.documentElement, { childList: true, subtree: true });\n`
    + `})();\n`
    + `</script>`;
  const patched = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}${script}</head>`)
    : `${style}${script}${html}`;
  await writeFile(deckFile, patched);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deckFile = process.argv[2];
  if (!deckFile) {
    console.error("Usage: node runner/deck-normalizer.mjs <deck/index.html>");
    process.exit(2);
  }
  await normalizeIntentionalDecorationOverflow(deckFile);
}
