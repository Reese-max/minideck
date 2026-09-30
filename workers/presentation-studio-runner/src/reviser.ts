import type { DashiJobInput, JsonObject, RunnerEnv } from "./types";
import { claimIntegrityCheck } from "../runner/claim-integrity.mjs";

const MAX_PROMPT_CHARS = 120_000;
const MAX_PATCH_BYTES = 200_000;
const ALLOWED_SLIDE_KEYS = new Set([
  "id",
  "role",
  "purpose",
  "keyMessage",
  "visualIntent",
  "requiredItems",
  "priority",
  "claims",
  "sourceClaimIds",
  "content",
]);

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

function safeClaims(sourceMap: JsonObject): JsonObject[] {
  if (!Array.isArray(sourceMap.claims)) return [];
  return sourceMap.claims
    .filter((claim): claim is JsonObject => {
      if (!isObject(claim)) return false;
      return claim.sensitive !== true && claim.sensitive !== 1 && claim.sensitive !== "true";
    })
    .map((claim) => ({
      claimId: claim.claimId,
      sourceId: claim.sourceId,
      text: claim.text,
      sourceLocation: claim.sourceLocation,
    }));
}

function sourceClaimIds(sourceMap: JsonObject): Set<string> {
  return new Set(
    safeClaims(sourceMap)
      .map((claim) => claim.claimId)
      .filter((claimId): claimId is string => typeof claimId === "string"),
  );
}

function applySlideSpecPatch(
  spec: JsonObject | null,
  patch: JsonObject,
): JsonObject | null {
  if (!spec || !Array.isArray(spec.slides) || !Array.isArray(patch.slides)) return null;
  const patches = new Map<string, JsonObject>();
  for (const slide of patch.slides) {
    if (isObject(slide) && typeof slide.id === "string") patches.set(slide.id, slide);
  }
  const slides = spec.slides.map((slide) => {
    if (!isObject(slide) || typeof slide.id !== "string") return slide;
    const update = patches.get(slide.id);
    return update ? { ...slide, ...update } : slide;
  });
  return { ...spec, slides };
}

function normalizePatch(
  value: JsonObject | null,
  input: DashiJobInput,
  restrictFields = true,
): JsonObject | null {
  if (!value || !Array.isArray(value.slides) || value.slides.length === 0 || value.slides.length > 100) {
    return null;
  }
  if (!input.spec || !Array.isArray(input.spec.slides)) return null;
  const knownSlideIds = new Set(
    input.spec.slides
      .filter((slide): slide is JsonObject => isObject(slide) && typeof slide.id === "string")
      .map((slide) => String(slide.id)),
  );
  const requestedSlideIds = new Set(input.changedSlides);
  const allowedClaimIds = sourceClaimIds(input.sourceMap);
  const seen = new Set<string>();
  const slides: JsonObject[] = [];
  for (const slide of value.slides) {
    if (!isObject(slide) || typeof slide.id !== "string") return null;
    if (!knownSlideIds.has(slide.id) || seen.has(slide.id)) return null;
    if (requestedSlideIds.size > 0 && !requestedSlideIds.has(slide.id)) return null;
    if (restrictFields && Object.keys(slide).some((key) => !ALLOWED_SLIDE_KEYS.has(key))) return null;
    for (const claims of [slide.claims, slide.sourceClaimIds]) {
      if (
        claims !== undefined &&
        (!Array.isArray(claims) ||
          claims.some(
            (claimId) => typeof claimId !== "string" || !allowedClaimIds.has(claimId),
          ))
      ) {
        return null;
      }
    }
    seen.add(slide.id);
    slides.push(slide);
  }
  const patch = { slides };
  if (new TextEncoder().encode(JSON.stringify(patch)).byteLength > MAX_PATCH_BYTES) return null;
  return patch;
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
  if (claimIntegrityCheck(input).exitCode !== 0) {
    return { status: "blocked", error: "CLAIM_INTEGRITY_FAILED" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
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
    });
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
  const patch = normalizePatch(parseJsonObject(responseContent(body)), input);
  const patchedSpec = patch ? applySlideSpecPatch(input.spec, patch) : null;
  if (!patch || !patchedSpec) {
    return { status: "blocked", error: "REVISION_OUTPUT_INVALID_SPEC_PATCH" };
  }
  return { status: "succeeded", specPatch: patch, patchedSpec };
}

export function applyRevisionPatch(
  input: DashiJobInput,
  specPatch: JsonObject,
): DashiJobInput | null {
  const patch = normalizePatch(specPatch, input, false);
  if (!patch) return null;
  const patchedSpec = applySlideSpecPatch(input.spec, patch);
  if (!patchedSpec) return null;
  return {
    ...input,
    spec: patchedSpec,
    changedSlides: (patch.slides as JsonObject[]).map((slide) => String(slide.id)),
    payload: { ...input.payload, specPatch: null },
  };
}
