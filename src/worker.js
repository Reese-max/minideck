import {
  checkAndIncrement,
  ipHash,
  refund,
  verifyTurnstile,
} from "./guard.js";
import { assertD1Initialized, readQuotaCounts } from "./store.js";

const NOT_IMPLEMENTED_ROUTES = [
  ["GET", /^\/api\/projects\/[^/]+$/],
  ["POST", /^\/api\/projects\/[^/]+\/(generate|image|revise|deck)$/],
  ["GET", /^\/api\/projects\/[^/]+\/deck$/],
  ["GET", /^\/img\/[a-f0-9]{8}\.jpg$/],
  ["GET", /^\/p\/[^/]+$/],
];

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function limit(env, name) {
  const value = Number.parseInt(env[name], 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`額度設定無效：${name}`);
  }
  return value;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

async function ipProjectScope(request, salt) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
  return `ip:${await ipHash(ip, salt)}:projects`;
}

async function getQuota(request, env) {
  await assertD1Initialized(env.DB);

  const day = utcDay();
  const ipScope = await ipProjectScope(request, env.IP_SALT);
  const [ipProjects, globalProjects, globalText, globalImages] =
    await readQuotaCounts(env.DB, [
      { scope: ipScope, day },
      { scope: "global:projects", day },
      { scope: "global:text", day },
      { scope: "global:images", day },
    ]);

  return json({
    ipRemaining: {
      projects: Math.max(0, limit(env, "LIMIT_IP_PROJECTS") - ipProjects),
    },
    globalRemaining: {
      projects: Math.max(
        0,
        limit(env, "LIMIT_GLOBAL_PROJECTS") - globalProjects,
      ),
      text: Math.max(0, limit(env, "LIMIT_GLOBAL_TEXT") - globalText),
      images: Math.max(0, limit(env, "LIMIT_GLOBAL_IMAGES") - globalImages),
    },
  });
}

function projectId() {
  const suffix = crypto.getRandomValues(new Uint8Array(4));
  const extraHex = [...suffix]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return crypto.randomUUID().replaceAll("-", "") + extraHex;
}

async function createProject(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "請提供有效的 JSON 請求" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
  if (
    !(await verifyTurnstile(
      body?.turnstileToken,
      env.TURNSTILE_SECRET,
      ip,
    ))
  ) {
    return json({ error: "Turnstile 驗證失敗" }, 403);
  }

  if (typeof body.brief !== "string" || !body.brief.trim()) {
    return json({ error: "請輸入簡報需求" }, 400);
  }

  const brief = body.brief.trim();
  if ([...brief].length > 2000) {
    return json({ error: "簡報需求不可超過 2000 字" }, 413);
  }

  const day = utcDay();
  const hash = await ipHash(ip, env.IP_SALT);
  const ipScope = `ip:${hash}:projects`;
  const globalScope = "global:projects";

  if (
    !(await checkAndIncrement(
      env.DB,
      ipScope,
      day,
      limit(env, "LIMIT_IP_PROJECTS"),
    ))
  ) {
    return json({ error: "今日額度已滿" }, 429);
  }

  if (
    !(await checkAndIncrement(
      env.DB,
      globalScope,
      day,
      limit(env, "LIMIT_GLOBAL_PROJECTS"),
    ))
  ) {
    await refund(env.DB, ipScope, day);
    return json({ error: "今日額度已滿" }, 429);
  }

  const id = projectId();
  try {
    await env.DB.prepare(
      "INSERT INTO projects(id, created_at, ip_hash, brief) VALUES(?1, ?2, ?3, ?4)",
    )
      .bind(id, Date.now(), hash, brief)
      .run();
  } catch (error) {
    await Promise.allSettled([
      refund(env.DB, ipScope, day),
      refund(env.DB, globalScope, day),
    ]);
    throw error;
  }

  return json({ id });
}

function isNotImplemented(method, pathname) {
  return NOT_IMPLEMENTED_ROUTES.some(
    ([routeMethod, pattern]) => routeMethod === method && pattern.test(pathname),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/quota") {
        return await getQuota(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        return await createProject(request, env);
      }

      if (isNotImplemented(request.method, url.pathname)) {
        return json({ error: "此功能尚未實作" }, 501);
      }

      return json({ error: "找不到此路由" }, 404);
    } catch (error) {
      console.error("request_failed", error);
      return json({ error: "服務初始化失敗" }, 500);
    }
  },
};
