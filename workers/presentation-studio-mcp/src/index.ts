import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
  authenticateMcpRequest,
  handleOAuthRequest,
  unauthorizedResponse,
} from "./auth";
import { handleJobApi } from "./jobs";
import { registerPresentationTools } from "./presentation";
import type { Env } from "./types";

const TOOL_COUNT = 8;

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function originHostnames(value: string | undefined): string[] {
  return csv(value).map((item) => {
    try {
      return new URL(item).hostname;
    } catch {
      return item.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    }
  });
}

function createServer(env: Env, ownerId: string, scopes: string[]): McpServer {
  const server = new McpServer({
    name: "presentation-studio-mcp",
    version: "2.0.0",
  });
  registerPresentationTools(server, env, ownerId, scopes);
  return server;
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const requestedOrigin = request.headers.get("origin");
  const allowed = csv(env.MCP_ALLOWED_ORIGINS);
  if (requestedOrigin && (allowed.length === 0 || allowed.includes(requestedOrigin))) {
    headers.set("access-control-allow-origin", requestedOrigin);
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Authorization, Content-Type, mcp-protocol-version, mcp-session-id, Last-Event-ID",
  );
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  return headers;
}

function healthResponse(): Response {
  return Response.json(
    {
      status: "ok",
      version: "2.0.0",
      openDesignEnabled: false,
      renderer: "dashi",
      tools: TOOL_COUNT,
      phase: "A",
      runner: "dashi-container-pending",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      const oauthResponse = await handleOAuthRequest(request, env);
      if (oauthResponse) return oauthResponse;

      if (url.pathname === "/health" && request.method === "GET") {
        return healthResponse();
      }

      const jobResponse = await handleJobApi(request, env);
      if (jobResponse) return jobResponse;

      if (url.pathname !== "/mcp") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      const principal = await authenticateMcpRequest(request, env);
      if (!principal) return unauthorizedResponse(request, env);
      if (!principal.scopes.includes("presentation:read")) {
        return new Response(JSON.stringify({ error: "insufficient_scope" }), {
          status: 403,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "www-authenticate": 'Bearer error="insufficient_scope"',
          },
        });
      }

      const allowedHostnames = csv(env.MCP_ALLOWED_HOSTNAMES);
      const allowedOriginHostnames = originHostnames(env.MCP_ALLOWED_ORIGINS);
      const handler = createMcpHandler(
        () => createServer(env, principal.ownerId, principal.scopes),
        {
          route: "/mcp",
          legacy: "reject",
          ...(allowedHostnames.length > 0 ? { allowedHostnames } : {}),
          ...(allowedOriginHostnames.length > 0
            ? { allowedOriginHostnames }
            : {}),
          ...(allowedOriginHostnames.length > 0
            ? { corsOptions: { origin: "https://" + allowedOriginHostnames[0] } }
            : {}),
          onerror: (error) => {
            console.error(
              JSON.stringify({
                component: "presentation-studio-mcp",
                message: error.message,
              }),
            );
          },
        },
      );
      return await handler(request, env, ctx);
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "presentation-studio-mcp",
          path: url.pathname,
          message: error instanceof Error ? error.message : "unknown_error",
        }),
      );
      if (url.pathname === "/mcp") {
        return new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
