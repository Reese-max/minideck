import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const plan = { scope: "minideck-qa-fixture1", siteD1Id: "11111111-1111-4111-8111-111111111111",
  studioD1Id: "22222222-2222-4222-8222-222222222222", bucket: "minideck-qa-fixture1-assets" };
const module = () => import("../scripts/isolated-preview.mjs");

test("all existing preview jobs audit effective bindings before any credential or write step", async () => {
  for (const file of ["deploy.yml", "presentation-studio-mcp-deploy.yml", "presentation-studio-runner-deploy.yml"]) {
    const source = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const preview = source.split("  deploy-preview:")[1].split("  deploy-production:")[0];
    const guard = preview.indexOf("node scripts/isolated-preview.mjs --audit-existing");
    assert.ok(guard >= 0, `${file} needs a pre-write isolation audit`);
    assert.ok(guard < preview.indexOf("${{ secrets."), `${file} must audit before reading credentials`);
    assert.doesNotMatch(source.split("  deploy-production:")[1], /isolated-preview\.mjs/);
  }
});
test("existing Preview configuration is detected as shared, without any network transport", async () => {
  const { auditExistingPreview } = await module();
  const previous = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No network in config audit"); };
  try {
    const result = auditExistingPreview();
    assert.equal(result.safe, false); assert.ok(result.issues.some((x) => x.includes("database")));
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; }
});
test("fresh plan derives mutually consistent separate legacy and V2 bindings", async () => {
  const { buildPreviewConfigs, assertPreviewIsolation } = await module();
  const configs = buildPreviewConfigs(plan);
  assert.doesNotThrow(() => assertPreviewIsolation(configs, plan));
  assert.notEqual(configs.site.d1_databases[0].database_id, configs.mcp.d1_databases[0].database_id);
  assert.equal(configs.runner.d1_databases[0].database_id, configs.mcp.d1_databases[0].database_id);
  assert.equal(configs.runner.r2_buckets[0].bucket_name, configs.mcp.r2_buckets[0].bucket_name);
  assert.equal(configs.site.r2_buckets[0].bucket_name, plan.bucket);
  assert.equal(configs.runner.vars.R2_PREFIX, configs.mcp.vars.R2_PREFIX);
  assert.equal(configs.runner.services[0].service, configs.mcp.name);
  assert.equal(configs.runner.vars.POLLING_ENABLED, "false");
  assert.equal(configs.runner.containers[0].max_instances, 1);
  assert.deepEqual(configs.runner.triggers.crons, []);
  assert.equal(configs.runner.vars.CF_AI_ROUTER_URL, "");
});
test("owned seed initializes only fresh synthetic studio configuration and refuses duplicate application", async () => {
  const { ownedStudioSeed, buildPreviewConfigs } = await module();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(await readFile(new URL("../workers/presentation-studio-mcp/migrations/0001_init.sql", import.meta.url), "utf8"));
    db.exec(ownedStudioSeed(plan));
    const architecture = JSON.parse(db.prepare("SELECT value_json FROM presentation_system_config WHERE config_key='architecture'").get().value_json);
    assert.equal(architecture.openDesignEnabled, false); assert.equal(architecture.renderer, "dashi");
    assert.equal(db.prepare("SELECT id FROM presentation_profiles").get().id, buildPreviewConfigs(plan).mcp.vars.DEFAULT_PROFILE_ID);
    assert.equal(db.prepare("SELECT count(*) AS n FROM presentation_oauth_tokens").get().n, 0);
    assert.throws(() => db.exec(ownedStudioSeed(plan)), /UNIQUE/);
  } finally { db.close(); }
});
test("blank, placeholder, duplicate and configured production resource inputs fail closed", async () => {
  const { buildPreviewConfigs, productionInventory } = await module();
  const prod = productionInventory();
  for (const patch of [{ scope: "" }, { scope: "minideck" }, { siteD1Id: "REPLACE_ME" },
    { siteD1Id: plan.studioD1Id }, { siteD1Id: "00000000-0000-0000-0000-000000000000" },
    { siteD1Id: [...prod.get("database-id")][0] }, { bucket: "minideck" }, { MINIMAX_API_KEY: "not-accepted" }]) {
    assert.throws(() => buildPreviewConfigs({ ...plan, ...patch }));
  }
});
test("aliases, external scripts/services, mismatched queues and unexpected bindings cannot evade isolation", async () => {
  const { buildPreviewConfigs, assertPreviewIsolation, productionInventory } = await module();
  const prod = productionInventory();
  const mutations = [
    (c) => { c.site.d1_databases[0].preview_database_id = [...prod.get("database-id")][0]; },
    (c) => { c.runner.r2_buckets[0].preview_bucket_name = "minideck"; },
    (c) => { c.runner.services[0].service = "presentation-studio-mcp"; },
    (c) => { c.runner.services[0].environment = "production"; },
    (c) => { c.runner.durable_objects.bindings[0].script_name = "presentation-studio-runner"; },
    (c) => { c.runner.workflows[0].script_name = "presentation-studio-runner"; },
    (c) => { c.runner.migrations = [{ tag: "transfer", transferred_classes: [{ from: "DashiContainer", from_script: "presentation-studio-runner", to: "DashiContainer" }] }]; },
    (c) => { c.runner.migrations = [{ tag: "rename", renamed_classes: [{ from: "Old", to: "DashiContainer" }] }]; },
    (c) => { c.runner.migrations = [{ tag: "delete", deleted_classes: ["DashiContainer"] }]; },
    (c) => { c.runner.migrations[0].new_sqlite_classes.push("UnexpectedClass"); },
    (c) => { c.site.assets.directory = "/workspace"; },
    (c) => { c.mcp.assets = c.site.assets; },
    (c) => { c.mcp.vars.MCP_PUBLIC_ORIGIN = "https://production.example"; },
    (c) => { c.runner.d1_databases[0].database_id = plan.siteD1Id; },
    (c) => { c.runner.vars.POLLING_ENABLED = "true"; },
    (c) => { c.runner.triggers.crons = ["* * * * *"]; },
    (c) => { c.runner.containers[0].max_instances = 3; },
    (c) => { c.mcp.vars.GITHUB_CLIENT_SECRET = "not-accepted"; },
    (c) => { c.site.kv_namespaces = [{ binding: "OTHER", id: "unknown" }]; },
    (c) => { c.site.routes = [{ pattern: "production.example/*" }]; },
    (c) => { c.runner.vars.CF_AI_ROUTER_URL = "https://router.example/real"; },
    (c) => { c.mcp.r2_buckets[0].bucket_name = "different-bucket"; },
  ];
  for (const mutate of mutations) { const configs = buildPreviewConfigs(plan); mutate(configs); assert.throws(() => assertPreviewIsolation(configs, plan)); }
});
test("materialized files remain unprovisioned/unvalidated and are checked before reuse", async () => {
  const { writePreviewPlan, checkPreviewDirectory } = await module();
  const directory = await mkdtemp(join(tmpdir(), "minideck-preview-plan-"));
  try {
    const output = await writePreviewPlan(plan, directory);
    const receipt = JSON.parse(await readFile(join(output, "plan.json"), "utf8"));
    assert.equal(receipt.status, "NOT_PROVISIONED_NOT_VALIDATED");
    assert.equal(receipt.cloudWrites, 0);
    assert.doesNotThrow(() => checkPreviewDirectory(output));
    await assert.rejects(writePreviewPlan(plan, directory), /exist/i, "existing review artifacts must not be overwritten");
    for (const mutate of [
      (r) => { r.sourceConfigHashes.site = "0".repeat(64); },
      (r) => { delete r.sourceConfigHashes; },
      (r) => { r.sourceConfigHashes.unknown = "0".repeat(64); },
      (r) => { r.validated = true; },
    ]) {
      const changed = structuredClone(receipt); mutate(changed);
      await writeFile(join(output, "plan.json"), JSON.stringify(changed));
      assert.throws(() => checkPreviewDirectory(output), /source|receipt/i);
    }
    await writeFile(join(output, "plan.json"), JSON.stringify(receipt));
    await writeFile(join(output, "studio-seed.sql"), "-- changed seed\n");
    assert.throws(() => checkPreviewDirectory(output), /seed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
