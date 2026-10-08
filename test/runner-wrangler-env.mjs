import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const NON_INHERITABLE_BINDINGS = [
  ["d1_databases", "binding", "DB"],
  ["r2_buckets", "binding", "BUCKET"],
  ["services", "binding", "MCP_SERVICE"],
  ["workflows", "binding", "PRESENTATION_WORKFLOW"],
  ["durable_objects", "name", "DASHI_CONTAINER"],
];
const CONTAINER_CLASS = "DashiContainer";
const REQUIRED_VARS = [
  "ARCHITECTURE_VERSION",
  "R2_PREFIX",
  "POLLING_ENABLED",
  "MAX_CLAIM_BATCH",
  "CF_AI_ROUTER_URL",
  "CF_AI_ROUTER_MODEL",
];
const POLLING_BY_ENV = { preview: "false", production: "true" };
const SECRET_KEY_PATTERN = /(_KEY|_TOKEN|_SECRET|SECRET_|_PASSWORD|PASSWORD_)/;
const RUNNER_WORKFLOWS = [
  ".github/workflows/presentation-studio-runner.yml",
  ".github/workflows/presentation-studio-runner-deploy.yml",
];

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function bindingValue(scope, key, field, binding) {
  const entries = key === "durable_objects" ? scope.durable_objects?.bindings : scope[key];
  return (entries ?? []).find((entry) => entry[field] === binding);
}

function containerEntry(scope) {
  return (scope.containers ?? []).find((entry) => entry.class_name === CONTAINER_CLASS);
}

const config = JSON.parse(
  stripJsonComments(
    await readFile(new URL("../workers/presentation-studio-runner/wrangler.jsonc", import.meta.url), "utf8"),
  ),
);

assert.ok(config.env?.preview && config.env?.production, "Runner 必須宣告 preview 與 production named environments");

for (const [key, field, binding] of NON_INHERITABLE_BINDINGS) {
  assert.ok(
    bindingValue(config, key, field, binding),
    `top-level 缺少 ${binding} binding，否則 named environment 無法對齊契約`,
  );
  for (const envName of Object.keys(config.env)) {
    assert.ok(
      bindingValue(config.env[envName], key, field, binding),
      `env.${envName} 缺少 ${binding}（${key} 不可由 top-level 繼承）`,
    );
  }
}

for (const envName of Object.keys(config.env)) {
  assert.ok(containerEntry(config.env[envName]), `env.${envName} 缺少 ${CONTAINER_CLASS} container（不可繼承）`);
  assert.ok(containerEntry(config), `top-level 缺少 ${CONTAINER_CLASS} container`);
}

for (const varName of REQUIRED_VARS) {
  assert.ok(config.vars?.[varName], `top-level vars 缺少 ${varName}`);
  for (const envName of Object.keys(config.env)) {
    assert.ok(config.env[envName].vars?.[varName], `env.${envName}.vars 缺少 ${varName}（vars 不可由 top-level 繼承）`);
  }
}

for (const [envName, expected] of Object.entries(POLLING_BY_ENV)) {
  assert.equal(config.env[envName].vars.POLLING_ENABLED, expected, `env.${envName} POLLING_ENABLED 必須為 ${expected}`);
}
assert.notEqual(config.env.preview.name, config.env.production.name, "preview 與 production 不可部署到同一個 Worker");
assert.equal(config.env.production.name, config.name, "production named environment 必須維持 top-level Worker 身分");

for (const envName of Object.keys(config.env)) {
  const scope = config.env[envName];
  assert.equal(
    scope.d1_databases.find((entry) => entry.binding === "DB")?.database_id,
    config.d1_databases.find((entry) => entry.binding === "DB")?.database_id,
    `env.${envName} 必須沿用既有的 D1 database_id`,
  );
  assert.equal(
    scope.r2_buckets.find((entry) => entry.binding === "BUCKET")?.bucket_name,
    config.r2_buckets.find((entry) => entry.binding === "BUCKET")?.bucket_name,
    `env.${envName} 必須沿用既有的 R2 bucket_name`,
  );
  assert.equal(
    scope.services.find((entry) => entry.binding === "MCP_SERVICE")?.service,
    config.services.find((entry) => entry.binding === "MCP_SERVICE")?.service,
    `env.${envName} 必須沿用既有的 MCP service binding 目標`,
  );
  assert.equal(scope.workflows[0].class_name, config.workflows[0].class_name, `env.${envName} Workflow 類別必須一致`);
  assert.equal(containerEntry(scope).image, containerEntry(config).image, `env.${envName} container image 必須一致`);
}

for (const scope of [config, ...Object.values(config.env)]) {
  for (const varName of Object.keys(scope.vars ?? {})) {
    assert.doesNotMatch(varName, SECRET_KEY_PATTERN, `${varName} 看似 secret，必須走 wrangler secret put --env 而非 vars`);
  }
}

for (const workflow of RUNNER_WORKFLOWS) {
  const source = await readFile(new URL(`../${workflow}`, import.meta.url), "utf8");
  for (const envName of Object.keys(POLLING_BY_ENV)) {
    assert.match(
      source,
      new RegExp(`wrangler deploy --dry-run --env ${envName}\\b`),
      `${workflow} 缺少 --env ${envName} 的 exact-env dry-run，top-level 綠燈不能代表 named environment 可部署`,
    );
  }
}

console.log("PASS Runner named environments 逐一宣告 D1/R2/service/Workflow/container bindings 與 vars，CI 覆蓋 exact-env dry-run");
