import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith(".ts") && /^\.\.?\/[^.]+$/.test(specifier)) {
      specifier += ".ts";
    }
    return nextResolve(specifier, context);
  },
});
const { registerPresentationTools } = await import("../src/presentation.ts");
hooks.deregister();

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

function sourceHarness({ failUpload = false } = {}) {
  const objects = new Map();
  let writes = 0;
  let create;
  registerPresentationTools({
    registerTool(name, _schema, callback) {
      if (name === "create_presentation") create = callback;
    },
  }, {
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("presentation_system_config")) {
              return { value_json: JSON.stringify({ version: "2.0.0", openDesignEnabled: false, renderer: "dashi", orchestrator: "cloudflare-workflow" }) };
            }
            assert.match(sql, /FROM presentation_profiles/);
            return { id: "test-profile" };
          },
        };
      },
      async batch() { writes += 1; return []; },
    },
    BUCKET: {
      async put(key, bytes) {
        objects.set(key, new TextDecoder().decode(bytes));
        if (failUpload && objects.size === 2) throw new Error("R2_UPLOAD_FAILED");
      },
      async delete(keys) { for (const key of keys) objects.delete(key); },
    },
  }, "test-owner", ["presentation:write"]);
  return { create, objects, writes: () => writes };
}

const source = (sourceId, contentText) => ({ sourceId, contentText, fileName: "same.txt", mimeType: "text/plain" });

test("distinct source IDs cannot overwrite each other's R2 content", async () => {
  const { create, objects } = sourceHarness();
  await create({ title: "Sources", brief: "Keep each source", sources: [source("src:1", "first"), source("src_1", "second"), source(".", "dot"), source("..", "double-dot")] });
  const stored = [...objects].filter(([key]) => key.includes("/sources/"));
  assert.equal(stored.length, 4);
  assert.deepEqual(stored.map(([, bytes]) => bytes), ["first", "second", "dot", "double-dot"]);
  for (const [key] of stored) assert.doesNotMatch(key, /\/\.{1,2}\//);
  assert.equal(JSON.parse([...objects].find(([key]) => key.endsWith("source-map.json"))[1]).sources.length, 4);
});

test("a later invalid source or failed upload cleans up earlier R2 writes", async () => {
  for (const failUpload of [false, true]) {
    const harness = sourceHarness({ failUpload });
    const second = { ...source("s2", "second"), mimeType: failUpload ? "text/plain" : "application/x-invalid" };
    await assert.rejects(harness.create({ title: "Sources", brief: "Fail safely", sources: [source("s1", "first"), second] }), /SOURCE_MIME_UNSUPPORTED|R2_UPLOAD_FAILED/);
    assert.equal(harness.objects.size, 0);
    assert.equal(harness.writes(), 0);
  }
});
