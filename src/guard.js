const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, secret, ip) {
  if (typeof token !== "string" || !token || !secret) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return false;
    return (await response.json()).success === true;
  } catch {
    return false;
  }
}

export async function checkAndIncrement(db, scope, day, limit) {
  if (limit <= 0) return false;

  const result = await db
    .prepare(
      `INSERT INTO quotas(scope,day,count) VALUES(?1,?2,1)
       ON CONFLICT(scope,day) DO UPDATE SET count = count+1 WHERE count < ?3`,
    )
    .bind(scope, day, limit)
    .run();

  return Number(result.meta?.changes ?? 0) > 0;
}

export async function refund(db, scope, day) {
  await db
    .prepare(
      "UPDATE quotas SET count = max(0, count - 1) WHERE scope = ?1 AND day = ?2",
    )
    .bind(scope, day)
    .run();
}

export async function ipHash(ip, salt) {
  if (!salt) throw new Error("缺少 IP_SALT");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip + salt),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
