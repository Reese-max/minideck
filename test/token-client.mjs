import assert from "node:assert/strict";

await import("../public/app.js");

const originalFetch = globalThis.fetch;
const requests = [];
const token = "a".repeat(64);
globalThis.fetch = async (path, init = {}) => {
  requests.push({ path, headers: init.headers ?? {} });
  if (path === "/api/projects") {
    return new Response(JSON.stringify({ id: "project", token }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ status: "ready", versions: [], messages: [] }), {
    headers: { "content-type": "application/json" },
  });
};

try {
  await globalThis.MD.api.createProject("測試", "turnstile");
  await globalThis.MD.api.getProject("project");
  assert.equal(requests[1].headers["X-Project-Token"], token);
  await globalThis.MD.api.getDeck("project", 1);
  assert.equal(requests[2].headers["X-Project-Token"], token);
  console.log("PASS 前端 client 會自動傳送 project token");
} finally {
  globalThis.fetch = originalFetch;
}
