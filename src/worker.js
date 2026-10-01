import {
  checkAndIncrement,
  hashProjectToken,
  ipHash,
  refund,
  verifyProjectToken,
  verifyTurnstile,
} from "./guard.js";
import {
  DEFAULT_STYLE,
  generateImage,
  imageHash,
  isDeckStyle,
  judgeDeck,
  streamDeck,
} from "./minimax.js";
import { htmlToPlainText } from "./judge-core.js";
import { runWithJudgeQuota } from "./judge-quota.js";
import {
  appendProjectMessage,
  assertD1Initialized,
  claimProject,
  deleteProjectData,
  getProject,
  publishDeckVersion,
  readDeck,
  readProjectState,
  readQuotaCounts,
  releaseProject,
  rollbackDeckVersion,
  saveDeckVersion,
  unpublishDeckVersion,
} from "./store.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function requestJson(request, emptyValue = null) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : emptyValue;
  } catch {
    return null;
  }
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

function projectToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function authorizeProject(request, env, id) {
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return { project: null, response: json({ error: "專案識別碼無效" }, 400) };
  }
  const project = await getProject(env.DB, id);
  if (!project) {
    return { project: null, response: json({ error: "專案不存在" }, 404) };
  }

  const token = request.headers.get("X-Project-Token")?.trim();
  if (!(await verifyProjectToken(token, project.access_token_hash))) {
    return { project, response: json({ error: "專案權杖無效" }, 403) };
  }
  return { project, response: null };
}

async function createProject(request, env) {
  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
  if (
    !(await verifyTurnstile(
      body.turnstileToken,
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
  const token = projectToken();
  const tokenHash = await hashProjectToken(token);
  try {
    await env.DB.prepare(
      "INSERT INTO projects(id, created_at, ip_hash, brief, access_token_hash) VALUES(?1, ?2, ?3, ?4, ?5)",
    )
      .bind(id, Date.now(), hash, brief, tokenHash)
      .run();
  } catch (error) {
    await Promise.allSettled([
      refund(env.DB, ipScope, day),
      refund(env.DB, globalScope, day),
    ]);
    throw error;
  }

  return json({ id, token });
}

async function reserveText(env, id, reserveRevise) {
  const day = utcDay();
  if (
    !(await checkAndIncrement(
      env.DB,
      "global:text",
      day,
      limit(env, "LIMIT_GLOBAL_TEXT"),
    ))
  ) {
    return null;
  }

  if (
    reserveRevise &&
    !(await checkAndIncrement(
      env.DB,
      `proj:${id}:revises`,
      "all",
      limit(env, "LIMIT_PROJECT_REVISES"),
    ))
  ) {
    await refund(env.DB, "global:text", day);
    return null;
  }
  return day;
}

function publicTextError(error) {
  const message = error?.message ?? "";
  return /^(MiniMax|伺服器未設定)/.test(message)
    ? message
    : "簡報生成失敗，請稍後再試";
}

async function settleTextFailure(env, id, day, error, reviseReserved) {
  let refunded = false;
  try {
    refunded = await checkAndIncrement(
      env.DB,
      `proj:${id}:retries`,
      "all",
      limit(env, "LIMIT_PROJECT_RETRIES"),
    );
    if (refunded) await refund(env.DB, "global:text", day);
    if (reviseReserved) {
      await refund(env.DB, `proj:${id}:revises`, "all");
    }
  } finally {
    await releaseProject(env.DB, id);
  }
  console.log(
    "text_failure_settled",
    `action=${reviseReserved ? "revise" : "generate"}`,
    `class=${error?.failureClass ?? "unclassified"}`,
    `refunded=${refunded}`,
  );
  return { message: publicTextError(error), refunded };
}

async function generateDeck(request, env, ctx, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const body = await requestJson(request, {});
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  const style = body.style === undefined ? DEFAULT_STYLE : body.style;
  if (!isDeckStyle(style)) return json({ error: "簡報風格無效" }, 400);
  if (body.sourceData !== undefined && typeof body.sourceData !== "string") {
    return json({ error: "參考資料格式無效" }, 400);
  }
  const sourceData = body.sourceData?.trim() ?? "";
  if ([...sourceData].length > 3000) {
    return json({ error: "參考資料不可超過 3000 字" }, 413);
  }

  const claimed = await claimProject(env.DB, id);
  if (claimed === null) return json({ error: "專案不存在" }, 404);
  if (!claimed) return json({ error: "專案正在生成中" }, 409);

  const project = access.project;
  const day = await reserveText(env, id, false);
  if (!day) {
    await releaseProject(env.DB, id);
    return json({ error: "今日額度已滿" }, 429);
  }

  return streamDeck({
    apiKey: env.MINIMAX_API_KEY,
    messages: [
      {
        role: "user",
        content: `請依以下需求產生簡報：\n${project.brief}`,
      },
    ],
    style,
    sourceData,
    ctx,
    signal: request.signal,
    onComplete: async (html) => {
      const version = await saveDeckVersion(
        env.DB,
        env.BUCKET,
        id,
        html,
        "generate",
      );
      return { version, deckPath: `/api/projects/${id}/deck?version=${version}` };
    },
    onFailure: (error) => settleTextFailure(env, id, day, error, false),
  });
}

async function rollbackDeck(request, env, id) {
  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  if (!Number.isInteger(body.version) || body.version < 1) {
    return json({ error: "版本編號無效" }, 400);
  }

  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const claimed = await claimProject(env.DB, id);
  if (claimed === null) return json({ error: "專案不存在" }, 404);
  if (!claimed) return json({ error: "專案正在生成中" }, 409);

  try {
    const result = await rollbackDeckVersion(
      env.DB,
      env.BUCKET,
      id,
      body.version,
    );
    if (!result.version) {
      await releaseProject(env.DB, id);
      return json(
        { error: result.project ? "找不到簡報版本" : "專案不存在" },
        404,
      );
    }
    return json({ version: result.version });
  } catch (error) {
    await releaseProject(env.DB, id);
    throw error;
  }
}

async function judgeDeckVersion(request, env, id) {
  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  if (!Number.isInteger(body.version) || body.version < 1) {
    return json({ error: "版本編號無效" }, 400);
  }

  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const source = await readDeck(env.DB, env.BUCKET, id, body.version);
  if (!source.project) return json({ error: "專案不存在" }, 404);
  if (!source.deck) return json({ error: "找不到簡報版本" }, 404);

  const day = utcDay();
  try {
    const reservation = await runWithJudgeQuota(
      env.DB,
      day,
      limit(env, "LIMIT_GLOBAL_TEXT"),
      async () => {
        const html = await source.deck.object.text();
        const result = await judgeDeck(
          env.MINIMAX_API_KEY,
          htmlToPlainText(html, 8000),
        );
        await appendProjectMessage(
          env.DB,
          id,
          "judge",
          JSON.stringify({ version: body.version, ...result }),
        );
        return result;
      },
    );
    if (!reservation.accepted) {
      console.log(
        "judge_quota_rejected",
        `project=${id}`,
        `version=${body.version}`,
        "minimax_requests=0",
      );
      return json({ error: "今日額度已滿" }, 429);
    }
    return json(reservation.value);
  } catch (error) {
    await refund(env.DB, "global:text", day);
    console.error(
      "judge_failed",
      `project=${id}`,
      `version=${body.version}`,
      error,
    );
    return json({ error: publicTextError(error) }, 502);
  }
}

async function reviseDeck(request, env, ctx, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "請輸入修訂指令" }, 400);
  }
  const message = body.message.trim();
  if ([...message].length > 1000) {
    return json({ error: "修訂指令不可超過 1000 字" }, 413);
  }

  const current = await readDeck(env.DB, env.BUCKET, id);
  if (!current.project) return json({ error: "專案不存在" }, 404);
  if (!current.deck) return json({ error: "找不到可修訂的簡報" }, 404);

  const claimed = await claimProject(env.DB, id);
  if (!claimed) return json({ error: "專案正在生成中" }, 409);

  const day = await reserveText(env, id, true);
  if (!day) {
    await releaseProject(env.DB, id);
    return json({ error: "今日額度已滿" }, 429);
  }
  const html = await current.deck.object.text();

  return streamDeck({
    apiKey: env.MINIMAX_API_KEY,
    messages: [
      {
        role: "user",
        content: `以下是目前最新版 HTML 簡報：\n${html}\n\n請依指令修訂並輸出完整新版 HTML：\n${message}`,
      },
    ],
    ctx,
    signal: request.signal,
    onComplete: async (revisedHtml) => {
      const version = await saveDeckVersion(
        env.DB,
        env.BUCKET,
        id,
        revisedHtml,
        "revise",
        { user: message, assistant: revisedHtml },
      );
      return { version, deckPath: `/api/projects/${id}/deck?version=${version}` };
    },
    onFailure: (error) => settleTextFailure(env, id, day, error, true),
  });
}

async function generateProjectImage(request, env, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  if (
    typeof body.prompt !== "string" ||
    !body.prompt.trim() ||
    [...body.prompt.trim()].length > 1500
  ) {
    return json({ error: "圖片描述不可為空，且不得超過 1500 字" }, 400);
  }
  const prompt = body.prompt.trim();
  const aspectRatio = body.ar ?? "16:9";
  if (aspectRatio !== "16:9") {
    return json({ error: "圖片比例只支援 16:9" }, 400);
  }

  const hash = await imageHash(prompt, aspectRatio);
  const key = `images/${hash}.jpg`;
  if (await env.BUCKET.head(key)) {
    console.log("minimax_image_cache_hit", `hash=${hash}`, "minimax_requests=0");
    return json({ url: `/img/${hash}.jpg` });
  }

  const day = utcDay();
  const projectScope = `proj:${id}:images`;
  const [projectImages, globalImages] = await readQuotaCounts(env.DB, [
    { scope: projectScope, day: "all" },
    { scope: "global:images", day },
  ]);
  if (
    projectImages >= limit(env, "LIMIT_PROJECT_IMAGES") ||
    globalImages >= limit(env, "LIMIT_GLOBAL_IMAGES")
  ) {
    return json({ error: "今日額度已滿" }, 429);
  }

  const projectReserved = await checkAndIncrement(
    env.DB,
    projectScope,
    "all",
    limit(env, "LIMIT_PROJECT_IMAGES"),
  );
  if (!projectReserved) return json({ error: "今日額度已滿" }, 429);

  const globalReserved = await checkAndIncrement(
    env.DB,
    "global:images",
    day,
    limit(env, "LIMIT_GLOBAL_IMAGES"),
  );
  if (!globalReserved) {
    await refund(env.DB, projectScope, "all");
    return json({ error: "今日額度已滿" }, 429);
  }

  const releaseImageQuota = () =>
    Promise.allSettled([
      refund(env.DB, projectScope, "all"),
      refund(env.DB, "global:images", day),
    ]);

  let generated;
  try {
    generated = await generateImage(
      env.MINIMAX_API_KEY,
      prompt,
      aspectRatio,
      hash,
    );
  } catch (error) {
    await releaseImageQuota();
    console.error("image_generation_error", error);
    return json({ error: "MiniMax 圖片生成失敗" }, 502);
  }

  try {
    await env.BUCKET.put(key, generated.image, {
      httpMetadata: { contentType: generated.contentType },
    });
  } catch (error) {
    await releaseImageQuota();
    console.error("image_storage_error", error);
    return json({ error: "圖片保存失敗" }, 502);
  }

  return json({ url: `/img/${hash}.jpg` });
}

async function saveDeck(request, env, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  if (typeof body.html !== "string") {
    return json({ error: "請提供 HTML 簡報" }, 400);
  }
  if (new TextEncoder().encode(body.html).byteLength > 2 * 1024 * 1024) {
    return json({ error: "HTML 簡報不可超過 2MB" }, 413);
  }
  if (
    (body.html.match(/<section\s+class=["']slide["'][^>]*>/gi) ?? []).length < 3
  ) {
    return json({ error: "HTML 簡報至少需要 3 頁" }, 400);
  }
  if ((body.html.match(/data-gen-prompt\s*=/gi) ?? []).length > 12) {
    return json({ error: "HTML 簡報的圖片佔位符不可超過 12 個" }, 400);
  }

  const claimed = await claimProject(env.DB, id);
  if (claimed === null) return json({ error: "專案不存在" }, 404);
  if (!claimed) return json({ error: "專案正在生成中" }, 409);

  try {
    const version = await saveDeckVersion(
      env.DB,
      env.BUCKET,
      id,
      body.html,
      typeof body.origin === "string" && body.origin ? body.origin : "imagefill",
    );
    if (version === null) {
      await releaseProject(env.DB, id);
      return json({ error: "專案不存在" }, 404);
    }
    return json({ version });
  } catch (error) {
    await releaseProject(env.DB, id);
    throw error;
  }
}

async function publishDeck(request, env, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const body = await requestJson(request);
  if (!body) return json({ error: "請提供有效的 JSON 請求" }, 400);
  if (!Number.isInteger(body.version) || body.version < 1) {
    return json({ error: "版本編號無效" }, 400);
  }

  const published = await publishDeckVersion(env.DB, env.BUCKET, id, body.version);
  if (!published) return json({ error: "找不到簡報版本" }, 404);
  return json({
    published: true,
    version: published.version,
    published_at: published.publishedAt,
  });
}

async function unpublishDeck(request, env, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  await unpublishDeckVersion(env.DB, id);
  return json({ published: false });
}

async function deleteProject(request, env, id) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  const claimed = await claimProject(env.DB, id);
  if (claimed === null) return json({ error: "專案不存在" }, 404);
  if (!claimed) return json({ error: "專案正在生成中" }, 409);

  try {
    const result = await deleteProjectData(env.DB, env.BUCKET, id);
    if (!result) return json({ error: "專案不存在" }, 404);
    if (result.cleanupPending > 0) {
      await releaseProject(env.DB, id);
      return json({ deleted: false, cleanupPending: result.cleanupPending }, 503);
    }
    return json({ deleted: true, cleanupPending: result.cleanupPending });
  } catch (error) {
    await releaseProject(env.DB, id);
    throw error;
  }
}

async function getDeckResponse(request, env, id, versionText) {
  const access = await authorizeProject(request, env, id);
  if (access.response) return access.response;

  let version;
  if (versionText !== null) {
    if (!/^\d+$/.test(versionText) || Number(versionText) < 1) {
      return json({ error: "版本編號無效" }, 400);
    }
    version = Number(versionText);
  }

  const result = await readDeck(env.DB, env.BUCKET, id, version);
  if (!result.project) return json({ error: "專案不存在" }, 404);
  if (!result.deck) return json({ error: "找不到簡報版本" }, 404);

  const headers = new Headers({ "cache-control": "no-store" });
  result.deck.object.writeHttpMetadata(headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(result.deck.object.body, { headers });
}

async function getImageResponse(env, hash) {
  const object = await env.BUCKET.get(`images/${hash}.jpg`);
  if (!object) return json({ error: "找不到圖片" }, 404);

  const headers = new Headers({
    "cache-control": "public, max-age=31536000, immutable",
  });
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

// Every anonymous miss on the public player answers with one identical body so
// a shared link holder cannot tell an unpublished project, a dangling head and a
// missing project apart by status code or error text.
function playerNotFound() {
  return json({ error: "找不到可播放的簡報" }, 404);
}

async function getPlayerResponse(request, env, id) {
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return json({ error: "專案識別碼無效" }, 400);
  }
  const url = new URL(request.url);
  const versionText = url.searchParams.get("version");
  let requestedVersion = null;
  if (versionText !== null) {
    if (!/^\d+$/.test(versionText) || Number(versionText) < 1) {
      return json({ error: "版本編號無效" }, 400);
    }
    requestedVersion = Number(versionText);
  }

  const project = await getProject(env.DB, id);
  if (!project) return playerNotFound();

  // The public player only ever serves published_version. Any other version
  // is a draft preview reserved for the owner behind X-Project-Token.
  const publishedVersion = Number(project.published_version ?? 0);
  const version = requestedVersion ?? publishedVersion;

  if (version !== publishedVersion) {
    const token = request.headers.get("X-Project-Token")?.trim();
    if (!(await verifyProjectToken(token, project.access_token_hash))) {
      // An unpublished project answers every anonymous path with 404 so the
      // existence of drafts cannot be probed through status codes. A head that
      // no longer renders is treated the same way, so a 403 can never confirm
      // that a project exists and once had a public head.
      if (publishedVersion < 1) return playerNotFound();
      const head = await readDeck(env.DB, env.BUCKET, id, publishedVersion);
      if (!head.project || !head.deck) return playerNotFound();
      return json({ error: "版本未公開發佈，需專案權杖" }, 403);
    }
  }
  if (!Number.isInteger(version) || version < 1) return playerNotFound();

  const result = await readDeck(env.DB, env.BUCKET, id, version);
  // A concurrent DELETE can still retire the project between the two reads.
  if (!result.project) return playerNotFound();
  if (!result.deck) return playerNotFound();

  const templateResponse = await env.ASSETS.fetch(
    new URL("/play.html", request.url),
  );
  if (!templateResponse.ok) throw new Error("找不到播放頁模板");
  const [template, deck] = await Promise.all([
    templateResponse.text(),
    result.deck.object.text(),
  ]);
  if (!template.includes("__MINIDECK_DECK_HTML__")) {
    throw new Error("播放頁模板缺少 deck 插入點");
  }

  return new Response(
    template.replace("__MINIDECK_DECK_HTML__", () => escapeHtml(deck)),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/quota") {
        return await getQuota(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        return await createProject(request, env);
      }

      const deckMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/deck$/);
      if (deckMatch && request.method === "GET") {
        return await getDeckResponse(request, env, deckMatch[1], url.searchParams.get("version"));
      }
      if (deckMatch && request.method === "POST") {
        return await saveDeck(request, env, deckMatch[1]);
      }

      const actionMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/(generate|revise|image|rollback|judge|publish|unpublish)$/,
      );
      if (actionMatch && request.method === "POST") {
        const [, id, action] = actionMatch;
        if (action === "generate") {
          return await generateDeck(request, env, ctx, id);
        }
        if (action === "revise") return await reviseDeck(request, env, ctx, id);
        if (action === "rollback") return await rollbackDeck(request, env, id);
        if (action === "judge") return await judgeDeckVersion(request, env, id);
        if (action === "publish") return await publishDeck(request, env, id);
        if (action === "unpublish") return await unpublishDeck(request, env, id);
        return await generateProjectImage(request, env, id);
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && request.method === "DELETE") {
        return await deleteProject(request, env, projectMatch[1]);
      }
      if (projectMatch && request.method === "GET") {
        const access = await authorizeProject(request, env, projectMatch[1]);
        if (access.response) return access.response;
        const state = await readProjectState(env.DB, projectMatch[1]);
        return state
          ? json(state)
          : json({ error: "專案不存在" }, 404);
      }

      const imageMatch = url.pathname.match(/^\/img\/([a-f0-9]{8})\.jpg$/);
      if (imageMatch && request.method === "GET") {
        return await getImageResponse(env, imageMatch[1]);
      }

      const playerMatch = url.pathname.match(/^\/p\/([^/]+)$/);
      if (playerMatch && request.method === "GET") {
        return await getPlayerResponse(request, env, playerMatch[1]);
      }
      return json({ error: "找不到此路由" }, 404);
    } catch (error) {
      console.error("request_failed", error);
      // A missing migration is an operator error, not a runtime fault: name it
      // instead of hiding it behind a generic 500 that only the logs explain.
      if (/D1 schema|缺少 DB 綁定/.test(String(error?.message ?? ""))) {
        return json({ error: error.message }, 503);
      }
      return json({ error: "服務處理失敗" }, 500);
    }
  },
};
