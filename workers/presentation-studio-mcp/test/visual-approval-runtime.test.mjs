import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { planVisualCoverage } from "../../presentation-studio-runner/runner/visual-coverage.mjs";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith(".ts") && /^\.\.?\/[^.]+$/.test(specifier)) specifier += ".ts";
  return nextResolve(specifier, context);
} });
const { registerPresentationTools } = await import("../src/presentation.ts");
hooks.deregister();

function fixture(count = 21) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE presentation_system_config(config_key TEXT PRIMARY KEY,value_json TEXT);
    CREATE TABLE presentation_projects(id TEXT PRIMARY KEY,target_score INTEGER,status TEXT,approved_version_id TEXT,current_score INTEGER,updated_at TEXT);
    CREATE TABLE presentation_project_runtime(project_id TEXT,owner_id TEXT);
    CREATE TABLE presentation_versions(id TEXT,project_id TEXT,version_number INTEGER,score INTEGER,hard_gates_pass INTEGER,spec_json TEXT,audit_json TEXT);
    CREATE TABLE presentation_version_runtime(version_id TEXT,is_approved INTEGER DEFAULT 0);
    CREATE TABLE presentation_approvals(id TEXT,project_id TEXT,version_id TEXT,decision TEXT,note TEXT);
    CREATE TABLE presentation_events(id TEXT,project_id TEXT,event_type TEXT,payload_json TEXT);`);
  const DB = { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) }; } }; },
    async batch(statements) { sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
  const ids = Array.from({ length: count }, (_, i) => `s${i + 1}`);
  const spec = { slides: ids.map((id) => ({ id })) };
  const audit = { allHardGatesPass: true, judgesComplete: true, visualJudgePass: true, factualJudgePass: true,
    totalScore: 95, everySlideScoreMin: 95, blockerCount: 0, majorIssueCount: 0,
    visualCoverage: planVisualCoverage(ids, ids.map((_, i) => `slide-${i + 1}.png`)) };
  sqlite.prepare("INSERT INTO presentation_system_config VALUES (?,?)").run("architecture", JSON.stringify({ version: "2.0.0", openDesignEnabled: false, renderer: "dashi", orchestrator: "cloudflare-workflow" }));
  sqlite.prepare("INSERT INTO presentation_projects(id,target_score,status) VALUES ('project',90,'reviewable')").run();
  sqlite.prepare("INSERT INTO presentation_project_runtime VALUES ('project','owner')").run();
  sqlite.prepare("INSERT INTO presentation_versions VALUES ('version','project',1,95,1,?,?)").run(JSON.stringify(spec), JSON.stringify(audit));
  sqlite.prepare("INSERT INTO presentation_version_runtime(version_id) VALUES ('version')").run();
  let approve;
  registerPresentationTools({ registerTool(name, _options, callback) { if (name === "approve_presentation") approve = callback; } }, { DB }, "owner", ["presentation:write"]);
  const setAudit = (next) => sqlite.prepare("UPDATE presentation_versions SET audit_json=?").run(JSON.stringify(next));
  const persisted = () => ({ approvals: sqlite.prepare("SELECT count(*) AS n FROM presentation_approvals").get().n,
    events: sqlite.prepare("SELECT count(*) AS n FROM presentation_events").get().n,
    approved: sqlite.prepare("SELECT is_approved FROM presentation_version_runtime").get().is_approved,
    head: sqlite.prepare("SELECT approved_version_id FROM presentation_projects").get().approved_version_id });
  return { sqlite, audit, ids, approve: () => approve({ projectId: "project", versionId: "version" }), setAudit, persisted };
}

for (const [name, mutate, reason] of [
  ["20-of-21 coverage despite otherwise green audit", (f) => ({ ...f.audit, visualCoverage: planVisualCoverage(f.ids, f.ids.slice(0,20).map((_,i)=>`slide-${i+1}.png`)) }), "visual_coverage_incomplete"],
  ["missing receipt despite green score", (f) => ({ ...f.audit, visualCoverage: undefined }), "visual_coverage_incomplete"],
  ["21st-slide blocker", (f) => ({ ...f.audit, allHardGatesPass:false,visualJudgePass:false,everySlideScoreMin:55,blockerCount:1 }), "blockers_present"],
  ["incomplete factual judge", (f) => ({ ...f.audit, factualJudgePass:false }), "visual_and_factual_judges_incomplete"],
]) test(`actual approval mutation denies ${name} without persisted effects`, async () => {
  const f = fixture(); try { f.setAudit(mutate(f)); await assert.rejects(f.approve(), new RegExp(reason));
    assert.deepEqual(f.persisted(), { approvals:0,events:0,approved:0,head:null }); } finally { f.sqlite.close(); }
});

for (const count of [20,21]) test(`actual approval mutation accepts complete ${count}-slide control`, async () => {
  const f = fixture(count); try { await f.approve(); assert.deepEqual(f.persisted(), { approvals:1,events:1,approved:1,head:"version" }); } finally { f.sqlite.close(); }
});
