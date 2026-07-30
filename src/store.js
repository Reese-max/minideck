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
