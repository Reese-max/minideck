import assert from "node:assert/strict";

await import("../public/app.js");

const source = `<!doctype html><html><body>
<img data-gen-prompt="First &amp; detailed" data-gen-ar="16:9" src="" alt="一">
<img data-gen-prompt='Already filled' src='/img/existing.jpg' alt='二'>
<img data-gen-prompt="Second" alt="三">
</body></html>`;

assert.deepEqual(globalThis.MD.pipeline.scanPlaceholders(source), [
  { prompt: "First & detailed", ar: "16:9" },
  { prompt: "Second", ar: "16:9" },
]);

const calls = [];
globalThis.MD.api.image = async (_id, prompt, ar) => {
  calls.push({ prompt, ar });
  return { url: `/img/${calls.length}.jpg` };
};
const progress = [];
const filled = await globalThis.MD.pipeline.fillImages(
  "project",
  source,
  (current, total) => progress.push(`${current}/${total}`),
);

assert.deepEqual(calls, [
  { prompt: "First & detailed", ar: "16:9" },
  { prompt: "Second", ar: "16:9" },
]);
assert.deepEqual(progress, ["1/2", "2/2"]);
assert.match(filled, /data-gen-prompt="First &amp; detailed"[^>]+src="\/img\/1\.jpg"/);
assert.match(filled, /data-gen-prompt='Already filled' src='\/img\/existing\.jpg'/);
assert.match(filled, /data-gen-prompt="Second"[^>]+src="\/img\/2\.jpg"/);

const optimizePrompt = globalThis.MD.audit.buildOptimizePrompt({
  fails: [],
  warns: [{ slide: 3, type: "numbers", detail: "第3頁：獨立數字 7 個超過 6 個" }],
});
assert.match(optimizePrompt, /目前稽核 WARN 清單/);
assert.match(optimizePrompt, /第3頁：獨立數字 7 個超過 6 個/);
assert.match(optimizePrompt, /強化視覺層級與留白平衡，維持所有內容不變/);
console.log("TASK_6_OPTIMIZE_PROMPT_PASS");
console.log("TASK_5_FRONTEND_PIPELINE_PASS");
