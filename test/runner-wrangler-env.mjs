import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function stripJsoncComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const config = JSON.parse(
  stripJsoncComments(
    await readFile(
      new URL("../workers/presentation-studio-runner/wrangler.jsonc", import.meta.url),
      "utf8",
    ),
  ),
);

assert.equal(typeof config.env, "object", "wrangler.jsonc must define named environments");
assert.deepEqual(
  Object.keys(config.vars ?? {}).filter((key) => /TOKEN|SECRET|KEY|PASSWORD/i.test(key)),
  [],
  "top-level vars must not contain secret material",
);
const expectedVars = { ...config.vars };
for (const envName of ["preview", "production"]) {
  const env = config.env?.[envName];
  assert.ok(env, `wrangler.jsonc must define env.${envName}`);

  // Bindings are non-inheritable: each named env must redeclare every
  // binding the Runner runtime uses (issue #14).
  assert.deepEqual(
    (env.d1_databases ?? []).map((entry) => entry.binding),
    ["DB"],
    `env.${envName} must bind the D1 database`,
  );
  assert.equal(
    env.d1_databases?.[0]?.database_id,
    config.d1_databases?.[0]?.database_id,
    `env.${envName} must reuse the existing D1 database_id`,
  );
  assert.deepEqual(
    (env.r2_buckets ?? []).map((entry) => entry.binding),
    ["BUCKET"],
    `env.${envName} must bind the R2 bucket`,
  );
  assert.deepEqual(
    env.services?.map((entry) => [entry.binding, entry.service]),
    [["MCP_SERVICE", "presentation-studio-mcp"]],
    `env.${envName} must bind MCP_SERVICE`,
  );
  assert.ok(
    (env.workflows ?? []).some((entry) => entry.binding === "PRESENTATION_WORKFLOW"),
    `env.${envName} must bind PRESENTATION_WORKFLOW`,
  );
  assert.ok(
    (env.durable_objects?.bindings ?? []).some((entry) => entry.name === "DASHI_CONTAINER"),
    `env.${envName} must bind DASHI_CONTAINER`,
  );
  assert.ok(
    (env.containers ?? []).some((entry) => entry.class_name === "DashiContainer"),
    `env.${envName} must configure the DashiContainer container`,
  );
  assert.deepEqual(
    env.triggers?.crons,
    config.triggers?.crons,
    `env.${envName} must redeclare the non-inheritable cron trigger`,
  );

  // vars are non-inheritable: every top-level var must exist per env.
  for (const key of Object.keys(expectedVars)) {
    assert.ok(
      Object.hasOwn(env.vars ?? {}, key),
      `env.${envName}.vars must define ${key}`,
    );
  }
  assert.equal(env.vars?.ARCHITECTURE_VERSION, expectedVars.ARCHITECTURE_VERSION);
  assert.equal(env.vars?.R2_PREFIX, expectedVars.R2_PREFIX);
  assert.equal(env.vars?.MAX_CLAIM_BATCH, expectedVars.MAX_CLAIM_BATCH);
  assert.equal(env.vars?.CF_AI_ROUTER_URL, expectedVars.CF_AI_ROUTER_URL);
  assert.equal(env.vars?.CF_AI_ROUTER_MODEL, expectedVars.CF_AI_ROUTER_MODEL);

  // Secrets stay on the `wrangler secret put` path; never inside vars.
  assert.deepEqual(
    Object.keys(env.vars ?? {}).filter((key) => /TOKEN|SECRET|KEY|PASSWORD/i.test(key)),
    [],
    `env.${envName}.vars must not contain secret material`,
  );
}

assert.equal(config.env.preview.name, "presentation-studio-runner-preview");
assert.equal(config.env.preview.vars?.POLLING_ENABLED, "false");
assert.equal(config.env.production.name, "presentation-studio-runner");
assert.equal(config.env.production.vars?.POLLING_ENABLED, "true");

console.log("PASS runner wrangler named environments carry bindings and vars");
