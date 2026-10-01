import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeIntentionalDecorationOverflow } from "./deck-normalizer.mjs";
import { claimIntegrityCheck, claimTextMap, runWithClaimIntegrityGate } from "./claim-integrity.mjs";

const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const DURATION_MS = 30 * 60 * 1000;
const STORAGE_HOST = process.env.DASHI_STORAGE_HOST || "presentation-studio.internal";
const DashiRoot = process.env.DASHI_ROOT || "/opt/skills/dashi-ppt";
const DashiProject = join(DashiRoot, "project");

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(value, limit = 2_000) {
  const text = String(value || "");
  return text.length <= limit ? text : text.slice(-limit);
}

function collectStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new Error("JOB_INPUT_TOO_LARGE"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function runCommand(file, args, cwd, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        ...extraEnv,
        INIT_CWD: cwd,
        CHROME_PATH: process.env.CHROME_PATH || "/usr/bin/chromium",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      if (size >= MAX_COMMAND_OUTPUT) return;
      const remaining = MAX_COMMAND_OUTPUT - size;
      const value = chunk.subarray(0, remaining);
      chunks.push(value);
      size += value.length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timeout = setTimeout(() => child.kill("SIGTERM"), DURATION_MS);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode: -1, output: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({
        exitCode: typeof code === "number" ? code : -1,
        signal: signal || null,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeItems(slide, sourceMap) {
  const presentation = slide?.content?.presentation;
  if (Array.isArray(presentation?.items) && presentation.items.length > 0) {
    return presentation.items;
  }
  if (Array.isArray(slide?.items) && slide.items.length > 0) return slide.items;
  const claims = claimTextMap(sourceMap);
  if (Array.isArray(slide?.claims)) {
    const values = slide.claims
      .map((claimId) => claims.get(claimId))
      .filter((value) => typeof value === "string");
    if (values.length > 0) return values.map((text) => ({ text }));
  }
  const fallback = safeText(slide?.keyMessage, safeText(slide?.purpose, ""));
  return fallback ? [{ text: fallback }] : [];
}

function toContentBriefs(spec, sourceMap) {
  const slides = Array.isArray(spec?.slides) ? spec.slides : [];
  return slides.map((slide, index) => {
    const value = isObject(slide) ? slide : {};
    const presentation = isObject(value.content?.presentation)
      ? value.content.presentation
      : {};
    const title = safeText(
      presentation.title,
      safeText(value.title, safeText(value.keyMessage, `第 ${index + 1} 頁`)),
    );
    const summary = safeText(
      presentation.summary,
      safeText(value.purpose, safeText(value.keyMessage, title)),
    );
    const role = safeText(value.role, index === 0 ? "cover" : index === slides.length - 1 ? "closing" : "statement");
    return {
      id: safeText(value.id, `s${String(index + 1).padStart(2, "0")}`),
      role,
      priority: safeText(value.priority, "normal"),
      content: {
        presentation: {
          title,
          titleShort: safeText(presentation.titleShort, title),
          summary,
          summaryShort: safeText(presentation.summaryShort, summary),
          takeaway: safeText(presentation.takeaway, safeText(value.keyMessage, summary)),
          items: normalizeItems(value, sourceMap),
        },
        meta: {
          pageLabel: String(index + 1).padStart(2, "0"),
          panelTitle: title,
        },
      },
    };
  });
}

function rendererBinding(input) {
  const binding = isObject(input.profile?.rendererBinding) ? input.profile.rendererBinding : {};
  const theme = binding.themePack || binding.theme || binding.themeId || "theme07";
  return { ...binding, themePack: String(theme) };
}

function hasDashiGoal(spec) {
  return (
    isObject(spec) &&
    (spec.schemaVersion === 2 || spec.schemaVersion === "2.0.0") &&
    Array.isArray(spec.slides) &&
    spec.slides.length > 0 &&
    spec.slides.every((slide) => isObject(slide) && Array.isArray(slide.variants) && slide.variants.length >= 4)
  );
}

function patchSpec(spec, patch) {
  if (!isObject(patch)) return spec;
  const next = { ...spec, ...patch };
  if (Array.isArray(patch.slides) && Array.isArray(spec.slides)) {
    const patches = new Map(
      patch.slides
        .filter((slide) => isObject(slide) && typeof slide.id === "string")
        .map((slide) => [slide.id, slide]),
    );
    next.slides = spec.slides.map((slide) => {
      if (!isObject(slide) || typeof slide.id !== "string" || !patches.has(slide.id)) return slide;
      return { ...slide, ...patches.get(slide.id) };
    });
  }
  return next;
}

async function writeSources(input, workDir) {
  // Source bytes remain in R2 and are intentionally not copied through the
  // Workflow RPC payload. Dashi renders the ChatGPT-first spec; later judges
  // can read the immutable source objects by these metadata keys.
  await writeFile(join(workDir, "sources.json"), JSON.stringify(input.sources || [], null, 2));
  await writeFile(join(workDir, "source-map.json"), JSON.stringify(input.sourceMap || {}, null, 2));
}

async function prepareGoal(input, workDir) {
  const goalPath = join(workDir, "goal.json");
  const payload = isObject(input.payload) ? input.payload : {};
  let spec = isObject(input.spec) ? input.spec : null;
  const hasPatch = isObject(payload.specPatch);
  if (input.type === "revision" && !hasPatch && !spec) {
    return { blocked: "REVISION_REQUIRES_SPEC_PATCH" };
  }
  if (spec && hasPatch) spec = patchSpec(spec, payload.specPatch);
  if (spec && hasDashiGoal(spec)) {
    const goal = {
      ...spec,
      schemaVersion: 2,
      title: safeText(spec.title, input.title),
      goal: safeText(spec.goal, input.brief),
      themePack: rendererBinding(input).themePack,
      randomSeed: safeText(spec.randomSeed, input.randomSeed || "presentation-studio"),
      workflowRunId: safeText(spec.workflowRunId, input.workflowRunId || input.jobId),
    };
    await writeFile(goalPath, JSON.stringify(goal, null, 2));
    return { goalPath, mode: "provided-spec" };
  }
  if (!spec || !Array.isArray(spec.slides) || spec.slides.length === 0) {
    return { blocked: "SLIDE_SPEC_REQUIRED_FOR_DASHI_RENDER" };
  }
  const briefsPath = join(workDir, "content-briefs.json");
  await writeFile(briefsPath, JSON.stringify(toContentBriefs(spec, input.sourceMap), null, 2));
  const result = await runCommand(
    "npm",
    [
      "--prefix",
      DashiProject,
      "run",
      "goal:scaffold",
      "--",
      "--title",
      input.title,
      "--goal",
      input.brief,
      "--theme",
      rendererBinding(input).themePack,
      "--pages",
      String(spec.slides.length),
      "--content-briefs",
      briefsPath,
      "--layout-variants",
      "3",
      "--seed",
      safeText(input.randomSeed, "presentation-studio"),
      "--workflow-run-id",
      safeText(input.workflowRunId, input.jobId),
      "--out",
      goalPath,
    ],
    workDir,
  );
  if (result.exitCode === 0) {
    const scaffolded = await readJson(goalPath);
    if (Array.isArray(scaffolded.slides) && Array.isArray(spec.slides)) {
      scaffolded.slides = scaffolded.slides.map((slide, index) => {
        const authored = isObject(spec.slides[index]) ? spec.slides[index] : {};
        const identity = safeText(authored.id, safeText(slide?.id, `s${String(index + 1).padStart(2, "0")}`));
        const claims = Array.isArray(authored.claims)
          ? authored.claims.filter((claimId) => typeof claimId === "string")
          : [];
        return {
          ...slide,
          id: identity,
          ...(claims.length > 0 ? { claims, sourceClaimIds: claims } : {}),
        };
      });
      await writeFile(goalPath, JSON.stringify(scaffolded, null, 2));
    }
  }
  return {
    goalPath,
    mode: "scaffolded",
    command: result,
    blocked: result.exitCode === 0 ? undefined : "DASHI_SCAFFOLD_FAILED",
  };
}

async function runDashi(goalPath, workDir) {
  const deckDir = join(workDir, "deck");
  const qualityPath = join(workDir, "four-variant-quality.json");
  await mkdir(deckDir, { recursive: true });
  const commands = {};
  commands.goalSpec = await runCommand(
    "npm",
    ["--prefix", DashiProject, "run", "validate:goal-spec", "--", goalPath],
    workDir,
  );
  commands.safeProps = await runCommand(
    "npm",
    ["--prefix", DashiProject, "run", "props:safe", "--", "--goal", goalPath, "--write"],
    workDir,
  );
  commands.render = await runCommand(
    "npm",
    ["--prefix", DashiProject, "run", "render:goal", "--", goalPath, join(deckDir, "index.html")],
    workDir,
  );
  if (commandPass(commands.render)) {
    await normalizeIntentionalDecorationOverflow(join(deckDir, "index.html"));
  }
  commands.swiss = await runCommand(
    "npm",
    ["--prefix", DashiProject, "run", "validate:swiss", "--", join(deckDir, "index.html")],
    workDir,
  );
  commands.copy = await runCommand(
    "npm",
    ["--prefix", DashiProject, "run", "validate:goal-copy", "--", goalPath, join(deckDir, "index.html")],
    workDir,
  );
  commands.variantQuality = await runCommand(
    "npm",
    [
      "--prefix",
      DashiProject,
      "run",
      "validate:four-variant-quality",
      "--",
      "--deck",
      join(deckDir, "index.html"),
      "--goal",
      goalPath,
      "--out",
      qualityPath,
      "--screenshots",
      join(workDir, "screenshots"),
    ],
    workDir,
  );
  let quality = {};
  try {
    quality = await readJson(qualityPath);
  } catch {
    quality = { parseError: true };
  }
  return { deckDir, qualityPath, quality, commands };
}

function commandPass(command) {
  return Boolean(command && command.exitCode === 0);
}

function makeAudit(renderResult, input, exportPass = undefined) {
  const commands = { ...renderResult.commands, claimIntegrity: claimIntegrityCheck(input) };
  const deterministic = {
    goalSpec: commandPass(commands.goalSpec),
    claimIntegrity: commandPass(commands.claimIntegrity),
    safeProps: commandPass(commands.safeProps),
    render: commandPass(commands.render),
    swiss: commandPass(commands.swiss),
    copy: commandPass(commands.copy),
    variantQuality: commandPass(commands.variantQuality),
    ...(exportPass === undefined ? {} : { export: exportPass }),
  };
  const technicalPass = Object.values(deterministic).every(Boolean);
  const evidence = Object.entries(deterministic).map(([check, passed]) => ({
    check,
    passed,
    detail: passed ? "Dashi check completed" : clip(commands[check]?.output || "command failed"),
  }));
  return {
    schemaVersion: "2.0.0",
    // Visual and factual judges are intentionally separate from this runner.
    // Until a configured judge records both results, approval remains blocked.
    allHardGatesPass: false,
    totalScore: 0,
    everySlideScoreMin: 0,
    blockerCount: technicalPass ? 0 : 1,
    majorIssueCount: technicalPass ? 0 : 1,
    judgesComplete: false,
    visualJudgePass: false,
    factualJudgePass: false,
    deterministic,
    visualJudge: { status: "not_configured", issues: ["visual_judge_not_configured"] },
    factualJudge: { status: "not_configured", issues: ["factual_judge_not_configured"] },
    evidence,
    blockedReason: technicalPass ? "JUDGES_NOT_CONFIGURED" : "DASHI_TECHNICAL_CHECK_FAILED",
  };
}

async function upload(input, kind, bytes, contentType) {
  const response = await fetch(`http://${STORAGE_HOST}/storage/${input.jobId}/${kind}`, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
    body: bytes,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ARTIFACT_UPLOAD_FAILED:${kind}:${response.status}:${clip(text)}`);
  return JSON.parse(text);
}

async function createPreview(workDir) {
  const screenshotsDir = join(workDir, "screenshots");
  let names;
  try {
    names = (await readdir(screenshotsDir))
      .filter((name) => name.endsWith(".png"))
      .sort()
      .slice(0, 20);
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  try {
    const requireFromDashi = createRequire(join(DashiProject, "package.json"));
    const { PNG } = requireFromDashi("pngjs");
    const tileWidth = 480;
    const tileHeight = 270;
    const columns = Math.min(2, names.length);
    const rows = Math.ceil(names.length / columns);
    const sheet = new PNG({ width: columns * tileWidth, height: rows * tileHeight });
    for (let index = 0; index < names.length; index += 1) {
      const image = PNG.sync.read(await readFile(join(screenshotsDir, names[index])));
      const column = index % columns;
      const row = Math.floor(index / columns);
      for (let y = 0; y < tileHeight; y += 1) {
        const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / tileHeight));
        for (let x = 0; x < tileWidth; x += 1) {
          const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / tileWidth));
          const sourceOffset = (sourceY * image.width + sourceX) * 4;
          const targetOffset = ((row * tileHeight + y) * sheet.width + column * tileWidth + x) * 4;
          sheet.data[targetOffset] = image.data[sourceOffset];
          sheet.data[targetOffset + 1] = image.data[sourceOffset + 1];
          sheet.data[targetOffset + 2] = image.data[sourceOffset + 2];
          sheet.data[targetOffset + 3] = image.data[sourceOffset + 3];
        }
      }
    }
    const previewPath = join(workDir, "preview.png");
    await writeFile(previewPath, PNG.sync.write(sheet));
    return previewPath;
  } catch {
    return null;
  }
}

async function collectArtifacts(input, renderResult, audit, includeExports = {}) {
  const artifacts = [];
  const workDir = join(renderResult.deckDir, "..");
  const goal = await readFile(join(workDir, "goal.json"));
  const html = await readFile(join(renderResult.deckDir, "index.html"));
  const quality = Buffer.from(JSON.stringify(renderResult.quality, null, 2));
  const auditBytes = Buffer.from(JSON.stringify(audit, null, 2));
  artifacts.push(await upload(input, "goal", goal, "application/json"));
  artifacts.push(await upload(input, "html", html, "text/html"));
  artifacts.push(await upload(input, "quality", quality, "application/json"));
  artifacts.push(await upload(input, "audit", auditBytes, "application/json"));
  const previewPath = await createPreview(workDir);
  if (previewPath) {
    artifacts.push(await upload(input, "preview", await readFile(previewPath), "image/png"));
  }
  if (includeExports.pptx) {
    artifacts.push(await upload(input, "pptx", await readFile(includeExports.pptx), "application/vnd.openxmlformats-officedocument.presentationml.presentation"));
  }
  if (includeExports.pdf) {
    artifacts.push(await upload(input, "pdf", await readFile(includeExports.pdf), "application/pdf"));
  }
  return artifacts;
}

async function execute(input) {
  if (!isObject(input) || typeof input.jobId !== "string") throw new Error("INVALID_JOB_INPUT");
  const integrityInput =
    isObject(input.spec) && isObject(input.payload?.specPatch)
      ? { ...input, spec: patchSpec(input.spec, input.payload.specPatch) }
      : input;
  return runWithClaimIntegrityGate(integrityInput, async () => {
  if (input.type === "plan") {
    return { status: "blocked", jobId: input.jobId, error: "PLANNER_FALLBACK_REQUIRES_CHATGPT_SLIDE_SPEC" };
  }
  if (input.type !== "render" && input.type !== "revision" && input.type !== "export") {
    return { status: "blocked", jobId: input.jobId, error: "JOB_TYPE_NOT_ALLOWED" };
  }
  const workDir = await mkdtemp(join(tmpdir(), `presentation-studio-${input.jobId}-`));
  try {
    await writeSources(input, workDir);
    const goal = await prepareGoal(input, workDir);
    if (goal.blocked) return { status: "blocked", jobId: input.jobId, error: goal.blocked };
    const renderResult = await runDashi(goal.goalPath, workDir);
    let exportPaths = {};
    let exportPass;
    if (input.type === "export") {
      const requested = new Set(Array.isArray(input.requestedFormats) ? input.requestedFormats : ["pptx"]);
      if (requested.has("pptx")) {
        const out = join(workDir, "deck.pptx");
        const result = await runCommand("npm", ["--prefix", DashiProject, "run", "export:pptx", "--", renderResult.deckDir, out], workDir);
        exportPaths.pptx = out;
        exportPass = commandPass(result);
        renderResult.commands.exportPptx = result;
      }
      if (requested.has("pdf")) {
        const out = join(workDir, "deck.pdf");
        const result = await runCommand("npm", ["--prefix", DashiProject, "run", "export:pdf", "--", renderResult.deckDir, out], workDir);
        exportPaths.pdf = out;
        exportPass = (exportPass ?? true) && commandPass(result);
        renderResult.commands.exportPdf = result;
      }
      if (requested.has("html")) exportPass = exportPass ?? true;
    }
    const audit = makeAudit(renderResult, integrityInput, exportPass);
    const artifacts = await collectArtifacts(input, renderResult, audit, exportPaths);
    const finalGoal = await readJson(goal.goalPath);
    const rendererReport = {
      renderer: "dashi",
      dashiVersion: "0.4.11",
      goalMode: goal.mode,
      jobId: input.jobId,
      artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, r2Key: artifact.r2Key })),
      technicalChecks: audit.deterministic,
      judgeStatus: "pending",
    };
    if (input.type === "export") {
      return {
        status: "succeeded",
        jobId: input.jobId,
        artifacts,
        exportReport: {
          renderer: "dashi",
          formats: input.requestedFormats,
          exportPass: exportPass !== false,
          technicalChecks: audit.deterministic,
          artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, r2Key: artifact.r2Key })),
        },
      };
    }
    return {
      status: "succeeded",
      jobId: input.jobId,
      version: {
        spec: finalGoal,
        audit,
        score: audit.totalScore,
        hardGatesPass: audit.allHardGatesPass,
        changedSlides: Array.isArray(input.changedSlides) ? input.changedSlides : [],
        parentVersionId: input.parentVersionId || null,
        origin: input.type === "revision" ? "dashi-targeted-revision" : "dashi-render",
      },
      artifacts,
      rendererReport,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  });
}

try {
  const input = JSON.parse(await collectStdin());
  const result = await execute(input);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: "blocked",
    jobId: null,
    error: error instanceof Error ? error.message : "RUNNER_FAILED",
  }) + "\n");
  process.exitCode = 1;
}
