import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { runIdempotent } from "../workers/presentation-studio-mcp/src/idempotency.mjs";

class SqliteIdempotencyD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      "CREATE TABLE presentation_idempotency (" +
        "idempotency_key TEXT PRIMARY KEY, " +
        "tool_name TEXT NOT NULL, " +
        "request_hash TEXT NOT NULL, " +
        "result_json TEXT NOT NULL, " +
        "expires_at TEXT NOT NULL)",
    );
  }

  prepare(sql) {
    const database = this.db;
    const values = [];
    return {
      bind(...args) {
        values.push(...args);
        return this;
      },
      async first() {
        return database.prepare(sql).get(...values) ?? null;
      },
      async run() {
        const info = database.prepare(sql).run(...values);
        return { meta: { changes: Number(info.changes) } };
      },
    };
  }
}

export async function assertOwnerScopedIdempotency() {
  const db = new SqliteIdempotencyD1();
  const input = { brief: "Quarterly review", profileId: "board" };
  const effects = [];
  const create = (ownerId) =>
    runIdempotent(
      db,
      ownerId,
      "create_presentation",
      "shared-create-key-01",
      input,
      async () => ownerId,
      async (authenticatedOwner) => {
        effects.push(authenticatedOwner);
        return {
          ownerId: authenticatedOwner,
          projectId: "project-" + authenticatedOwner,
          workflowRunId: "workflow-" + authenticatedOwner,
          jobId: "job-" + authenticatedOwner,
          versionId: "version-" + authenticatedOwner,
        };
      },
    );

  const ownerA = await create("github:1001");
  const ownerB = await create("github:2002");
  assert.notEqual(ownerB.projectId, ownerA.projectId);
  assert.notEqual(ownerB.workflowRunId, ownerA.workflowRunId);
  assert.notEqual(ownerB.jobId, ownerA.jobId);
  assert.notEqual(ownerB.versionId, ownerA.versionId);
  assert.deepEqual(effects, ["github:1001", "github:2002"]);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS n FROM presentation_idempotency")
      .get().n,
    2,
  );

  assert.deepEqual(await create("github:1001"), ownerA);
  assert.deepEqual(await create("github:2002"), ownerB);
  assert.deepEqual(effects, ["github:1001", "github:2002"]);

  await assert.rejects(
    runIdempotent(
      db,
      "github:1001",
      "create_presentation",
      "shared-create-key-01",
      { brief: "Changed", profileId: "board" },
      async () => "github:1001",
      async () => ({ projectId: "should-not-run" }),
    ),
    /IDEMPOTENCY_KEY_REUSED/,
  );

  await assert.rejects(
    runIdempotent(
      db,
      "github:1001",
      "export_presentation",
      "shared-create-key-01",
      input,
      async () => "github:1001",
      async () => ({ projectId: "should-not-run" }),
    ),
    /IDEMPOTENCY_KEY_REUSED/,
  );

  const approveKey = "shared-approve-key-01";
  const approveInput = {
    projectId: ownerA.projectId,
    versionId: ownerA.versionId,
  };
  const approveA = await runIdempotent(
    db,
    "github:1001",
    "approve_presentation",
    approveKey,
    approveInput,
    async () => "github:1001",
    async () => ({ status: "approved", approvalId: "approval-a" }),
  );
  assert.deepEqual(approveA, { status: "approved", approvalId: "approval-a" });

  assert.deepEqual(
    await runIdempotent(
      db,
      "github:1001",
      "approve_presentation",
      approveKey,
      approveInput,
      async () => "github:1001",
      async () => ({ shouldNotExist: true }),
    ),
    approveA,
  );

  let bPreflights = 0;
  let bActions = 0;
  await assert.rejects(
    runIdempotent(
      db,
      "github:2002",
      "approve_presentation",
      approveKey,
      approveInput,
      async () => {
        bPreflights += 1;
        throw new Error("PROJECT_NOT_FOUND: " + approveInput.projectId);
      },
      async () => {
        bActions += 1;
        return { leaked: true };
      },
    ),
    /PROJECT_NOT_FOUND/,
  );
  assert.equal(bPreflights, 1);
  assert.equal(bActions, 0);
  assert.deepEqual(
    await runIdempotent(
      db,
      "github:1001",
      "approve_presentation",
      approveKey,
      approveInput,
      async () => "github:1001",
      async () => ({ shouldNotExist: true }),
    ),
    approveA,
  );

  let revokedChecks = 0;
  let revokedActions = 0;
  await assert.rejects(
    runIdempotent(
      db,
      "github:1001",
      "approve_presentation",
      approveKey,
      approveInput,
      async () => {
        revokedChecks += 1;
        throw new Error("OWNER_ACCESS_REVOKED");
      },
      async () => {
        revokedActions += 1;
        return { leaked: true };
      },
    ),
    /OWNER_ACCESS_REVOKED/,
  );
  assert.equal(revokedChecks, 1);
  assert.equal(revokedActions, 0);

  const retryKey = "retry-after-failure-01";
  let attempts = 0;
  await assert.rejects(
    runIdempotent(
      db,
      "github:1001",
      "request_presentation_revision",
      retryKey,
      approveInput,
      async () => "github:1001",
      async () => {
        attempts += 1;
        throw new Error("UPSTREAM_FAILURE");
      },
    ),
    /UPSTREAM_FAILURE/,
  );
  const retried = await runIdempotent(
    db,
    "github:1001",
    "request_presentation_revision",
    retryKey,
    approveInput,
    async () => "github:1001",
    async () => {
      attempts += 1;
      return { status: "queued", jobId: "job-retry" };
    },
  );
  assert.equal(attempts, 2);
  assert.equal(retried.jobId, "job-retry");

  const source = await readFile(
    new URL(
      "../workers/presentation-studio-mcp/src/presentation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (const handler of [
    "requestRevision",
    "approvePresentation",
    "exportPresentation",
  ]) {
    const match = source.match(
      new RegExp(`async function ${handler}\\([\\s\\S]*?\\n}\\n`),
    );
    assert.ok(match, `${handler} handler is present`);
    assert.match(match[0], /async \(\) => \{[\s\S]*?getProjectForOwner\(/);
  }
}
