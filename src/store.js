const REQUIRED_TABLES = ["projects", "versions", "messages", "quotas"];

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
      "SELECT id, brief, current_version, status FROM projects WHERE id = ?1",
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

  await bucket.put(r2Key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await db.batch(statements);
  return version;
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

  return {
    status: project.status,
    versions: versions.results,
    messages: messages.results,
  };
}
