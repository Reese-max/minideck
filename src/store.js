const REQUIRED_TABLES = ["projects", "versions", "messages", "quotas"];
// Columns added by migrations/0002_published_head.sql. Reading a project before
// that migration runs raises on every project path, so a public endpoint fails
// loudly here instead of 500-ing later with an opaque SQL error.
const REQUIRED_PROJECT_COLUMNS = [
  "current_version",
  "published_version",
  "published_at",
  "publish_origin",
];

export async function assertD1Initialized(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("缺少 DB 綁定");
  }

  const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .bind(...REQUIRED_TABLES)
    .all();
  const present = new Set(result.results.map((row) => row.name));

  if (REQUIRED_TABLES.some((table) => !present.has(table))) {
    throw new Error("D1 schema 尚未初始化");
  }

  const columns = await db.prepare("PRAGMA table_info(projects)").all();
  const projectColumns = new Set(columns.results.map((row) => row.name));
  if (REQUIRED_PROJECT_COLUMNS.some((column) => !projectColumns.has(column))) {
    throw new Error(
      "D1 schema 尚未初始化：請先套用 migrations/0002_published_head.sql",
    );
  }
}

export async function readQuotaCounts(db, entries) {
  const statements = entries.map(({ scope, day }) =>
    db
      .prepare("SELECT count FROM quotas WHERE scope = ?1 AND day = ?2")
      .bind(scope, day),
  );
  const results = await db.batch(statements);

  return results.map((result) => Number(result.results[0]?.count ?? 0));
}

export function getProject(db, id) {
  return db
    .prepare(
      "SELECT id, brief, access_token_hash, current_version, published_version, published_at, publish_origin, status FROM projects WHERE id = ?1",
    )
    .bind(id)
    .first();
}

export async function claimProject(db, id) {
  const result = await db
    .prepare(
      "UPDATE projects SET status = 'generating' WHERE id = ?1 AND status != 'generating'",
    )
    .bind(id)
    .run();

  if (Number(result.meta?.changes ?? 0) > 0) return true;
  return (await getProject(db, id)) ? false : null;
}

export async function releaseProject(db, id) {
  await db
    .prepare(
      "UPDATE projects SET status = CASE WHEN current_version > 0 THEN 'ready' ELSE 'new' END WHERE id = ?1",
    )
    .bind(id)
    .run();
}

export async function saveDeckVersion(db, bucket, id, html, origin, revision) {
  const project = await getProject(db, id);
  if (!project) return null;

  const version = Number(project.current_version) + 1;
  const r2Key = `decks/${id}/${version}.html`;
  const statements = [
    db
      .prepare(
        "INSERT INTO versions(project_id, version, r2_key, origin, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
      )
      .bind(id, version, r2Key, origin, Date.now()),
    db
      .prepare(
        "UPDATE projects SET current_version = ?2, status = 'ready' WHERE id = ?1",
      )
      .bind(id, version),
  ];

  if (revision) {
    const row = await db
      .prepare(
        "SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE project_id = ?1",
      )
      .bind(id)
      .first();
    const seq = Number(row?.seq ?? 0);
    const now = Date.now();
    statements.push(
      db
        .prepare(
          "INSERT INTO messages(project_id, seq, role, content, created_at) VALUES(?1, ?2, 'user', ?3, ?4)",
        )
        .bind(id, seq + 1, revision.user, now),
      db
        .prepare(
          "INSERT INTO messages(project_id, seq, role, content, created_at) VALUES(?1, ?2, 'assistant', ?3, ?4)",
        )
        .bind(id, seq + 2, revision.assistant, now),
    );
  }

  let uploaded = false;
  try {
    await bucket.put(r2Key, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    uploaded = true;
    await db.batch(statements);
    return version;
  } catch (error) {
    if (uploaded) {
      try {
        await bucket.delete(r2Key);
      } catch (cleanupError) {
        console.error("deck_r2_cleanup_failed", r2Key, cleanupError);
      }
    }
    throw error;
  }
}

export async function readDeck(db, bucket, id, requestedVersion) {
  const project = await getProject(db, id);
  if (!project) return { project: null, deck: null };

  const version = requestedVersion ?? Number(project.current_version);
  if (!Number.isInteger(version) || version < 1) {
    return { project, deck: null };
  }

  const row = await db
    .prepare(
      "SELECT version, r2_key, origin, created_at FROM versions WHERE project_id = ?1 AND version = ?2",
    )
    .bind(id, version)
    .first();
  if (!row) return { project, deck: null };

  const object = await bucket.get(row.r2_key);
  return { project, deck: object ? { ...row, object } : null };
}

export async function rollbackDeckVersion(db, bucket, id, sourceVersion) {
  const source = await readDeck(db, bucket, id, sourceVersion);
  if (!source.project) return { project: null, version: null };
  if (!source.deck) return { project: source.project, version: null };

  const version = await saveDeckVersion(
    db,
    bucket,
    id,
    source.deck.object.body,
    "rollback",
  );
  return { project: source.project, version };
}

// Single-statement conditional update: the EXISTS guard keeps the public head
// from ever pointing at a version that does not exist in the same project,
// even if a concurrent save/delete is in flight. The R2 head check rejects a
// version whose blob is already gone, so publish can never mint a receipt for
// a public link that 404s forever.
export async function publishDeckVersion(db, bucket, id, version) {
  const row = await db
    .prepare(
      "SELECT r2_key FROM versions WHERE project_id = ?1 AND version = ?2",
    )
    .bind(id, version)
    .first();
  if (!row) return null;
  if (!(await bucket.head(row.r2_key))) return null;

  const publishedAt = Date.now();
  const result = await db
    .prepare(
      `UPDATE projects
       SET published_version = ?2, published_at = ?3, publish_origin = 'publish'
       WHERE id = ?1
         AND EXISTS (
           SELECT 1 FROM versions WHERE project_id = ?1 AND version = ?2
         )`,
    )
    .bind(id, version, publishedAt)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) return null;
  return { version, publishedAt };
}

export async function unpublishDeckVersion(db, id) {
  const result = await db
    .prepare(
      "UPDATE projects SET published_version = NULL, published_at = NULL, publish_origin = NULL WHERE id = ?1",
    )
    .bind(id)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function appendProjectMessage(db, id, role, content) {
  await db
    .prepare(
      `INSERT INTO messages(project_id, seq, role, content, created_at)
       SELECT ?1, coalesce(max(seq), 0) + 1, ?2, ?3, ?4
       FROM messages WHERE project_id = ?1`,
    )
    .bind(id, role, content, Date.now())
    .run();
}

export async function deleteProjectData(db, bucket, id) {
  const project = await getProject(db, id);
  if (!project) return null;

  const rows = await db
    .prepare("SELECT r2_key FROM versions WHERE project_id = ?1")
    .bind(id)
    .all();
  const keys = rows.results
    .map((row) => row.r2_key)
    .filter((key) => typeof key === "string" && key);

  let cleanupPending = 0;
  for (const key of keys) {
    try {
      await bucket.delete(key);
    } catch (error) {
      cleanupPending += 1;
      console.error("project_r2_cleanup_failed", key, error);
    }
  }

  // ponytail: D1 and R2 have no cross-service transaction; keep metadata retryable when R2 cleanup fails.
  if (cleanupPending > 0) return { cleanupPending };

  await db.batch([
    db.prepare("DELETE FROM messages WHERE project_id = ?1").bind(id),
    db.prepare("DELETE FROM versions WHERE project_id = ?1").bind(id),
    db
      .prepare("DELETE FROM quotas WHERE scope LIKE ?1")
      .bind(`proj:${id}:%`),
    db.prepare("DELETE FROM projects WHERE id = ?1").bind(id),
  ]);
  return { cleanupPending };
}

export async function readProjectState(db, id) {
  const project = await getProject(db, id);
  if (!project) return null;

  const [versions, messages] = await db.batch([
    db
      .prepare(
        "SELECT version, origin, created_at FROM versions WHERE project_id = ?1 ORDER BY version",
      )
      .bind(id),
    db
      .prepare(
        "SELECT seq, role, content, created_at FROM messages WHERE project_id = ?1 ORDER BY seq",
      )
      .bind(id),
  ]);

  const currentVersion = Number(project.current_version ?? 0);
  const publishedVersion =
    project.published_version === null ||
    project.published_version === undefined
      ? null
      : Number(project.published_version);

  return {
    status: project.status,
    current_version: currentVersion,
    published_version: publishedVersion,
    published_at: project.published_at ?? null,
    publish_origin: project.publish_origin ?? null,
    unpublished_changes: Math.max(
      0,
      currentVersion - (publishedVersion ?? 0),
    ),
    versions: versions.results,
    messages: messages.results,
  };
}
