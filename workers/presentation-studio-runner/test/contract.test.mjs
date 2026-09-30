import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  applyRevisionPatch,
  normalizeRevisionPatch,
} from "../src/revision-patch.mjs";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("declares a Workflow and a Dashi Container binding", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.equal(config.name, "presentation-studio-runner");
  assert.equal(config.workflows[0].binding, "PRESENTATION_WORKFLOW");
  assert.equal(config.workflows[0].class_name, "PresentationWorkflow");
  assert.equal(config.containers[0].class_name, "DashiContainer");
  assert.equal(config.durable_objects.bindings[0].name, "DASHI_CONTAINER");
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["DashiContainer"]);
});

test("uses a fixed Dashi command and rejects shell execution", async () => {
  const source = await read("runner/execute-job.mjs");
  const container = await read("src/container.ts");
  assert.match(source, /spawn\(file, args, \{/);
  assert.match(source, /shell:\s*false/);
  assert.match(container, /\["node", "\/app\/runner\/execute-job\.mjs"\]/);
  assert.doesNotMatch(source, /exec\(.*input\.(command|cmd|shell)/s);
  assert.doesNotMatch(source, /eval\s*\(/);
  const normalizer = await read("runner/deck-normalizer.mjs");
  assert.match(normalizer, /data-presentation-studio-decoration-overflow-policy/);
  assert.match(normalizer, /data-bespoke-theme-source/);
  assert.match(normalizer, /data-editable-skip/);
  assert.match(normalizer, /overflow: visible !important/);
  assert.match(normalizer, /clip-path: inset\(0\) !important/);
  assert.match(normalizer, /setProperty\("overflow", "visible", "important"\)/);
});

test("allows only fixed artifact kinds and derives R2 keys", async () => {
  const source = await read("src/storage.ts");
  for (const kind of ["goal", "html", "audit", "quality", "preview", "pptx", "pdf"]) {
    assert.match(source, new RegExp(`${kind}:`));
  }
  assert.match(source, /jobs\/\$\{jobId\}/);
  assert.match(source, /status = 'running'/);
  assert.doesNotMatch(source, /artifact\.r2Key/);
});

test("does not expose a public runner job endpoint", async () => {
  const source = await read("src/index.ts");
  assert.match(source, /runner_internal_only/);
  assert.match(source, /scheduled\(/);
  assert.match(source, /POLLING_ENABLED/);
});

test("runs independent judges after Dashi and redacts sensitive claims", async () => {
  const workflow = await read("src/workflow.ts");
  const judges = await read("src/judges.ts");
  assert.match(workflow, /runJudges/);
  assert.match(workflow, /judge dashi job/);
  assert.match(judges, /claim\.sensitive !== true/);
  assert.match(judges, /score >= 80/);
  assert.match(judges, /everySlideScoreMin >= 80/);
  assert.match(judges, /JUDGES_NOT_CONFIGURED/);
  assert.match(await read("runner/execute-job.mjs"), /claimIntegrityCheck/);
  assert.match(await read("src/reviser.ts"), /REVISION_OUTPUT_INVALID_SPEC_PATCH/);
  assert.match(await read("src/workflow.ts"), /plan revision for job/);
});

test("supplied and planner spec patches share the same scope validation", async () => {
  const workflow = await read("src/workflow.ts");
  const reviser = await read("src/reviser.ts");
  assert.match(workflow, /applyRevisionPatch\(input, suppliedPatch\)/);
  assert.match(reviser, /revision-patch\.mjs/);
  assert.match(reviser, /normalizeRevisionPatch/);

  const input = {
    spec: {
      slides: [
        { id: "s1", keyMessage: "one" },
        { id: "s2", keyMessage: "two" },
      ],
    },
    sourceMap: { claims: [] },
    payload: {},
    changedSlides: ["s1"],
  };
  const outOfScope = { slides: [{ id: "s2", keyMessage: "tampered" }] };
  assert.equal(normalizeRevisionPatch(outOfScope, input), null);
  assert.equal(applyRevisionPatch(input, outOfScope), null);

  const inScope = { slides: [{ id: "s1", keyMessage: "revised" }] };
  const applied = applyRevisionPatch(input, inScope);
  assert.ok(applied);
  assert.equal(applied.spec.slides[0].keyMessage, "revised");
  assert.equal(applied.spec.slides[1].keyMessage, "two");
  assert.deepEqual(applied.changedSlides, ["s1"]);
  assert.equal(applied.payload.specPatch, null);
});

test("claim fields are each validated against verified non-sensitive ids", async () => {
  const input = {
    spec: { slides: [{ id: "s1", keyMessage: "one" }] },
    sourceMap: {
      claims: [
        { claimId: "c1", sensitive: false },
        { claimId: "c2", sensitive: true },
      ],
    },
    payload: {},
    changedSlides: ["s1"],
  };
  const smuggled = { slides: [{ id: "s1", claims: ["c1"], sourceClaimIds: ["c2"] }] };
  assert.equal(normalizeRevisionPatch(smuggled, input), null);
  const clean = { slides: [{ id: "s1", claims: ["c1"], sourceClaimIds: ["c1"] }] };
  assert.ok(normalizeRevisionPatch(clean, input));
});

test("changedSlides includes only slides whose JSON values actually change", () => {
  const input = {
    spec: {
      slides: [
        { id: "s1", keyMessage: "one", content: { title: "One", items: ["a"] } },
        { id: "s2", keyMessage: "two" },
        { id: "s3", keyMessage: "three" },
      ],
    },
    sourceMap: { claims: [] },
    payload: {},
    changedSlides: ["s1", "s2", "s3"],
  };
  const original = structuredClone(input);
  for (const slide of [
    { id: "s1" },
    { id: "s1", keyMessage: "one" },
    { id: "s1", content: { items: ["a"], title: "One" } },
  ]) {
    const result = applyRevisionPatch(input, { slides: [slide] });
    assert.ok(result);
    assert.deepEqual(result.spec, input.spec);
    assert.deepEqual(result.changedSlides, []);
  }

  const result = applyRevisionPatch(input, {
    slides: [
      { id: "s3", keyMessage: "revised-three" },
      { id: "s1", content: { items: ["b"], title: "One" } },
      { id: "s2", keyMessage: "two" },
    ],
  });
  assert.deepEqual(result.changedSlides, ["s1", "s3"]);
  assert.equal(result.spec.slides[0].content.items[0], "b");
  assert.equal(result.spec.slides[2].keyMessage, "revised-three");
  assert.deepEqual(input, original);
});
