import assert from "node:assert/strict";

await import("../public/app.js");

const originalFetch = globalThis.fetch;
let generateBody;
globalThis.fetch = async (_path, init) => {
  generateBody = JSON.parse(init.body);
  return new Response('event: done\ndata: {"version":7}\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
};
try {
  assert.deepEqual(
    await globalThis.MD.api.generate("project", undefined, "minimal-light", "營收：123 萬元"),
    { version: 7 },
  );
  assert.deepEqual(generateBody, {
    style: "minimal-light",
    sourceData: "營收：123 萬元",
  });
} finally {
  globalThis.fetch = originalFetch;
}
console.log("TASK_7_5_SOURCE_DATA_BODY_PASS");

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
assert.match(
  globalThis.MD.audit.buildIterationPrompt(
    { fails: [], warns: [] },
    "降低文字密度並強化結論",
  ),
  /使用者下一輪方向：降低文字密度並強化結論/,
);

const simulated = [
  { version: 1, report: { fails: [{}, {}], warns: [] } },
  { version: 2, report: { fails: [{}], warns: [] } },
  { version: 3, report: { fails: [{}], warns: [{}, {}] } },
];
let stopRequested = false;
let rolledBackTo;
const iteration = await globalThis.MD.iteration.run({
  maxRounds: 6,
  shouldStop: () => stopRequested,
  step: async ({ round }) => {
    if (round === 3) stopRequested = true;
    return simulated[round - 1];
  },
  rollback: async (version) => {
    rolledBackTo = version;
    return { version: 4 };
  },
});
assert.deepEqual(iteration.rounds.map(({ score }) => score), [60, 80, 70]);
assert.equal(iteration.reason, "user");
assert.equal(iteration.best.version, 2);
assert.equal(rolledBackTo, 2);
assert.equal(iteration.rollbackVersion, 4);
console.log("TASK_7_5_ITERATION_ROLLBACK_PASS scores=60->80->70 best=v2 rollback=v2");

const cleanTie = await globalThis.MD.iteration.run({
  maxRounds: 2,
  step: async ({ round }) => ({ version: round, report: { fails: [], warns: [] } }),
  rollback: async (version) => ({ version }),
});
assert.equal(cleanTie.reason, "clean");
assert.equal(cleanTie.best.version, 2);
console.log("TASK_7_5_LATEST_TIE_PASS best=v2");
console.log("TASK_6_OPTIMIZE_PROMPT_PASS");
console.log("TASK_5_FRONTEND_PIPELINE_PASS");
await import("./hq-mock.mjs");
