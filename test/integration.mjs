import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.MINIDECK_BASE_URL ?? "http://127.0.0.1:8787";
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

function projectHeaders(token, json = false) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "X-Project-Token": token,
  };
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

let projectId;
let projectToken;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const response = await create({
    brief: `整合測試專案 ${attempt}`,
    turnstileToken: "integration-test-token",
  });
  assert.equal(response.status, 200);
  const { id, token } = await response.json();
  assert.match(id, /^[a-f0-9]{40}$/);
  assert.match(token, /^[a-f0-9]{64}$/);
  projectId ??= id;
  projectToken ??= token;
  if (attempt === 1) console.log(`PASS 測試 token -> 200，id=${id}`);
}

const unauthorizedState = await fetch(`${BASE_URL}/api/projects/${projectId}`);
assert.equal(unauthorizedState.status, 403);
console.log("PASS 專案狀態缺少權杖 -> 403");

const unauthorizedDelete = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
  method: "DELETE",
});
assert.equal(unauthorizedDelete.status, 403);
console.log("PASS 專案刪除缺少權杖 -> 403");

const oversizedSourceData = await fetch(
  `${BASE_URL}/api/projects/${projectId}/generate`,
  {
    method: "POST",
    headers: projectHeaders(projectToken, true),
    body: JSON.stringify({ sourceData: "資".repeat(3001) }),
  },
);
assert.equal(oversizedSourceData.status, 413);
assert.deepEqual(await oversizedSourceData.json(), { error: "參考資料不可超過 3000 字" });
console.log("PASS sourceData 超過 3000 字 -> 413，未呼叫 MiniMax");

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

const fixture = `<!doctype html><html lang="zh-Hant-TW"><body>
<section class="slide">第一頁</section>
<section class="slide">第二頁</section>
<section class="slide">第三頁</section>
</body></html>`;
const saveDeck = await fetch(`${BASE_URL}/api/projects/${projectId}/deck`, {
  method: "POST",
  headers: projectHeaders(projectToken, true),
  body: JSON.stringify({ html: fixture }),
});
assert.equal(saveDeck.status, 200);
assert.deepEqual(await saveDeck.json(), { version: 1 });

const unauthorizedDeck = await fetch(
  `${BASE_URL}/api/projects/${projectId}/deck?version=1`,
);
assert.equal(unauthorizedDeck.status, 403);
console.log("PASS 簡報讀取缺少權杖 -> 403");

const deck = await fetch(
  `${BASE_URL}/api/projects/${projectId}/deck?version=1`,
  { headers: projectHeaders(projectToken) },
);
assert.equal(deck.status, 200);
assert.equal(await deck.text(), fixture);

const fixtureV2 = fixture.replace("第一頁", "新版第一頁");
const saveDeckV2 = await fetch(`${BASE_URL}/api/projects/${projectId}/deck`, {
  method: "POST",
  headers: projectHeaders(projectToken, true),
  body: JSON.stringify({ html: fixtureV2, origin: "mechfix" }),
});
assert.equal(saveDeckV2.status, 200);
assert.deepEqual(await saveDeckV2.json(), { version: 2 });

const rollback = await fetch(
  `${BASE_URL}/api/projects/${projectId}/rollback`,
  {
    method: "POST",
    headers: projectHeaders(projectToken, true),
    body: JSON.stringify({ version: 1 }),
  },
);
assert.equal(rollback.status, 200);
assert.deepEqual(await rollback.json(), { version: 3 });

const unauthorizedRolledBackDeck = await fetch(
  `${BASE_URL}/api/projects/${projectId}/deck?version=3`,
);
assert.equal(unauthorizedRolledBackDeck.status, 403);

const rolledBackDeck = await fetch(
  `${BASE_URL}/api/projects/${projectId}/deck?version=3`,
  { headers: projectHeaders(projectToken) },
);
assert.equal(rolledBackDeck.status, 200);
assert.equal(await rolledBackDeck.text(), fixture);
console.log("PASS rollback v1 -> v3，內容等於 v1");

const missingRollback = await fetch(
  `${BASE_URL}/api/projects/${projectId}/rollback`,
  {
    method: "POST",
    headers: projectHeaders(projectToken, true),
    body: JSON.stringify({ version: 99 }),
  },
);
assert.equal(missingRollback.status, 404);
assert.deepEqual(await missingRollback.json(), { error: "找不到簡報版本" });
console.log("PASS rollback v99 -> 404");

const state = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
  headers: projectHeaders(projectToken),
});
assert.equal(state.status, 200);
const project = await state.json();
assert.equal(project.status, "ready");
assert.deepEqual(project.versions.map(({ version, origin }) => ({ version, origin })), [
  { version: 1, origin: "imagefill" },
  { version: 2, origin: "mechfix" },
  { version: 3, origin: "rollback" },
]);
assert.deepEqual(project.messages, []);
console.log("PASS deck 儲存／讀取與專案狀態介面");

const invalidImage = await fetch(
  `${BASE_URL}/api/projects/${projectId}/image`,
  {
    method: "POST",
    headers: projectHeaders(projectToken, true),
    body: JSON.stringify({ prompt: "integration test", ar: "4:3" }),
  },
);
assert.equal(invalidImage.status, 400);
console.log("PASS image 輸入驗證不呼叫 MiniMax");

const invalidRevise = await fetch(
  `${BASE_URL}/api/projects/${projectId}/revise`,
  {
    method: "POST",
    headers: projectHeaders(projectToken, true),
    body: JSON.stringify({ message: "" }),
  },
);
assert.equal(invalidRevise.status, 400);
console.log("PASS revise 輸入驗證不呼叫 MiniMax");

const deleted = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
  method: "DELETE",
  headers: projectHeaders(projectToken),
});
assert.equal(deleted.status, 200);
assert.deepEqual(await deleted.json(), { deleted: true, cleanupPending: 0 });

const deletedState = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
  headers: projectHeaders(projectToken),
});
assert.equal(deletedState.status, 404);

const deletedDeck = await fetch(
  `${BASE_URL}/api/projects/${projectId}/deck?version=1`,
);
assert.equal(deletedDeck.status, 404);

const deletedPlayer = await fetch(`${BASE_URL}/p/${projectId}`);
assert.equal(deletedPlayer.status, 404);
console.log("PASS 專案刪除／D1 metadata 清理／公開讀取失效");
console.log("TASK_2_INTEGRATION_PASS");
console.log("TASK_3_API_CONTRACT_PASS");
await import("./judge-mock.mjs");
