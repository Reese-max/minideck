// Task 8 冒煙：真打 MiniMax 的 API 層端到端（建專案→generate→逐張補圖→saveDeck→驗零佔位符）
// 用法：MINIDECK_BASE_URL=http://127.0.0.1:8790 node test/smoke-e2e.mjs [--no-images] ["自訂 brief"]
// 預設會呼叫 1 次文字 + 最多 IMAGE_BUDGET 張圖，超出即中止。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const BASE_URL = process.env.MINIDECK_BASE_URL ?? "http://127.0.0.1:8787";
const IMAGE_BUDGET = Number(process.env.MINIDECK_IMAGE_BUDGET ?? 4);
const args = process.argv.slice(2);
const skipImages = args.includes("--no-images");
const brief =
  args.find((a) => !a.startsWith("--")) ??
  "為台灣中小企業主製作 5 頁繁體中文簡報：導入 AI 客服的效益與落地路線。最多 3 張插圖。";

// 沿用前端既有的 MD.api / MD.pipeline，避免在測試裡重寫佔位符掃描
const originalFetch = globalThis.fetch;
const hex = randomUUID().replaceAll("-", "");
const testIp = `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:${hex.slice(16, 20)}:${hex.slice(20, 24)}`;
globalThis.fetch = (input, init = {}) =>
  originalFetch(typeof input === "string" && input.startsWith("/") ? BASE_URL + input : input, {
    ...init,
    headers: { ...init.headers, "CF-Connecting-IP": testIp },
  });
await import("../public/app.js");
const { MD } = globalThis;

const { id } = await MD.api.createProject(brief, "integration-test-token");
assert.match(id, /^[a-f0-9]{40}$/);
console.log(`PASS 建立專案 id=${id}`);

const started = Date.now();
const { version: generated } = await MD.api.generate(id, undefined, "consultant-dark");
assert.ok(Number.isInteger(generated) && generated >= 1);
console.log(`PASS generate -> v${generated}（${((Date.now() - started) / 1000).toFixed(1)}s，文字呼叫 1 次）`);

const out = process.env.MINIDECK_SMOKE_OUT;
let html = await (await fetch(`/api/projects/${id}/deck?version=${generated}`)).text();
if (out) await writeFile(out, html, "utf8"); // 先落地，補圖若中止仍留得住產出
const placeholders = MD.pipeline.scanPlaceholders(html);
console.log(`掃到佔位符 ${placeholders.length} 個：${placeholders.map((p) => p.prompt.slice(0, 28)).join(" | ")}`);

if (skipImages) {
  console.log("SKIP 補圖（--no-images）");
} else {
  assert.ok(
    placeholders.length <= IMAGE_BUDGET,
    `佔位符 ${placeholders.length} 個超過圖片預算 ${IMAGE_BUDGET}，中止以免超額`,
  );
  html = await MD.pipeline.fillImages(id, html, (done, total, { url }) =>
    console.log(`  image ${done}/${total} -> ${url}`),
  );
  const { version: saved } = await MD.api.saveDeck(id, html, "imagefill");
  console.log(`PASS saveDeck -> v${saved}`);

  const stored = await (await fetch(`/api/projects/${id}/deck?version=${saved}`)).text();
  assert.equal(MD.pipeline.scanPlaceholders(stored).length, 0, "GET deck 仍有 src 空白的佔位符");
  const imgSrcs = [...stored.matchAll(/<img\b[^>]*\bdata-gen-prompt=[^>]*>/gi)]
    .map((m) => m[0].match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? "");
  assert.equal(imgSrcs.length, placeholders.length, "存回後的圖片標籤數與掃描數不符");
  assert.ok(imgSrcs.every((s) => /^\/img\/[a-f0-9]{8}\.jpg$/.test(s)), `img src 異常：${imgSrcs}`);
  for (const src of new Set(imgSrcs)) {
    assert.equal((await fetch(src)).status, 200, `${src} 取不到`);
  }
  console.log(
    imgSrcs.length
      ? `PASS 佔位符 src 零殘留，${imgSrcs.length} 張圖皆可取得：${[...new Set(imgSrcs)].join(", ")}`
      : "PASS 佔位符 src 零殘留（本次生成未產出圖片佔位符，補圖為 no-op）",
  );
  html = stored;
}

if (out) {
  await writeFile(out, html, "utf8");
  console.log(`已寫出 ${out}`);
}
console.log(`TASK_8_SMOKE_E2E_PASS project=${id}`);
