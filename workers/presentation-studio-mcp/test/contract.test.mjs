import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  isImmutableOwnerId,
  ownerIdFromGithubProfile,
} from "../src/owner-id.mjs";
import { runIdempotent } from "../src/idempotency.mjs";

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

test("uses the immutable GitHub subject for the owner namespace", async () => {
  assert.equal(
    ownerIdFromGithubProfile({ id: 12345, login: "renamed-user" }),
    "github:12345",
  );
  assert.equal(ownerIdFromGithubProfile({ id: 0, login: "invalid" }), null);
  assert.equal(ownerIdFromGithubProfile({ id: "12345", login: "x" }), null);
  assert.equal(ownerIdFromGithubProfile("github:9"), null);
  assert.equal(isImmutableOwnerId("github:12345"), true);
  assert.equal(isImmutableOwnerId("renamed-user"), false);
  const source = await read("src/auth.ts");
  assert.match(source, /ownerIdFromGithubProfile/);
  assert.match(source, /isImmutableOwnerId/);
  assert.doesNotMatch(source, /userBody\.login/);
});

test("rejects legacy login-based OAuth rows before they become MCP principals", async () => {
  const source = await read("src/auth.ts");
  assert.match(source, /!isImmutableOwnerId\(row\.owner_login\)/);
  assert.match(source, /!isImmutableOwnerId\(codeRow\.owner_login\)/);
});

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

test("idempotency records are namespaced per authenticated owner", async () => {
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
          jobId: "job-" + authenticatedOwner,
        };
      },
    );

  const ownerA = await create("github:1001");
  const ownerB = await create("github:2002");
  assert.equal(ownerA.projectId, "project-github:1001");
  assert.equal(ownerB.projectId, "project-github:2002");
  assert.notEqual(ownerA.projectId, ownerB.projectId);
  assert.deepEqual(effects, ["github:1001", "github:2002"]);

  assert.deepEqual(await create("github:1001"), ownerA);
  assert.deepEqual(await create("github:2002"), ownerB);
  assert.deepEqual(effects, ["github:1001", "github:2002"]);
});

test("same-owner changed input is rejected without repeating the cached effect", async () => {
  const db = new SqliteIdempotencyD1();
  let effects = 0;
  const call = (input) =>
    runIdempotent(
      db,
      "github:1001",
      "create_presentation",
      "same-input-key-01",
      input,
      async () => "github:1001",
      async () => ({ projectId: "project-a", sequence: ++effects }),
    );

  const first = await call({ brief: "Original" });
  assert.deepEqual(await call({ brief: "Original" }), first);
  await assert.rejects(call({ brief: "Changed" }), /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(effects, 1);
});

test("uses one atomic reservation for concurrent same-owner calls", async () => {
  const db = new SqliteIdempotencyD1();
  let effects = 0;
  const call = () =>
    runIdempotent(
      db,
      "github:1001",
      "create_presentation",
      "concurrent-key-01",
      { brief: "Quarterly review" },
      async () => "github:1001",
      async () => {
        effects += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { projectId: "project-owner-a" };
      },
    );

  const results = await Promise.allSettled([call(), call()]);
  assert.equal(effects, 1);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((entry) => entry.status === "rejected").length,
    1,
  );
  assert.match(
    results.find((entry) => entry.status === "rejected").reason.message,
    /REQUEST_IN_PROGRESS/,
  );
  assert.deepEqual(await call(), { projectId: "project-owner-a" });
  assert.equal(effects, 1);
});

test("keyed calls require an authenticated owner id", async () => {
  const db = new SqliteIdempotencyD1();
  await assert.rejects(
    runIdempotent(
      db,
      "",
      "create_presentation",
      "ownerless-key-01",
      { brief: "Quarterly review" },
      async () => "",
      async () => ({ projectId: "should-not-exist" }),
    ),
    /AUTHENTICATED_OWNER_REQUIRED/,
  );
});

test("project write tools perform owner preflight before entering cached actions", async () => {
  const source = await read("src/presentation.ts");
  const revision = source.match(
    /async function requestRevision\([\s\S]*?\n}\n\nfunction slideArray/,
  );
  const approval = source.match(
    /async function approvePresentation\([\s\S]*?\n}\n\nasync function exportPresentation/,
  );
  const exportRequest = source.match(
    /async function exportPresentation\([\s\S]*?\n}\n\nasync function/,
  );

  assert.ok(revision, "revision handler source is present");
  assert.ok(approval, "approval handler source is present");
  assert.ok(exportRequest, "export handler source is present");
  assert.match(
    revision[0],
    /async \(\) => \{[\s\S]*getProjectForOwner\([\s\S]*getVersionForOwner\([\s\S]*\},\s*async \(project\) =>/,
  );
  assert.match(
    approval[0],
    /async \(\) => \{[\s\S]*getProjectForOwner\([\s\S]*getVersionForOwner\([\s\S]*\},\s*async \(\{ project, version, runtime \}\) =>/,
  );
  assert.match(
    exportRequest[0],
    /async \(\) => \{[\s\S]*getProjectForOwner\([\s\S]*getVersionForOwner\([\s\S]*\},\s*async \(\{ project, versionId \}\) =>/,
  );
  assert.match(
    exportRequest[0],
    /async \(\{ project, versionId \}\) => \{[\s\S]*EXPORT_REQUIRES_APPROVED_VERSION/,
  );
});

class RacyInsertD1 {
  constructor(inner) {
    this.inner = inner;
    this.selectsSeen = 0;
  }

  prepare(sql) {
    const stmt = this.inner.prepare(sql);
    const self = this;
    return {
      bind(...args) {
        stmt.bind(...args);
        return this;
      },
      async first() {
        if (sql.startsWith("SELECT") && self.selectsSeen === 0) {
          self.selectsSeen += 1;
          return null;
        }
        return stmt.first();
      },
      async run() {
        if (sql.startsWith("INSERT OR IGNORE")) {
          return { meta: { changes: 0 } };
        }
        return stmt.run();
      },
    };
  }
}

test("an insert-race loser replays the winner result without re-running", async () => {
  const inner = new SqliteIdempotencyD1();
  const winner = await runIdempotent(
    inner,
    "github:1001",
    "create_presentation",
    "race-winner-key-01",
    { brief: "Quarterly review" },
    async () => "github:1001",
    async () => ({ projectId: "winner-project" }),
  );
  const db = new RacyInsertD1(inner);
  let loserActions = 0;
  const replayed = await runIdempotent(
    db,
    "github:1001",
    "create_presentation",
    "race-winner-key-01",
    { brief: "Quarterly review" },
    async () => "github:1001",
    async () => {
      loserActions += 1;
      return { projectId: "loser-project" };
    },
  );
  assert.deepEqual(replayed, winner);
  assert.equal(loserActions, 0);
});

test("an insert-race loser sees REQUEST_IN_PROGRESS while the winner runs", async () => {
  const inner = new SqliteIdempotencyD1();
  let releaseWinner;
  const winnerPending = runIdempotent(
    inner,
    "github:1001",
    "create_presentation",
    "race-pending-key-01",
    { brief: "Quarterly review" },
    async () => "github:1001",
    () => new Promise((resolve) => {
      releaseWinner = resolve;
    }),
  );
  const db = new RacyInsertD1(inner);
  await assert.rejects(
    runIdempotent(
      db,
      "github:1001",
      "create_presentation",
      "race-pending-key-01",
      { brief: "Quarterly review" },
      async () => "github:1001",
      async () => ({ projectId: "loser-project" }),
    ),
    /REQUEST_IN_PROGRESS/,
  );
  releaseWinner({ projectId: "winner-project" });
  assert.deepEqual(await winnerPending, { projectId: "winner-project" });
});

test("a vanished row mid-reservation reports REQUEST_IN_PROGRESS not REUSED", async () => {
  const inner = new SqliteIdempotencyD1();
  const db = new RacyInsertD1(inner);
  await assert.rejects(
    runIdempotent(
      db,
      "github:1001",
      "create_presentation",
      "race-vanished-key-01",
      { brief: "Quarterly review" },
      async () => "github:1001",
      async () => ({ projectId: "should-not-run" }),
    ),
    /REQUEST_IN_PROGRESS/,
  );
});

test("revision, approval, and export replay authorize the owner before returning cache", async () => {
  for (const toolName of [
    "request_presentation_revision",
    "approve_presentation",
    "export_presentation",
  ]) {
    const db = new SqliteIdempotencyD1();
    const input = { projectId: "owner-a-project", versionId: "version-1" };
    let effects = 0;
    await runIdempotent(
      db,
      "github:1001",
      toolName,
      "shared-resource-key-01",
      input,
      async () => ({ projectId: input.projectId }),
      async () => ({ effectId: ++effects, ownerId: "github:1001" }),
    );

    let revokedAuthorizationChecks = 0;
    let revokedActions = 0;
    await assert.rejects(
      runIdempotent(
        db,
        "github:1001",
        toolName,
        "shared-resource-key-01",
        input,
        async () => {
          revokedAuthorizationChecks += 1;
          throw new Error("OWNER_ACCESS_REVOKED");
        },
        async () => {
          revokedActions += 1;
          return { effectId: ++effects, ownerId: "github:1001" };
        },
      ),
      /OWNER_ACCESS_REVOKED/,
    );
    assert.equal(
      revokedAuthorizationChecks,
      1,
      toolName + " reauthorizes before cache",
    );
    assert.equal(
      revokedActions,
      0,
      toolName + " must stop after revoked authorization",
    );

    let authorizationChecks = 0;
    let actions = 0;
    await assert.rejects(
      runIdempotent(
        db,
        "github:2002",
        toolName,
        "shared-resource-key-01",
        input,
        async () => {
          authorizationChecks += 1;
          throw new Error("PROJECT_NOT_FOUND_OR_NOT_OWNED");
        },
        async () => {
          actions += 1;
          return { effectId: ++effects, ownerId: "github:2002" };
        },
      ),
      /PROJECT_NOT_FOUND_OR_NOT_OWNED/,
    );
    assert.equal(authorizationChecks, 1, toolName + " owner preflight");
    assert.equal(
      actions,
      0,
      toolName + " must not return or repeat cached effect",
    );
    assert.equal(effects, 1, toolName + " cached effect belongs to owner A");
  }
});
