import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
try {
  // Expand the established public smoke content with distinct short copy.
  // Dashi's own scaffold and validators produce the supported schema-v2 goal;
  // there are no synthetic renderer hooks or provider-generated inputs.
  const fixturePath = process.env.MINIDECK_CONTENT_BRIEFS || new URL("../test/fixtures/content-briefs.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const slides = Array.from({ length: 21 }, (_, index) => {
    const slide = structuredClone(fixture[index === 0 ? 0 : index === 20 ? 2 : 1]);
    slide.id = `s${String(index + 1).padStart(2, "0")}`;
    slide.content.meta.pageLabel = String(index + 1).padStart(2, "0");
    if (index !== 0 && index !== 20) {
      const copy = slide.content.presentation;
      for (const field of ["title", "titleShort", "summary", "summaryShort", "takeaway"]) {
        copy[field] = `${index + 1} ${copy[field]}`;
      }
      for (const item of copy.items) {
        item.label = `${index + 1} ${item.label}`;
        item.detail = `${index + 1} ${item.detail}`;
      }
      slide.content.meta.panelTitle = `流程 ${index + 1}`;
    }
    return slide;
  });
  const briefsPath = `${directory}/content-briefs.json`;
  await writeFile(briefsPath, JSON.stringify(slides));
  const goalPath = `${directory}/fixture-goal.json`;
  const scaffold = spawnSync("npm", [
    "--prefix", `${process.env.DASHI_ROOT}/project`, "run", "goal:scaffold", "--",
    "--title", "Synthetic coverage acceptance",
    "--goal", "Verify every rendered slide has visual evidence.",
    "--theme", "theme07", "--pages", "21", "--content-briefs", briefsPath, "--layout-variants", "3",
    "--seed", "ci-smoke", "--workflow-run-id", "real-21",
    "--out", goalPath,
  ], { cwd: directory, env: { ...process.env, INIT_CWD: directory }, encoding: "utf8" });
  assert.equal(scaffold.status, 0, scaffold.stderr || scaffold.error?.message);
  const spec = JSON.parse(await readFile(goalPath, "utf8"));
  assert.equal(spec.slides.length, 21);
  assert.ok(spec.slides.every(slide => slide.variants.length === 4));
  // Dashi's scaffold omits logical IDs; the platform's authored spec supplies
  // them, as its existing scaffold bridge does. A provided goal must retain
  // those identities before rendering and collecting visual evidence.
  spec.slides = spec.slides.map((slide, index) => ({ ...slide, id: slides[index].id }));
  const expectedSlideIds = spec.slides.map(slide => slide.id);
  assert.equal(new Set(expectedSlideIds).size, 21);
  assert.deepEqual(expectedSlideIds, slides.map(slide => slide.id));
  await writeFile(goalPath, JSON.stringify(spec));
  const input = {
    jobId: "real-21", projectId: "real-project", type: "render",
    title: spec.title, brief: spec.goal, spec,
    sourceMap: { claims: [] }, sources: [],
    profile: { rendererBinding: { themePack: "theme07" } },
    payload: {}, randomSeed: "visual-coverage-acceptance",
  };
  const { execute } = await import(pathToFileURL(module));
  const result = await execute(input);
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  assert.equal(result.status, "succeeded", result.error || "Renderer did not complete");
  assert.equal(result.version.spec.slides.length, 21);
  const audit = result.version.audit;
  const coverage = audit.visualCoverage;
  console.log(JSON.stringify({
    phase: "actual-renderer-result",
    status: result.status,
    coverage,
    deterministic: audit.deterministic,
    failedChecks: audit.evidence.filter(check => check.passed !== true),
  }));
  assert.deepEqual(audit.deterministic, {
    goalSpec: true, claimIntegrity: true, safeProps: true, render: true,
    swiss: true, copy: true, variantQuality: true,
  }, JSON.stringify(audit.evidence.filter(check => check.passed !== true)));
  assert.equal(coverage.complete, true);
  assert.equal(coverage.screenshotCount, 21);
  assert.equal(coverage.sheetCount, 2);
  assert.deepEqual(coverage.expectedSlideIds, expectedSlideIds);
  assert.deepEqual(coverage.evaluatedSlideIds, expectedSlideIds);
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
