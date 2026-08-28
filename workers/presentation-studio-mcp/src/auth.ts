import {
  constantTimeEqual,
  hexToBytes,
  randomToken,
  sha256Hex,
  verifyPkce,
} from "./crypto";
import type { AuthPrincipal, Env } from "./types";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 2 * 60 * 1000;
const MAX_OAUTH_BODY_BYTES = 32 * 1024;
const DEFAULT_SCOPES = ["presentation:read", "presentation:write"];

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return headers;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: noStoreHeaders(),
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export function publicOrigin(request: Request, env: Env): string {
  const configured = env.MCP_PUBLIC_ORIGIN?.trim();
  const raw = configured || new URL(request.url).origin;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]")
    )
  ) {
    throw new Error("MCP_PUBLIC_ORIGIN must be HTTPS outside local development");
  }
  return parsed.origin;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || !url.hostname) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function redirectMatches(redirectUrisJson: string, redirectUri: string): boolean {
  let redirectUris: unknown;
  try {
    redirectUris = JSON.parse(redirectUrisJson);
  } catch {
    return false;
  }
  return Array.isArray(redirectUris) && redirectUris.includes(redirectUri);
}

async function bodyWithinLimit(request: Request, limit: number): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  return !contentLength || Number.parseInt(contentLength, 10) <= limit;
}

async function parseRequestBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!(await bodyWithinLimit(request, MAX_OAUTH_BODY_BYTES))) return null;
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as unknown;
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    }
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text).entries());
  } catch {
    return null;
  }
}

async function getClient(
  env: Env,
  clientId: string,
): Promise<{ client_id: string; client_name: string; redirect_uris_json: string } | null> {
  return env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris_json " +
      "FROM presentation_oauth_clients WHERE client_id = ?",
  )
    .bind(clientId)
    .first<{ client_id: string; client_name: string; redirect_uris_json: string }>();
}

function appendOAuthError(
  redirectUri: string,
  error: string,
  state: string | null,
): Response {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await parseRequestBody(request);
  const clientName =
    typeof body?.client_name === "string" ? body.client_name.trim() : "";
  const redirectUris = body?.redirect_uris;
  if (
    !clientName ||
    clientName.length > 200 ||
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 10 ||
    redirectUris.some(
      (value) => typeof value !== "string" || !isAllowedRedirectUri(value),
    )
  ) {
    return jsonResponse({ error: "invalid_client_metadata" }, 400);
  }

  const clientId = "client_" + randomToken(24);
  await env.DB.prepare(
    "INSERT INTO presentation_oauth_clients " +
      "(client_id, client_name, redirect_uris_json) VALUES (?, ?, ?)",
  )
    .bind(clientId, clientName, JSON.stringify(redirectUris))
    .run();

  return jsonResponse(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: DEFAULT_SCOPES.join(" "),
    },
    201,
  );
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const downstreamState = url.searchParams.get("state");

  if (!clientId || !redirectUri) return textResponse("invalid_request", 400);
  const client = await getClient(env, clientId);
  if (!client || !redirectMatches(client.redirect_uris_json, redirectUri)) {
    return textResponse("invalid_client", 400);
  }

  if (
    responseType !== "code" ||
    !codeChallenge ||
    codeChallengeMethod !== "S256" ||
    codeChallenge.length > 256
  ) {
    return appendOAuthError(redirectUri, "invalid_request", downstreamState);
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return textResponse("oauth_provider_not_configured", 503);
  }

  const requestId = crypto.randomUUID();
  const githubState = randomToken(32);
  const expiresAt = new Date(Date.now() + AUTH_REQUEST_TTL_MS).toISOString();
  await env.DB.prepare(
    "INSERT INTO presentation_oauth_requests " +
      "(id, client_id, redirect_uri, downstream_state, code_challenge, " +
      "code_challenge_method, github_state_hash, expires_at) " +
      "VALUES (?, ?, ?, ?, ?, 'S256', ?, ?)",
  )
    .bind(
      requestId,
      clientId,
      redirectUri,
      downstreamState,
      codeChallenge,
      await sha256Hex(githubState),
      expiresAt,
    )
    .run();

  const origin = publicOrigin(request, env);
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", origin + "/oauth/callback");
  github.searchParams.set("scope", "read:user");
  github.searchParams.set("state", githubState);
  return Response.redirect(github.toString(), 302);
}

async function exchangeGithubCode(
  request: Request,
  env: Env,
  code: string,
): Promise<string | null> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "presentation-studio-mcp",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: publicOrigin(request, env) + "/oauth/callback",
    }),
  });
  if (!tokenResponse.ok) return null;
  const tokenBody = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenBody.access_token !== "string") return null;

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + tokenBody.access_token,
      "user-agent": "presentation-studio-mcp",
    },
  });
  if (!userResponse.ok) return null;
  const userBody = (await userResponse.json()) as { login?: unknown };
  return typeof userBody.login === "string" && userBody.login.length <= 200
    ? userBody.login
    : null;
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const githubState = url.searchParams.get("state");
  const githubCode = url.searchParams.get("code");
  if (!githubState) return textResponse("invalid_request", 400);

  const requestRow = await env.DB.prepare(
    "SELECT id, client_id, redirect_uri, downstream_state, code_challenge, " +
      "expires_at, used_at FROM presentation_oauth_requests " +
      "WHERE github_state_hash = ?",
  )
    .bind(await sha256Hex(githubState))
    .first<{
      id: string;
      client_id: string;
      redirect_uri: string;
      downstream_state: string | null;
      code_challenge: string;
      expires_at: string;
      used_at: string | null;
    }>();
  if (
    !requestRow ||
    requestRow.used_at ||
    new Date(requestRow.expires_at).getTime() <= Date.now()
  ) {
    return textResponse("invalid_or_expired_state", 400);
  }

  if (url.searchParams.get("error")) {
    await env.DB.prepare(
      "UPDATE presentation_oauth_requests SET used_at = datetime('now') WHERE id = ?",
    )
      .bind(requestRow.id)
      .run();
    return appendOAuthError(
      requestRow.redirect_uri,
      "access_denied",
      requestRow.downstream_state,
    );
  }
  if (!githubCode) return textResponse("invalid_request", 400);

  const ownerLogin = await exchangeGithubCode(request, env, githubCode);
  if (!ownerLogin) return textResponse("oauth_exchange_failed", 502);

  const used = await env.DB.prepare(
    "UPDATE presentation_oauth_requests SET used_at = datetime('now') " +
      "WHERE id = ? AND used_at IS NULL",
  )
    .bind(requestRow.id)
    .run();
  if (used.meta.changes !== 1) return textResponse("invalid_or_expired_state", 400);

  const authorizationCode = randomToken(32);
  await env.DB.prepare(
    "INSERT INTO presentation_oauth_codes " +
      "(code_hash, client_id, redirect_uri, code_challenge, owner_login, expires_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256Hex(authorizationCode),
      requestRow.client_id,
      requestRow.redirect_uri,
      requestRow.code_challenge,
      ownerLogin,
      new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
    )
    .run();

  const redirect = new URL(requestRow.redirect_uri);
  redirect.searchParams.set("code", authorizationCode);
  if (requestRow.downstream_state) {
    redirect.searchParams.set("state", requestRow.downstream_state);
  }
  return Response.redirect(redirect.toString(), 302);
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  const body = await parseRequestBody(request);
  const grantType = typeof body?.grant_type === "string" ? body.grant_type : "";
  if (grantType === "refresh_token") return handleRefreshToken(body, env);
  if (grantType !== "authorization_code") {
    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }

  const code = typeof body?.code === "string" ? body.code : "";
  const clientId = typeof body?.client_id === "string" ? body.client_id : "";
  const redirectUri =
    typeof body?.redirect_uri === "string" ? body.redirect_uri : "";
  const codeVerifier =
    typeof body?.code_verifier === "string" ? body.code_verifier : "";
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const codeRow = await env.DB.prepare(
    "SELECT code_hash, client_id, redirect_uri, code_challenge, owner_login, " +
      "expires_at, used_at FROM presentation_oauth_codes WHERE code_hash = ?",
  )
    .bind(await sha256Hex(code))
    .first<{
      code_hash: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      owner_login: string;
      expires_at: string;
      used_at: string | null;
    }>();
  if (
    !codeRow ||
    codeRow.used_at ||
    codeRow.client_id !== clientId ||
    codeRow.redirect_uri !== redirectUri ||
    new Date(codeRow.expires_at).getTime() <= Date.now() ||
    !(await verifyPkce(codeVerifier, codeRow.code_challenge))
  ) {
    return jsonResponse({ error: "invalid_grant" }, 400);
  }

  const consumed = await env.DB.prepare(
    "UPDATE presentation_oauth_codes SET used_at = datetime('now') " +
      "WHERE code_hash = ? AND used_at IS NULL",
  )
    .bind(codeRow.code_hash)
    .run();
  if (consumed.meta.changes !== 1) return jsonResponse({ error: "invalid_grant" }, 400);

  return issueTokens(env, codeRow.owner_login);
}

async function handleRefreshToken(
  body: Record<string, unknown> | null,
  env: Env,
): Promise<Response> {
  const refreshToken =
    typeof body?.refresh_token === "string" ? body.refresh_token : "";
  if (!refreshToken) return jsonResponse({ error: "invalid_request" }, 400);
  const row = await env.DB.prepare(
    "SELECT refresh_token_hash, owner_login, refresh_expires_at, revoked_at " +
      "FROM presentation_oauth_tokens WHERE refresh_token_hash = ?",
  )
    .bind(await sha256Hex(refreshToken))
    .first<{
      refresh_token_hash: string;
      owner_login: string;
      refresh_expires_at: string | null;
      revoked_at: string | null;
    }>();
  if (
    !row ||
    row.revoked_at ||
    !row.refresh_expires_at ||
    new Date(row.refresh_expires_at).getTime() <= Date.now()
  ) {
    return jsonResponse({ error: "invalid_grant" }, 400);
  }
  await env.DB.prepare(
    "UPDATE presentation_oauth_tokens SET last_used_at = datetime('now') " +
      "WHERE refresh_token_hash = ?",
  )
    .bind(row.refresh_token_hash)
    .run();
  const response = await issueTokens(env, row.owner_login);
  await env.DB.prepare(
    "UPDATE presentation_oauth_tokens SET revoked_at = datetime('now') " +
      "WHERE refresh_token_hash = ?",
  )
    .bind(row.refresh_token_hash)
    .run();
  return response;
}

async function issueTokens(
  env: Env,
  ownerLogin: string,
): Promise<Response> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  await env.DB.prepare(
    "INSERT INTO presentation_oauth_tokens " +
      "(access_token_hash, refresh_token_hash, owner_login, scopes_json, " +
      "access_expires_at, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256Hex(accessToken),
      await sha256Hex(refreshToken),
      ownerLogin,
      JSON.stringify(DEFAULT_SCOPES),
      accessExpiresAt,
      refreshExpiresAt,
    )
    .run();
  return jsonResponse({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: DEFAULT_SCOPES.join(" "),
  });
}

export async function authenticateMcpRequest(
  request: Request,
  env: Env,
): Promise<AuthPrincipal | null> {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  if (!token || token.length > 512) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT access_token_hash, owner_login, scopes_json, access_expires_at, revoked_at " +
      "FROM presentation_oauth_tokens WHERE access_token_hash = ?",
  )
    .bind(tokenHash)
    .first<{
      access_token_hash: string;
      owner_login: string;
      scopes_json: string;
      access_expires_at: string;
      revoked_at: string | null;
    }>();
  if (
    !row ||
    row.revoked_at ||
    new Date(row.access_expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  try {
    if (!constantTimeEqual(hexToBytes(row.access_token_hash), hexToBytes(tokenHash))) {
      return null;
    }
  } catch {
    return null;
  }

  await env.DB.prepare(
    "UPDATE presentation_oauth_tokens SET last_used_at = datetime('now') " +
      "WHERE access_token_hash = ?",
  )
    .bind(tokenHash)
    .run();
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_json) as unknown;
    if (Array.isArray(parsed)) {
      scopes = parsed.filter((scope): scope is string => typeof scope === "string");
    }
  } catch {
    scopes = [];
  }
  return { ownerId: row.owner_login, scopes };
}

export function unauthorizedResponse(request: Request, env: Env): Response {
  const origin = publicOrigin(request, env);
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      ...Object.fromEntries(noStoreHeaders()),
      "www-authenticate":
        'Bearer resource_metadata="' +
        origin +
        '/.well-known/oauth-protected-resource"',
    },
  });
}

export async function handleOAuthRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/.well-known/oauth-protected-resource" && request.method === "GET") {
    const origin = publicOrigin(request, env);
    return jsonResponse({
      resource: origin + "/mcp",
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: DEFAULT_SCOPES,
    });
  }
  if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") {
    const origin = publicOrigin(request, env);
    return jsonResponse({
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: DEFAULT_SCOPES,
    });
  }
  if (path === "/oauth/register" && request.method === "POST") {
    return handleRegister(request, env);
  }
  if (path === "/oauth/authorize" && request.method === "GET") {
    return handleAuthorize(request, env);
  }
  if (path === "/oauth/callback" && request.method === "GET") {
    return handleCallback(request, env);
  }
  if (path === "/oauth/token" && request.method === "POST") {
    return handleToken(request, env);
  }
  return null;
}
