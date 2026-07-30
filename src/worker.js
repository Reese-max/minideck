import { assertD1Initialized, readQuotaCounts } from "./store.js";

const NOT_IMPLEMENTED_ROUTES = [
  ["POST", /^\/api\/projects$/],
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
  const bytes = new TextEncoder().encode(ip + salt);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  return `ip:${hash}:projects`;
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
