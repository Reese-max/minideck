// Configuration preparation/audit only. No Cloudflare client, provisioning,
// credential loading, Secret writes, deployment or provider request.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { experimental_readRawConfig, unstable_readConfig } = require("wrangler");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = { site: join(root, "wrangler.toml"), mcp: join(root, "workers/presentation-studio-mcp/wrangler.jsonc"),
  runner: join(root, "workers/presentation-studio-runner/wrangler.jsonc") };
const readOptions = { useRedirectIfAvailable: false, hideWarnings: true };
const raw = (path) => experimental_readRawConfig({ config: path }, readOptions).rawConfig;
const effective = (path, env) => unstable_readConfig({ config: path, ...(env ? { env } : {}) }, readOptions);
const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function names(plan) {
  return { site: `${plan.scope}-site`, mcp: `${plan.scope}-mcp`, runner: `${plan.scope}-runner`,
    siteDb: `${plan.scope}-site-db`, studioDb: `${plan.scope}-studio-db`, workflow: `${plan.scope}-workflow` };
}
function normalizePlan(input) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "resource plan required");
  assert.deepEqual(Object.keys(input).sort(), ["bucket", "scope", "siteD1Id", "studioD1Id"], "only non-secret resource fields are accepted");
  assert.match(input.scope, /^minideck-qa-[a-z0-9]{6,16}$/, "fresh scoped preview name required");
  assert.ok(uuid.test(input.siteD1Id) && uuid.test(input.studioD1Id), "fresh D1 UUIDs required; placeholders are not resources");
  const plan = { ...input, siteD1Id: input.siteD1Id.toLowerCase(), studioD1Id: input.studioD1Id.toLowerCase() };
  assert.notEqual(plan.siteD1Id, "00000000-0000-0000-0000-000000000000");
  assert.notEqual(plan.studioD1Id, "00000000-0000-0000-0000-000000000000");
  assert.notEqual(plan.siteD1Id, plan.studioD1Id, "legacy and studio databases must be separate");
  assert.equal(plan.bucket, `${plan.scope}-assets`, "a dedicated scoped bucket is required");
  return plan;
}
function references(config) {
  const result = [];
  const add = (kind, value) => { if (value !== undefined) result.push([kind, normalized(value)]); };
  add("worker", config.name);
  for (const d of config.d1_databases ?? []) {
    add("database-id", d.database_id); add("database-id", d.preview_database_id); add("database-name", d.database_name);
  }
  for (const b of config.r2_buckets ?? []) { add("bucket", b.bucket_name); add("bucket", b.preview_bucket_name); }
  for (const s of config.services ?? []) add("worker", s.service);
  for (const w of config.workflows ?? []) { add("workflow", w.name); add("worker", w.script_name); }
  for (const d of config.durable_objects?.bindings ?? []) add("worker", d.script_name);
  return result;
}
export function productionInventory() {
  const inventory = new Map(["worker", "database-id", "database-name", "bucket", "workflow"].map((kind) => [kind, new Set()]));
  const configs = [effective(paths.site), effective(paths.mcp), effective(paths.runner), effective(paths.runner, "production")];
  for (const config of configs) for (const [kind, value] of references(config)) if (value) inventory.get(kind).add(value);
  return inventory;
}
function assertNoProductionReferences(configs) {
  const forbidden = productionInventory();
  for (const config of Object.values(configs)) for (const [kind, value] of references(config)) {
    assert.ok(value, `blank ${kind} reference`);
    assert.ok(!forbidden.get(kind).has(value), `preview references configured production ${kind}`);
  }
}
export function assertPreviewIsolation(configs, input) {
  const plan = normalizePlan(input), expected = names(plan);
  assert.deepEqual(Object.keys(configs).sort(), ["mcp", "runner", "site"]);
  assertNoProductionReferences(configs);
  const allowed = new Set(["$schema", "name", "main", "compatibility_date", "compatibility_flags", "observability", "workers_dev", "preview_urls",
    "assets", "rules", "vars", "d1_databases", "r2_buckets", "services", "workflows", "containers", "durable_objects", "migrations", "triggers"]);
  for (const [kind, config] of Object.entries(configs)) {
    for (const key of Object.keys(config)) assert.ok(allowed.has(key), `unexpected config key: ${key}`);
    assert.equal(config.name, expected[kind], "worker identity must match the scope");
    assert.equal(config.main, resolve(dirname(paths[kind]), raw(paths[kind]).main));
    assert.equal(config.workers_dev, true);
    assert.deepEqual(config.triggers, { crons: [] }, "all automatic polling schedules are disabled");
    assert.equal(config.d1_databases?.length, 1); assert.equal(config.r2_buckets?.length, 1);
    const d = config.d1_databases[0], b = config.r2_buckets[0];
    const id = kind === "site" ? plan.siteD1Id : plan.studioD1Id;
    assert.equal(d.binding, "DB"); assert.equal(normalized(d.database_id), id);
    assert.equal(d.database_name, kind === "site" ? expected.siteDb : expected.studioDb);
    if (d.preview_database_id !== undefined) assert.equal(normalized(d.preview_database_id), id);
    assert.notEqual(d.remote, true);
    assert.equal(b.binding, "BUCKET"); assert.equal(b.bucket_name, plan.bucket);
    if (b.preview_bucket_name !== undefined) assert.equal(b.preview_bucket_name, plan.bucket);
    assert.notEqual(b.remote, true);
    for (const key of Object.keys(config.vars ?? {})) assert.doesNotMatch(key, /(?:_KEY|_TOKEN|_SECRET|SECRET_|_PASSWORD|PASSWORD_|^IP_SALT$|^GITHUB_)/i, "secrets are not accepted in generated vars");
    const allowedVars = {
      site: ["LIMIT_IP_PROJECTS", "LIMIT_GLOBAL_PROJECTS", "LIMIT_GLOBAL_TEXT", "LIMIT_GLOBAL_IMAGES", "LIMIT_PROJECT_REVISES", "LIMIT_PROJECT_IMAGES", "LIMIT_PROJECT_RETRIES"],
      mcp: ["ARCHITECTURE_VERSION", "DEFAULT_PROFILE_ID", "R2_PREFIX", "PRESENTATION_RUNNER_STATUS"],
      runner: ["ARCHITECTURE_VERSION", "R2_PREFIX", "POLLING_ENABLED", "MAX_CLAIM_BATCH", "CF_AI_ROUTER_URL", "CF_AI_ROUTER_MODEL"],
    };
    assert.deepEqual(Object.keys(config.vars ?? {}).sort(), allowedVars[kind].sort(), "unexpected or missing preview variables");
    if (kind !== "site") assert.equal(config.vars.R2_PREFIX, `${plan.scope}/`);
    if (kind !== "runner") {
      for (const field of ["services", "workflows", "containers", "durable_objects", "migrations"]) assert.equal(config[field], undefined, `unexpected ${kind} ${field}`);
    }
    if (kind === "site") {
      assert.deepEqual(config.assets, { ...raw(paths.site).assets, directory: resolve(root, "public") }, "only the reviewed public asset directory is allowed");
      assert.deepEqual(config.rules, raw(paths.site).rules);
    } else {
      assert.equal(config.assets, undefined, "MCP/Runner must not upload an asset directory");
      assert.equal(config.rules, undefined);
    }
  }
  const runner = configs.runner;
  assert.equal(runner.vars.POLLING_ENABLED, "false"); assert.equal(runner.vars.MAX_CLAIM_BATCH, "1");
  assert.equal(runner.vars.CF_AI_ROUTER_URL, "", "provider-free configuration has no router target/key");
  assert.deepEqual(runner.services, [{ binding: "MCP_SERVICE", service: expected.mcp }]);
  assert.deepEqual(runner.workflows, [{ binding: "PRESENTATION_WORKFLOW", name: expected.workflow, class_name: "PresentationWorkflow" }]);
  assert.deepEqual(runner.durable_objects, { bindings: [{ name: "DASHI_CONTAINER", class_name: "DashiContainer" }] });
  assert.deepEqual(runner.migrations, [{ tag: "v1", new_sqlite_classes: ["DashiContainer"] }], "preview migrations may only create the fresh local class");
  assert.equal(runner.containers?.length, 1); assert.equal(runner.containers[0].max_instances, 1);
  assert.equal(runner.containers[0].class_name, "DashiContainer");
  assert.equal(runner.containers[0].image, resolve(dirname(paths.runner), "Dockerfile"));
  assert.equal(configs.mcp.vars.PRESENTATION_RUNNER_STATUS, "pending");
  assert.equal(configs.mcp.vars.DEFAULT_PROFILE_ID, `${plan.scope}-profile`);
  return true;
}
export function buildPreviewConfigs(input) {
  const plan = normalizePlan(input), expected = names(plan);
  const configs = Object.fromEntries(Object.entries(paths).map(([kind, path]) => {
    const config = structuredClone(raw(path));
    for (const key of ["env", "account_id", "zone_id", "route", "routes"]) delete config[key];
    config.name = expected[kind]; config.main = resolve(dirname(path), config.main);
    config.workers_dev = true; config.preview_urls = true; config.triggers = { crons: [] };
    config.d1_databases = [{ binding: "DB", database_name: kind === "site" ? expected.siteDb : expected.studioDb,
      database_id: kind === "site" ? plan.siteD1Id : plan.studioD1Id }];
    config.r2_buckets = [{ binding: "BUCKET", bucket_name: plan.bucket }];
    if (kind === "site") {
      config.assets.directory = resolve(root, config.assets.directory);
      config.d1_databases[0].migrations_dir = resolve(root, "migrations/published");
    } else config.vars.R2_PREFIX = `${plan.scope}/`;
    if (kind === "mcp") {
      config.vars.PRESENTATION_RUNNER_STATUS = "pending";
      config.vars.DEFAULT_PROFILE_ID = `${plan.scope}-profile`;
    }
    if (kind === "runner") {
      config.vars = { ...config.vars, POLLING_ENABLED: "false", MAX_CLAIM_BATCH: "1", CF_AI_ROUTER_URL: "" };
      config.services = [{ binding: "MCP_SERVICE", service: expected.mcp }];
      config.workflows = [{ binding: "PRESENTATION_WORKFLOW", name: expected.workflow, class_name: "PresentationWorkflow" }];
      config.containers = [{ class_name: "DashiContainer", image: resolve(dirname(path), "Dockerfile"), max_instances: 1 }];
      // Never inherit transfer/rename/delete history from a production namespace.
      config.migrations = [{ tag: "v1", new_sqlite_classes: ["DashiContainer"] }];
    }
    return [kind, config];
  }));
  assertPreviewIsolation(configs, plan);
  return configs;
}
export function ownedStudioSeed(input) {
  const plan = normalizePlan(input);
  const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const architecture = JSON.stringify({ version: "2.0.0", openDesignEnabled: false, renderer: "dashi", orchestrator: "cloudflare-workflow" });
  return "-- OWNED SYNTHETIC PREVIEW ONLY. Never run against an existing production database.\n" +
    "-- Apply the canonical empty studio schema first. INSERT conflicts deliberately fail.\n" +
    `INSERT INTO presentation_system_config(config_key,value_json) VALUES('architecture',${sql(architecture)});\n` +
    "INSERT INTO presentation_profiles(id,name,description,design_markdown,quality_json,renderer_binding_json,created_at,updated_at) VALUES(" +
    [sql(`${plan.scope}-profile`), sql("Owned isolated fixture"), sql("Synthetic acceptance only; not a production profile"),
      sql("Use owned synthetic slides without external sources or provider-generated content."), sql("{}"), sql('{"themePack":"theme07"}'), "datetime('now')", "datetime('now')"].join(",") + ");\n";
}
export function auditExistingPreview() {
  // These are the effective configs selected by the three existing Preview jobs:
  // legacy/MCP versions upload use default config; Runner deploy uses --env preview.
  const configs = { site: effective(paths.site), mcp: effective(paths.mcp), runner: effective(paths.runner, "preview") };
  const forbidden = productionInventory(), issues = [];
  for (const [component, config] of Object.entries(configs)) {
    if (!normalized(config.name)) issues.push(`${component}:missing-worker`);
    if (config.d1_databases?.length !== 1) issues.push(`${component}:missing-database`);
    if (config.r2_buckets?.length !== 1) issues.push(`${component}:missing-bucket`);
    for (const [kind, value] of references(config)) {
      if (!value || forbidden.get(kind).has(value)) issues.push(`${component}:${kind}`);
    }
  }
  return { safe: issues.length === 0, issues: [...new Set(issues)], status: "CONFIG_AUDIT_ONLY_NOT_RUNTIME_VALIDATED" };
}
export async function writePreviewPlan(input, parent = resolve(root, ".wrangler/isolated-preview")) {
  const plan = normalizePlan(input), configs = buildPreviewConfigs(plan), directory = join(resolve(parent), plan.scope);
  mkdirSync(resolve(parent), { recursive: true });
  mkdirSync(directory); // Exclusive new directory: never overwrite an existing review artifact.
  const hashes = {};
  for (const [kind, config] of Object.entries(configs)) {
    const content = JSON.stringify(config, null, 2) + "\n"; hashes[kind] = sha256(content);
    writeFileSync(join(directory, `${kind}.json`), content, { flag: "wx" });
  }
  const seed = ownedStudioSeed(plan); hashes.studioSeed = sha256(seed);
  writeFileSync(join(directory, "studio-seed.sql"), seed, { flag: "wx" });
  writeFileSync(join(directory, "plan.json"), JSON.stringify({ status: "NOT_PROVISIONED_NOT_VALIDATED", cloudWrites: 0, plan,
    configHashes: hashes, sourceConfigHashes: Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, sha256(readFileSync(path))])) }, null, 2) + "\n", { flag: "wx" });
  return directory;
}
export function checkPreviewDirectory(directory) {
  const receipt = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["cloudWrites", "configHashes", "plan", "sourceConfigHashes", "status"], "unexpected preview receipt schema");
  assert.equal(receipt.status, "NOT_PROVISIONED_NOT_VALIDATED"); assert.equal(receipt.cloudWrites, 0);
  assert.ok(receipt.sourceConfigHashes && typeof receipt.sourceConfigHashes === "object", "source config hashes required");
  assert.deepEqual(Object.keys(receipt.sourceConfigHashes).sort(), ["mcp", "runner", "site"], "source config hash schema mismatch");
  assert.deepEqual(Object.keys(receipt.configHashes ?? {}).sort(), ["mcp", "runner", "site", "studioSeed"], "config hash receipt schema mismatch");
  for (const [kind, path] of Object.entries(paths)) {
    assert.equal(receipt.sourceConfigHashes[kind], sha256(readFileSync(path)), "source config changed after review materialization");
  }
  const configs = Object.fromEntries(["site", "mcp", "runner"].map((kind) => {
    const content = readFileSync(join(directory, `${kind}.json`), "utf8");
    assert.equal(sha256(content), receipt.configHashes[kind], "generated config changed after review materialization");
    return [kind, JSON.parse(content)];
  }));
  assertPreviewIsolation(configs, receipt.plan);
  const seed = readFileSync(join(directory, "studio-seed.sql"), "utf8");
  assert.equal(sha256(seed), receipt.configHashes.studioSeed, "fixture seed changed after materialization");
  assert.equal(seed, ownedStudioSeed(receipt.plan), "only the scoped owned fixture seed is accepted");
  return { safeAgainstConfiguredProduction: true, status: "NOT_PROVISIONED_NOT_VALIDATED" };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [action, file, parent] = process.argv.slice(2);
    if (action === "--audit-existing") {
      const result = auditExistingPreview(); console.log(JSON.stringify(result));
      if (!result.safe) process.exitCode = 1;
    } else if (action === "--generate" && file) {
      console.log(JSON.stringify({ directory: await writePreviewPlan(JSON.parse(readFileSync(file, "utf8")), parent), status: "NOT_PROVISIONED_NOT_VALIDATED" }));
    } else if (action === "--check" && file) console.log(JSON.stringify(checkPreviewDirectory(resolve(file))));
    else throw new Error("Use --audit-existing, --generate resource-plan.json [output-parent], or --check generated-directory");
  } catch (error) { console.error(error.message.split("\n")[0]); process.exitCode = 1; }
}
