import { checkAndIncrement } from "./guard.js";

export async function runWithJudgeQuota(db, day, limit, action) {
  const accepted = await checkAndIncrement(
    db,
    "global:text",
    day,
    limit,
  );
  if (!accepted) return { accepted: false, value: null };
  return { accepted: true, value: await action() };
}
