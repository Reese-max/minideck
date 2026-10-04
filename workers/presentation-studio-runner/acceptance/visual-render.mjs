import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// This gate executes the real renderer without prepare/render/collect doubles.
// All slide content and HTTP storage are owned synthetic fixtures. The image
// runs without external networking, and no visual or factual provider is used.
const directory = process.env.MINIDECK_ACCEPTANCE_DIR || "/tmp/minideck-real-render";
await mkdir(directory, { recursive: true });
const artifacts = [];
const storageErrors = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "PUT");
    const match = req.url.match(/^\/storage\/real-21\/([a-z0-9-]+)$/);
    assert.ok(match);
    const kind = match[1];
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const bytes = Buffer.concat(parts);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = kind.startsWith("preview") ? "png" : kind === "html" ? "html" : "json";
    const image = kind.startsWith("preview") ? {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    } : undefined;
    if (image) {
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bytes.subarray(12, 16).toString(), "IHDR");
    }
    await writeFile(`${directory}/${kind}.${extension}`, bytes);
    const artifact = {
      kind,
      r2Key: `presentation-studio/projects/real-project/jobs/real-21/${kind}.${extension}`,
      byteSize: bytes.length,
      sha256,
      ...(image ? { image } : {}),
    };
    artifacts.push(artifact);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(artifact));
  } catch (error) {
    storageErrors.push(error.message);
    res.statusCode = 500;
    res.end(error.message);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.DASHI_STORAGE_HOST = `127.0.0.1:${server.address().port}`;
process.env.DASHI_ROOT = process.env.DASHI_ROOT || "/opt/skills/dashi-ppt";
process.env.CHROME_PATH = "/usr/bin/chromium";
const module = process.env.MINIDECK_RUNNER_MODULE || new URL("../runner/execute-job.mjs", import.meta.url).pathname;
const slides = Array.from({ length: 21 }, (_, index) => ({
  id: `s${index + 1}`,
  role: index === 0 ? "cover" : index === 20 ? "closing" : "process",
  keyMessage: "Review every slide.",
  content: { presentation: {
    title: "Coverage map",
    titleShort: "Coverage map",
    summary: "Render, inspect, record and verify every slide.",
    summaryShort: "Verify every slide.",
    takeaway: "Keep a complete review receipt.",
    items: [
      { label: "Render", detail: "Produce the slide" },
      { label: "Inspect", detail: "Review the visual" },
      { label: "Record", detail: "Bind the slide ID" },
      { label: "Verify", detail: "Check full coverage" },
      { label: "Approve", detail: "Require all gates" },
    ],
  } },
}));
const input = {
  jobId: "real-21",
  projectId: "real-project",
  type: "render",
  title: "Synthetic coverage acceptance",
  brief: "Verify every rendered slide has visual evidence.",
  spec: { slides },
  sourceMap: { claims: [] },
  sources: [],
  profile: { rendererBinding: { themePack: "theme07" } },
  payload: {},
  randomSeed: "visual-coverage-acceptance",
};
try {
  const { execute } = await import(pathToFileURL(module));
  const result = await execute(input);
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  assert.equal(result.status, "succeeded", result.error || "Renderer did not complete");
  assert.equal(result.version.spec.slides.length, 21);
  const audit = result.version.audit;
  const coverage = audit.visualCoverage;
  assert.equal(coverage.complete, true);
  assert.equal(coverage.screenshotCount, 21);
  assert.equal(coverage.sheetCount, 2);
  assert.deepEqual(coverage.expectedSlideIds, slides.map(slide => slide.id));
  assert.deepEqual(coverage.evaluatedSlideIds, slides.map(slide => slide.id));
  const previews = artifacts.filter(artifact => artifact.kind.startsWith("preview"));
  assert.deepEqual(previews.map(artifact => artifact.kind), ["preview", "preview-2"]);
  assert.deepEqual(previews.map(artifact => artifact.image), [
    { width: 960, height: 2700 },
    { width: 480, height: 270 },
  ]);
  assert.deepEqual(storageErrors, []);
  // Rendering evidence alone must never become approval evidence.
  assert.equal(audit.judgesComplete, false);
  assert.equal(audit.allHardGatesPass, false);
  const receipt = {
    status: "passed",
    renderer: "real Dashi 0.4.11 + local Chromium",
    module,
    slideCount: 21,
    coverage,
    deterministic: audit.deterministic,
    judgesComplete: audit.judgesComplete,
    allHardGatesPass: audit.allHardGatesPass,
    artifacts,
    storage: "owned loopback HTTP fixture; no remote storage/provider",
    execution: "actual production execute module; no renderer doubles",
  };
  await writeFile(`${directory}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await new Promise(resolve => server.close(resolve));
}
