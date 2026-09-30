// Replace only Dashi subprocesses and outbound storage; execute-job itself runs unchanged.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { PassThrough } from "node:stream";

globalThis.testDashiSpawn = (file, args) => {
  assert.equal(file, "npm");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", -1, "SIGTERM");
  queueMicrotask(async () => {
    try {
      const stage = args[3];
      if (stage === "render:goal") await writeFile(args.at(-1), "<html><head></head><body>fixture</body></html>");
      if (stage === "validate:four-variant-quality") await writeFile(args[args.indexOf("--out") + 1], "{}");
      if (stage.startsWith("export:")) await writeFile(args.at(-1), "fixture export bytes");
      child.emit("close", stage === process.env.TEST_FAIL_STAGE ? 1 : 0, null);
    } catch (error) { child.emit("error", error); }
  });
  return child;
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:child_process") return {
      url: "data:text/javascript,export const spawn = globalThis.testDashiSpawn;", shortCircuit: true,
    };
    return next(specifier, context);
  },
});
globalThis.fetch = async (url, options) => {
  const match = /^http:\/\/presentation-studio\.internal\/storage\/([\w-]+)\/(\d+)\/([a-z]+)$/.exec(url);
  assert.ok(match, "unexpected storage route: " + url);
  const [, jobId, attempt, kind] = match;
  assert.ok(["goal", "html", "quality", "audit", "preview", "pptx", "pdf"].includes(kind));
  const r2Key = `projects/fixture/jobs/${jobId}/attempt-${attempt}/${kind}`;
  await appendFile(process.env.TEST_UPLOAD_TRACE, JSON.stringify({ kind, r2Key }) + "\n");
  return Response.json({ kind, r2Key, mimeType: options.headers["content-type"], byteSize: options.body.byteLength, sha256: "fixture-digest" });
};
