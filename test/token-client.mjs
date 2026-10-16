import assert from "node:assert/strict";

await import("../public/app.js");

const originalFetch = globalThis.fetch;
const requests = [];
const token = "a".repeat(64);
globalThis.fetch = async (path, init = {}) => {
  requests.push({ path, ...init, headers: init.headers ?? {} });
  if (path === "/api/projects") {
    return new Response(JSON.stringify({ id: "project", token }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (path.includes("/preview")) return new Response("<html>public renderer</html>");
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
  await globalThis.MD.api.publish("project", 3);
  assert.equal(requests[3].path, "/api/projects/project/publish");
  assert.equal(requests[3].method, "POST");
  assert.equal(requests[3].body, '{"version":3}');
  assert.equal(requests[3].headers["X-Project-Token"], token);
  await globalThis.MD.api.unpublish("project");
  assert.equal(requests[4].path, "/api/projects/project/unpublish");
  assert.equal(requests[4].method, "POST");
  assert.equal(requests[4].headers["X-Project-Token"], token);
  assert.equal(await globalThis.MD.api.preview("project", 2), "<html>public renderer</html>");
  assert.equal(requests[5].path, "/api/projects/project/preview?version=2");
  assert.equal(requests[5].headers["X-Project-Token"], token);
  assert.equal(requests[5].cache, "no-store");
  assert.ok(requests.every(({ path }) => !path.includes(token)));
  console.log("PASS 前端 client 會自動傳送 project token");
} finally {
  globalThis.fetch = originalFetch;
}
