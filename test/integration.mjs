import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const BASE_URL = "http://127.0.0.1:8787";
const hex = randomUUID().replaceAll("-", "");
const testIp = `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:${hex.slice(16, 20)}:${hex.slice(20, 24)}`;

function create(payload) {
  return fetch(`${BASE_URL}/api/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": testIp,
    },
    body: JSON.stringify(payload),
  });
}

async function quota() {
  const response = await fetch(`${BASE_URL}/api/quota`, {
    headers: { "CF-Connecting-IP": testIp },
  });
  assert.equal(response.status, 200);
  return response.json();
}

const missingToken = await create({ brief: "整合測試：缺少 token" });
assert.equal(missingToken.status, 403);
console.log("PASS 無 token -> 403");

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const response = await create({
    brief: `整合測試專案 ${attempt}`,
    turnstileToken: "integration-test-token",
  });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  assert.match(id, /^[a-f0-9]{40}$/);
  if (attempt === 1) console.log(`PASS 測試 token -> 200，id=${id}`);
}

const beforeLimit = await quota();
assert.equal(beforeLimit.ipRemaining.projects, 0);

const overLimit = await create({
  brief: "整合測試：第 4 個專案",
  turnstileToken: "integration-test-token",
});
assert.equal(overLimit.status, 429);
console.log("PASS 第 4 個專案 -> 429");

const afterLimit = await quota();
assert.equal(
  afterLimit.globalRemaining.projects,
  beforeLimit.globalRemaining.projects,
);
console.log(
  `PASS 429 後 global:projects 未增加，remaining=${afterLimit.globalRemaining.projects}`,
);
console.log("TASK_2_INTEGRATION_PASS");
