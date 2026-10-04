import { base64FromBytes, sha256Hex } from "./crypto";
import { checkJudgeBoundary, runWithJudgeBoundary } from "../runner/claim-boundary.mjs";
import type { DashiAudit, DashiJobInput, DashiJobResult, JsonObject, RunnerEnv } from "./types";
import { shouldRunJudges } from "../runner/claim-integrity.mjs";
import {
  aggregateVisualReports,
  expectedPreviewSheets,
  previewArtifactsCoverSpec,
  previewSheetRank,
  specSlideIds,
  visualCoverageSatisfied,
} from "../runner/visual-coverage.mjs";

const MAX_JUDGE_PROMPT_CHARS = 120_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

interface JudgeIssue {
  severity: string;
  message: string;
}

interface JudgeReport {
  score: number;
  everySlideScoreMin: number;
  pass: boolean;
  issues: JudgeIssue[];
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipJson(value: unknown, limit = MAX_JUDGE_PROMPT_CHARS): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= limit ? text : text.slice(0, limit) + "\n[truncated]";
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

function parseJson(content: string): JsonObject | null {
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

function normalizeJudge(value: JsonObject | null): JudgeReport {
  const score = typeof value?.score === "number" ? Math.max(0, Math.min(100, Math.round(value.score))) : 0;
  const everySlideScoreMin = typeof value?.everySlideScoreMin === "number"
    ? Math.max(0, Math.min(100, Math.round(value.everySlideScoreMin)))
    : score;
  const issues = Array.isArray(value?.issues)
    ? value.issues.slice(0, 50).map((issue): JudgeIssue => {
        if (typeof issue === "string") return { severity: "major", message: issue.slice(0, 500) };
        if (isObject(issue)) {
          const severity = typeof issue.severity === "string"
            ? issue.severity.toLowerCase()
            : "major";
          return {
            severity: severity === "critical" ? "blocker" : severity,
            message: typeof issue.message === "string"
              ? issue.message.slice(0, 500)
              : (JSON.stringify(issue) ?? "invalid_issue").slice(0, 500),
          };
        }
        return { severity: "major", message: "judge_returned_invalid_issue" };
      })
    : [];
  const hasMajorOrBlocker = issues.some(
    (issue) => issue.severity === "major" || issue.severity === "blocker",
  );
  const pass =
    value?.pass === true &&
    score >= 80 &&
    everySlideScoreMin >= 80 &&
    !hasMajorOrBlocker;
  return { score, everySlideScoreMin, pass, issues };
}

async function callRouter(
  env: RunnerEnv,
  model: string,
  messages: JsonObject[],
): Promise<JudgeReport> {
  const endpoint = env.CF_AI_ROUTER_URL?.trim();
  const apiKey = env.CF_AI_ROUTER_API_KEY?.trim();
  if (!endpoint || !apiKey) throw new Error("JUDGES_NOT_CONFIGURED");
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
        model,
        temperature: 0,
        max_tokens: 2_000,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`JUDGE_ROUTER_ERROR_${response.status}`);
  const body = JSON.parse(await response.text()) as unknown;
  const report = normalizeJudge(parseJson(responseContent(body)));
  if (report.score === 0 && report.issues.length === 0 && !report.pass) {
    throw new Error("JUDGE_OUTPUT_INVALID");
  }
  return report;
}

function baseAuditForFailure(audit: DashiAudit, reason: string): DashiAudit {
  return {
    ...audit,
    allHardGatesPass: false,
    judgesComplete: false,
    visualJudgePass: false,
    factualJudgePass: false,
    blockedReason: reason,
  };
}

function reportWithJudgeStatus(
  result: DashiJobResult,
  status: string,
  reason?: string,
): DashiJobResult {
  return {
    ...result,
    rendererReport: {
      ...(result.rendererReport || {}),
      judgeStatus: status,
      ...(reason ? { judgeReason: reason } : {}),
    },
  };
}

async function blockedJudgeResult(
  env: RunnerEnv,
  input: DashiJobInput,
  result: DashiJobResult,
  audit: DashiAudit,
  reason: string,
): Promise<DashiJobResult> {
  const next = reportWithJudgeStatus(
    { ...result, version: { ...result.version!, audit: baseAuditForFailure(audit, reason) } },
    "blocked",
    reason,
  );
  await updateAuditArtifact(env, input, next, next.version!.audit);
  return next;
}

function safeFactualContext(sourceMap: JsonObject): JsonObject {
  const claims = Array.isArray(sourceMap.claims)
    ? sourceMap.claims
        .filter((claim): claim is JsonObject => {
          if (!isObject(claim)) return false;
          return claim.sensitive !== true && claim.sensitive !== 1 && claim.sensitive !== "true";
        })
        .map((claim) => ({
          claimId: claim.claimId,
          sourceId: claim.sourceId,
          text: claim.text,
          sourceLocation: claim.sourceLocation,
          confidence: claim.confidence,
        }))
    : [];
  return { schemaVersion: sourceMap.schemaVersion || "1.0.0", claims };
}

function claimBindings(spec: JsonObject | null): Array<{ slideId: string; claimIds: string[] }> {
  if (!spec || !Array.isArray(spec.slides)) return [];
  return spec.slides
    .filter((slide): slide is JsonObject => isObject(slide) && typeof slide.id === "string")
    .map((slide) => {
      const values = Array.isArray(slide.claims)
        ? slide.claims
        : Array.isArray(slide.sourceClaimIds)
          ? slide.sourceClaimIds
          : [];
      return {
        slideId: String(slide.id),
        claimIds: values
          .filter((claimId): claimId is string => typeof claimId === "string")
          .slice(0, 100),
      };
    })
    .filter((binding) => binding.claimIds.length > 0);
}

async function updateAuditArtifact(
  env: RunnerEnv,
  input: DashiJobInput,
  result: DashiJobResult,
  audit: DashiAudit,
): Promise<void> {
  const artifact = result.artifacts?.find((item) => item.kind === "audit");
  if (!artifact) return;
  const prefix = env.R2_PREFIX?.trim() || "presentation-studio/";
  const expectedPrefix = `${prefix.endsWith("/") ? prefix : prefix + "/"}projects/${input.projectId}/jobs/${input.jobId}/`;
  if (!artifact.r2Key.startsWith(expectedPrefix)) return;
  const bytes = new TextEncoder().encode(JSON.stringify(audit, null, 2));
  await env.BUCKET.put(artifact.r2Key, bytes, {
    httpMetadata: { contentType: "application/json" },
  });
  artifact.byteSize = bytes.byteLength;
  artifact.sha256 = await sha256Hex(bytes);
}

export async function runJudges(
  env: RunnerEnv,
  input: DashiJobInput,
  result: DashiJobResult,
): Promise<DashiJobResult> {
  if (!result.version) return result;
  const audit = result.version.audit;
  if (!shouldRunJudges(result)) {
    return { status: "blocked", jobId: input.jobId, error: "CLAIM_INTEGRITY_FAILED" };
  }
  if (!checkJudgeBoundary(input, result).pass) {
    return { status: "blocked", jobId: input.jobId, error: "CLAIM_BOUNDARY_BLOCKED" };
  }
  if (!env.CF_AI_ROUTER_URL?.trim() || !env.CF_AI_ROUTER_API_KEY?.trim()) {
    return blockedJudgeResult(env, input, result, audit, "JUDGES_NOT_CONFIGURED");
  }
  const versionSlideIds = specSlideIds(result.version.spec);
  const versionSlideCount =
    isObject(result.version.spec) && Array.isArray(result.version.spec.slides)
      ? result.version.spec.slides.length
      : 0;
  const coverage = audit.visualCoverage;
  if (!visualCoverageSatisfied(coverage, versionSlideIds, versionSlideCount)) {
    return blockedJudgeResult(env, input, result, audit, "VISUAL_COVERAGE_INCOMPLETE");
  }
  const expectedSheets = expectedPreviewSheets(versionSlideIds);
  const sheetArtifacts = (result.artifacts ?? [])
    .filter((item) => previewSheetRank(item.kind) >= 0)
    .sort((a, b) => previewSheetRank(a.kind) - previewSheetRank(b.kind));
  if (
    sheetArtifacts.length === 0 ||
    coverage?.sheetCount !== expectedSheets.length ||
    !previewArtifactsCoverSpec(
      sheetArtifacts.map((artifact) => artifact.kind),
      versionSlideIds,
    )
  ) {
    return blockedJudgeResult(env, input, result, audit, "VISUAL_PREVIEW_SHEETS_MISSING");
  }
  const sheetBytes: Uint8Array[] = [];
  const prefix = env.R2_PREFIX?.trim() || "presentation-studio/";
  const expectedPrefix = `${prefix.endsWith("/") ? prefix : prefix + "/"}projects/${input.projectId}/jobs/${input.jobId}/`;
  for (const sheet of sheetArtifacts) {
    // Each sheet must be the exact object the storage endpoint would have
    // derived for this job + kind; a claimed key pointing elsewhere (or a
    // duplicate of another sheet's key) fails closed.
    if (sheet.r2Key !== `${expectedPrefix}${sheet.kind}.png`) {
      return blockedJudgeResult(env, input, result, audit, "PREVIEW_ARTIFACT_UNAVAILABLE");
    }
    const object = await env.BUCKET.get(sheet.r2Key);
    if (!object || object.size > MAX_PREVIEW_BYTES) {
      return blockedJudgeResult(env, input, result, audit, "PREVIEW_ARTIFACT_UNAVAILABLE");
    }
    sheetBytes.push(new Uint8Array(await object.arrayBuffer()));
  }
  const visualMessages = sheetArtifacts.map((artifact, index) => {
    const slideIds = expectedSheets[index]?.slideIds ?? [];
    const messages: JsonObject[] = [
      {
        role: "system",
        content: "You are an independent presentation visual judge. Return JSON only with score, everySlideScoreMin, pass, and issues. Judge projection readability, hierarchy, density, consistency, and audience fit for the contact sheet, which covers only the listed slide ids. Do not excuse defects because the renderer claims success. pass requires score >= 80, everySlideScoreMin >= 80, and no blocker or major issue.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Profile guidelines and covered slide ids ${JSON.stringify(slideIds)}:\n${clipJson({ profile: input.profile, spec: result.version!.spec }, 100_000)}`,
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64FromBytes(sheetBytes[index])}`, detail: "high" },
          },
        ],
      },
    ];
    return messages;
  });
  const factualSpec = input.spec || result.version.spec;
  const factualMessages: JsonObject[] = [
    {
      role: "system",
      content: "You are an independent factual/source judge. Return JSON only with score, everySlideScoreMin, pass, and issues. Check claim IDs, numbers, conclusions, terminology, and whether the slide spec stays within the supplied source map. Treat unsupported or invented claims as major issues. pass requires score >= 80, everySlideScoreMin >= 80, and no blocker or major issue.",
    },
    {
      role: "user",
      content: `Slide spec:\n${clipJson(factualSpec, 85_000)}\n\nVerified non-sensitive claims:\n${clipJson(safeFactualContext(input.sourceMap), 35_000)}`,
    },
  ];

  let visual: JudgeReport;
  let factual: JudgeReport;
  try {
    const judgeCalls = await runWithJudgeBoundary(input, result, () => Promise.all([
      Promise.all(visualMessages.map((messages) => callRouter(env, "free-vision", messages))),
      callRouter(env, env.CF_AI_ROUTER_MODEL?.trim() || "free-general", factualMessages),
    ]));
    if (!judgeCalls.allowed) {
      return { status: "blocked", jobId: input.jobId, error: judgeCalls.reason || "CLAIM_BOUNDARY_BLOCKED" };
    }
    const [sheetReports, factualReport] = judgeCalls.value;
    visual = aggregateVisualReports(sheetReports);
    factual = factualReport;
  } catch (error) {
    const failedAudit = baseAuditForFailure(
      audit,
      error instanceof Error ? error.message.slice(0, 200) : "JUDGE_CALL_FAILED",
    );
    return reportWithJudgeStatus(
      { ...result, version: { ...result.version, audit: failedAudit } },
      "failed",
      failedAudit.blockedReason,
    );
  }

  const technicalPass = Object.values(audit.deterministic).every(Boolean);
  const majorIssues = [...visual.issues, ...factual.issues]
    .filter((issue) => issue.severity === "major").length;
  const blockerIssues = [...visual.issues, ...factual.issues]
    .filter((issue) => issue.severity === "blocker").length;
  const judgedAudit: DashiAudit = {
    ...audit,
    allHardGatesPass: technicalPass && visual.pass && factual.pass && blockerIssues === 0 && majorIssues === 0,
    totalScore: Math.round((visual.score + factual.score) / 2),
    everySlideScoreMin: Math.min(visual.everySlideScoreMin, factual.everySlideScoreMin),
    blockerCount: blockerIssues,
    majorIssueCount: majorIssues,
    judgesComplete: true,
    visualJudgePass: visual.pass,
    factualJudgePass: factual.pass,
    visualJudge: { status: visual.pass ? "passed" : "failed", issues: visual.issues.map((issue) => issue.message) },
    factualJudge: { status: factual.pass ? "passed" : "failed", issues: factual.issues.map((issue) => issue.message) },
    blockedReason: undefined,
  };
  const next: DashiJobResult = {
    ...result,
    version: { ...result.version, audit: judgedAudit, score: judgedAudit.totalScore, hardGatesPass: judgedAudit.allHardGatesPass },
    rendererReport: {
      ...(result.rendererReport || {}),
      judgeStatus: judgedAudit.allHardGatesPass ? "passed" : "failed",
      visualJudgePass: visual.pass,
      factualJudgePass: factual.pass,
      totalScore: judgedAudit.totalScore,
      claimBindings: claimBindings(input.spec),
    },
  };
  await updateAuditArtifact(env, input, next, judgedAudit);
  return next;
}
