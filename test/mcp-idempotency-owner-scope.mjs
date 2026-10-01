import assert from "node:assert/strict";
import { runIdempotent } from "../workers/presentation-studio-mcp/src/idempotency.mjs";

// Minimal D1 stub covering only the presentation_idempotency statements that
// runIdempotent issues; keyed by the bound idempotency_key parameter.
class IdempotencyD1 {
  rows = new Map();

  prepare(sql) {
    const thisDb = this;
    let values = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first() {
        const row = thisDb.rows.get(values[0]);
        return row ? { ...row } : null;
      },
      async run() {
        if (sql.startsWith("INSERT OR IGNORE")) {
          const [key, toolName, requestHash, expiresAt] = values;
          if (thisDb.rows.has(key)) return { meta: { changes: 0 } };
          thisDb.rows.set(key, {
            idempotency_key: key,
            tool_name: toolName,
            request_hash: requestHash,
            result_json: "__pending__",
            expires_at: expiresAt,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE presentation_idempotency")) {
          const [resultJson, key, requestHash] = values;
          const row = thisDb.rows.get(key);
          if (row?.request_hash === requestHash) row.result_json = resultJson;
          return { meta: { changes: row?.request_hash === requestHash ? 1 : 0 } };
        }
        if (sql.startsWith("DELETE FROM presentation_idempotency")) {
          const [key, second] = values;
          const row = thisDb.rows.get(key);
          const shouldDelete =
            row &&
            (sql.includes("expires_at = ?")
              ? row.expires_at === second
              : row.request_hash === second && row.result_json === "__pending__");
          if (shouldDelete) thisDb.rows.delete(key);
          return { meta: { changes: shouldDelete ? 1 : 0 } };
        }
        throw new Error("Unexpected D1 statement: " + sql);
      },
    };
  }
}

export async function assertOwnerScopedIdempotency() {
  const db = new IdempotencyD1();
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
        return { ownerId: authenticatedOwner, projectId: "project-" + authenticatedOwner };
      },
    );

  const ownerA = await create("owner-a");
  const ownerB = await create("owner-b");
  assert.notEqual(ownerB.projectId, ownerA.projectId);
  assert.deepEqual(effects, ["owner-a", "owner-b"]);
  assert.deepEqual(await create("owner-a"), ownerA);
  assert.equal(effects.length, 2);

  await assert.rejects(
    runIdempotent(
      db,
      "owner-a",
      "create_presentation",
      "shared-create-key-01",
      { brief: "Changed" },
      async () => "owner-a",
      async () => ({ projectId: "should-not-run" }),
    ),
    /IDEMPOTENCY_KEY_REUSED/,
  );

  let actions = 0;
  await assert.rejects(
    runIdempotent(
      db,
      "owner-b",
      "approve_presentation",
      "shared-create-key-01",
      { projectId: "project-owner-a" },
      async () => {
        throw new Error("PROJECT_NOT_FOUND_OR_NOT_OWNED");
      },
      async () => {
        actions += 1;
        return {};
      },
    ),
    /PROJECT_NOT_FOUND_OR_NOT_OWNED/,
  );
  assert.equal(actions, 0);
}
