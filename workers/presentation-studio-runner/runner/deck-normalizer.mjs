import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DECORATION_OVERFLOW_POLICY = "data-presentation-studio-decoration-overflow-policy";

export async function normalizeIntentionalDecorationOverflow(deckFile) {
  const html = await readFile(deckFile, "utf8");
  if (html.includes(DECORATION_OVERFLOW_POLICY)) return false;
  const style = `<style id="${DECORATION_OVERFLOW_POLICY}">\n`
    + `.bespoke-root div[aria-hidden="true"][data-editable-skip="true"] {\n`
    + `  overflow: visible !important;\n`
    + `}\n</style>`;
  const patched = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}</head>`)
    : `${style}${html}`;
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
