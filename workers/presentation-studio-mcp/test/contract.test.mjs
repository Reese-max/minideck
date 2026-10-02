import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("exposes exactly the v2 high-level presentation tools", async () => {
  const source = await read("src/presentation.ts");
  const expected = [
    "list_presentation_profiles",
    "create_presentation",
    "get_presentation",
    "request_presentation_revision",
    "compare_presentation_versions",
    "approve_presentation",
    "export_presentation",
    "delete_presentation",
  ];
  for (const tool of expected) {
    assert.match(source, new RegExp('"' + tool + '"'));
  }
  for (const forbidden of [
    "run_shell",
    "execute_any_command",
    "write_any_file",
    "arbitrary_sql",
    "arbitrary_r2_key",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden));
  }
});

test("keeps the renderer contract Dashi-only", async () => {
  const source = await read("src/index.ts");
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.match(source, /openDesignEnabled:\s*false/);
  assert.match(source, /renderer:\s*"dashi"/);
  assert.equal(config.name, "presentation-studio-mcp");
  assert.equal(config.main, "src/index.ts");
  assert.equal(config.d1_databases[0].database_name, "presentation-studio");
  assert.equal(config.r2_buckets[0].bucket_name, "minideck");
});

test("requires confirmation before project deletion", async () => {
  const source = await read("src/presentation.ts");
  assert.match(source, /requiresConfirmation:\s*true/);
  assert.match(source, /DELETE_CONFIRMATION_INVALID_OR_EXPIRED/);
  assert.match(source, /DELETE_CONFIRMATION_OWNER_MISMATCH/);
});

test("keeps the D1 job API outside the public MCP tool contract", async () => {
  const index = await read("src/index.ts");
  const jobs = await read("src/jobs.ts");
  assert.match(index, /handleJobApi/);
  assert.match(jobs, /\/internal\/jobs\/claim/);
  assert.match(jobs, /\/internal\/jobs\/complete/);
  assert.match(jobs, /PRESENTATION_RUNNER_TOKEN/);
});

test("does not approve a version before both independent judges complete", async () => {
  const source = await read("src/presentation.ts");
  assert.match(source, /visual_and_factual_judges_incomplete/);
  assert.match(source, /audit\.visualJudgePass !== true/);
  assert.match(source, /audit\.factualJudgePass !== true/);
});
