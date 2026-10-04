import {
  applySlideSpecPatch,
  normalizeRevisionPatch,
  safeClaims,
} from "./revision-patch.mjs";
import type { DashiJobInput, JsonObject, RunnerEnv } from "./types";
import { checkClaimBoundary, runWithClaimBoundary } from "../runner/claim-boundary.mjs";

export { applyRevisionPatch } from "./revision-patch.mjs";

const MAX_PROMPT_CHARS = 120_000;

export interface RevisionPlan {
  status: "succeeded" | "blocked";
  specPatch?: JsonObject;
  patchedSpec?: JsonObject;
  error?: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipJson(value: unknown, limit = MAX_PROMPT_CHARS): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= limit ? text : text.slice(0, limit) + "\n[truncated]";
}

function parseJsonObject(content: string): JsonObject | null {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(normalized) as unknown;
    return isObject(value) ? value : null;
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(normalized.slice(start, end + 1)) as unknown;
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function responseContent(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.choices) || !isObject(value.choices[0])) return "";
  const message = value.choices[0].message;
  if (!isObject(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is JsonObject => isObject(part) && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

export async function runRevisionPlanner(
  env: RunnerEnv,
  input: DashiJobInput,
): Promise<RevisionPlan> {
  const endpoint = env.CF_AI_ROUTER_URL?.trim();
  const apiKey = env.CF_AI_ROUTER_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    return {
      status: "blocked",
      error: "REVISION_REQUIRES_SPEC_PATCH_OR_CF_AI_ROUTER_API_KEY",
    };
  }
  if (!input.spec || !Array.isArray(input.spec.slides)) {
    return { status: "blocked", error: "REVISION_SOURCE_SPEC_MISSING" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let response: Response;
  try {
    const request = await runWithClaimBoundary(input, () => fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.CF_AI_ROUTER_MODEL?.trim() || "free-general",
        temperature: 0,
        max_tokens: 4_000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a conservative presentation fixer. Return only a JSON object with a slides array. " +
              "Each slide must contain an existing id and only the fields that need changing. " +
              "Keep claims unchanged or use only verified non-sensitive claim IDs. Do not invent facts, numbers, laws, people, or outcomes. " +
              "Make the smallest targeted change that addresses the instruction.",
          },
          {
            role: "user",
            content: JSON.stringify({
              instruction: input.payload.instruction || "Repair the failed presentation checks.",
              targetSlideIds: input.changedSlides,
              profile: input.profile,
              currentSpec: input.spec,
              audit: input.payload.audit || null,
              verifiedNonSensitiveClaims: safeClaims(input.sourceMap),
            }),
          },
        ],
      }),
      signal: controller.signal,
    }));
    if (!request.allowed) {
      return { status: "blocked", error: request.reason || "CLAIM_BOUNDARY_BLOCKED" };
    }
    response = request.value;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    return { status: "blocked", error: `REVISION_ROUTER_ERROR_${response.status}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { status: "blocked", error: "REVISION_ROUTER_INVALID_JSON" };
  }
  const patch = normalizeRevisionPatch(parseJsonObject(responseContent(body)), input);
  const patchedSpec = patch ? applySlideSpecPatch(input.spec, patch) : null;
  if (!patch || !patchedSpec) {
    return { status: "blocked", error: "REVISION_OUTPUT_INVALID_SPEC_PATCH" };
  }
  if (!checkClaimBoundary(patchedSpec, input.sourceMap, [
    input.profile,
    input.title,
    input.brief,
    input.payload,
    input.sources,
  ]).pass) {
    return { status: "blocked", error: "CLAIM_BOUNDARY_BLOCKED" };
  }
  return { status: "succeeded", specPatch: patch, patchedSpec };
}
