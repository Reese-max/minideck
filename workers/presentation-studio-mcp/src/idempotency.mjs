export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const object = value;
  return (
    "{" +
    Object.keys(object)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableStringify(object[key]))
      .join(",") +
    "}"
  );
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function beginIdempotency(db, ownerId, toolName, idempotencyKey, input) {
  if (!idempotencyKey) return null;
  if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
    throw new Error("AUTHENTICATED_OWNER_REQUIRED");
  }
  const rawKey = idempotencyKey.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(rawKey)) {
    throw new Error(
      "INVALID_IDEMPOTENCY_KEY: use 8-160 letters, numbers, dot, underscore, colon, or hyphen",
    );
  }

  const key = await sha256Hex(
    stableStringify(["presentation_idempotency:v1", ownerId, rawKey]),
  );
  const requestHash = await sha256Hex(stableStringify([ownerId, input]));
  const existing = await db
    .prepare(
      "SELECT tool_name, request_hash, result_json, expires_at " +
        "FROM presentation_idempotency WHERE idempotency_key = ?",
    )
    .bind(key)
    .first();

  if (existing) {
    if (new Date(existing.expires_at).getTime() > Date.now()) {
      if (existing.tool_name !== toolName || existing.request_hash !== requestHash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED: key belongs to a different request");
      }
      if (existing.result_json === "__pending__") {
        throw new Error("REQUEST_IN_PROGRESS: retry with the same idempotency key later");
      }
      return { existing: JSON.parse(existing.result_json) };
    }
    await db
      .prepare(
        "DELETE FROM presentation_idempotency " +
          "WHERE idempotency_key = ? AND expires_at = ?",
      )
      .bind(key, existing.expires_at)
      .run();
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO presentation_idempotency " +
        "(idempotency_key, tool_name, request_hash, result_json, expires_at) " +
        "VALUES (?, ?, ?, '__pending__', ?)",
    )
    .bind(key, toolName, requestHash, expiresAt)
    .run();
  if (inserted.meta.changes !== 1) {
    const current = await db
      .prepare(
        "SELECT tool_name, request_hash, result_json, expires_at " +
          "FROM presentation_idempotency WHERE idempotency_key = ?",
      )
      .bind(key)
      .first();
    if (
      !current ||
      current.tool_name !== toolName ||
      current.request_hash !== requestHash
    ) {
      throw new Error("IDEMPOTENCY_KEY_REUSED: key belongs to a different request");
    }
    if (current.result_json === "__pending__") {
      throw new Error("REQUEST_IN_PROGRESS: retry with the same idempotency key later");
    }
    return { existing: JSON.parse(current.result_json) };
  }
  return { reservation: { key, requestHash } };
}

async function finishIdempotency(db, reservation, result) {
  await db
    .prepare(
      "UPDATE presentation_idempotency SET result_json = ? " +
        "WHERE idempotency_key = ? AND request_hash = ?",
    )
    .bind(
      JSON.stringify(result),
      reservation.key,
      reservation.requestHash,
    )
    .run();
}

async function releaseIdempotency(db, reservation) {
  await db
    .prepare(
      "DELETE FROM presentation_idempotency " +
        "WHERE idempotency_key = ? AND request_hash = ? AND result_json = '__pending__'",
    )
    .bind(reservation.key, reservation.requestHash)
    .run();
}

export async function runIdempotent(
  db,
  ownerId,
  toolName,
  idempotencyKey,
  input,
  authorize,
  action,
) {
  const authorizedContext = await authorize();
  const reservationState = await beginIdempotency(
    db,
    ownerId,
    toolName,
    idempotencyKey,
    input,
  );
  if (reservationState && "existing" in reservationState) {
    return reservationState.existing;
  }
  if (!reservationState || !("reservation" in reservationState)) {
    return action(authorizedContext);
  }
  try {
    const output = await action(authorizedContext);
    await finishIdempotency(db, reservationState.reservation, output);
    return output;
  } catch (error) {
    await releaseIdempotency(db, reservationState.reservation);
    throw error;
  }
}
