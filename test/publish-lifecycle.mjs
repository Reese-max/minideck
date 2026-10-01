import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
import { createEnv, stubTurnstile } from "./harness.mjs";

const mockEnv = createEnv();
const restoreFetch = stubTurnstile();

function deckHtml(marker) {
  return `<!doctype html><html lang="zh-Hant-TW"><body>
<section class="slide"><h1>${marker}</h1></section>
<section class="slide"><h1>第二頁</h1></section>
<section class="slide"><h1>第三頁</h1></section>
</body></html>`;
}

const V1 = deckHtml("VERSION_ONE_PUBLIC");
const V2 = deckHtml("VERSION_TWO_DRAFT");
const V4 = deckHtml("VERSION_FOUR_DRAFT");
const V5 = deckHtml("VERSION_FIVE_DRAFT");

function api(id, path, { method = "GET", token, body } = {}) {
  return worker.fetch(
    new Request(`https://minideck.test/api/projects/${id}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { "X-Project-Token": token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    mockEnv,
  );
}

function player(id, { version, token } = {}) {
  const query = version === undefined ? "" : `?version=${version}`;
  return worker.fetch(
    new Request(`https://minideck.test/p/${id}${query}`, {
      headers: token ? { "X-Project-Token": token } : {},
    }),
    mockEnv,
  );
}

async function saveDeck(id, token, html, origin) {
  const res = await api(id, "/deck", {
    method: "POST",
    token,
    body: origin === undefined ? { html } : { html, origin },
  });
  return res;
}

async function publish(id, token, version) {
  return api(id, "/publish", { method: "POST", token, body: { version } });
}

async function unpublish(id, token) {
  return api(id, "/unpublish", { method: "POST", token });
}

async function projectState(id, token) {
  const res = await api(id, "", { token });
  assert.equal(res.status, 200);
  return res.json();
}

try {
  // 0. Legacy migration: pre-existing projects keep their public head.
  const legacyDb = new DatabaseSync(":memory:");
  legacyDb.exec(`CREATE TABLE projects(
    id TEXT PRIMARY KEY,
    created_at INTEGER,
    ip_hash TEXT,
    title TEXT,
    brief TEXT,
    access_token_hash TEXT,
    current_version INTEGER DEFAULT 0,
    status TEXT DEFAULT 'new'
  )`);
  legacyDb.exec(`CREATE TABLE versions(
    project_id TEXT,
    version INTEGER,
    r2_key TEXT,
    origin TEXT,
    created_at INTEGER,
    PRIMARY KEY(project_id, version)
  )`);
  legacyDb.exec(
    "INSERT INTO projects(id, created_at, brief, current_version, status) VALUES('shared', 0, 'b', 2, 'ready')",
  );
  legacyDb.exec(
    "INSERT INTO projects(id, created_at, brief, current_version, status) VALUES('empty', 0, 'b', 0, 'new')",
  );
  legacyDb.exec(
    "INSERT INTO projects(id, created_at, brief, current_version, status) VALUES('dangling', 0, 'b', 2, 'ready')",
  );
  legacyDb.exec(
    "INSERT INTO versions(project_id, version, r2_key) VALUES('shared', 1, 'decks/shared/1.html'), ('shared', 2, 'decks/shared/2.html'), ('dangling', 1, 'decks/dangling/1.html')",
  );
  const migration = readFileSync(
    new URL("../migrations/0002_published_head.sql", import.meta.url),
    "utf8",
  );
  legacyDb.exec(migration);
  const shared = legacyDb
    .prepare("SELECT * FROM projects WHERE id = 'shared'")
    .get();
  assert.equal(shared.published_version, 2);
  assert.equal(shared.publish_origin, "migration");
  assert.ok(shared.published_at > 0);
  const empty = legacyDb
    .prepare("SELECT * FROM projects WHERE id = 'empty'")
    .get();
  assert.equal(empty.published_version, null);
  const dangling = legacyDb
    .prepare("SELECT * FROM projects WHERE id = 'dangling'")
    .get();
  assert.equal(dangling.published_version, null);
  console.log("PASS legacy migration：既有公開專案承接 current_version，缺版本列者不產生懸空 head");

  // 1. Create project + save v1; anonymous /p/:id must NOT serve the draft.
  const createRes = await worker.fetch(
    new Request("https://minideck.test/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "2001:db8::publish",
      },
      body: JSON.stringify({
        brief: "publish lifecycle deck",
        turnstileToken: "valid-token",
      }),
    }),
    mockEnv,
  );
  assert.equal(createRes.status, 200);
  const { id, token } = await createRes.json();

  const save1 = await saveDeck(id, token, V1);
  assert.equal(save1.status, 200);
  assert.deepEqual(await save1.json(), { version: 1 });

  const anonBeforePublish = await player(id);
  assert.equal(anonBeforePublish.status, 404);
  const badVersionParam = await player(id, { version: "abc" });
  assert.equal(badVersionParam.status, 400);
  const anonDraftProbe = await player(id, { version: 1 });
  assert.equal(anonDraftProbe.status, 404);
  const anonState = await api(id, "");
  assert.equal(anonState.status, 403);
  const anonDeck = await api(id, "/deck?version=1");
  assert.equal(anonDeck.status, 403);
  const ownerDraftPreview = await player(id, { version: 1, token });
  assert.equal(ownerDraftPreview.status, 200);
  assert.match(await ownerDraftPreview.text(), /VERSION_ONE_PUBLIC/);
  console.log("PASS 未發佈專案的匿名 /p/:id 回 404，不暴露草稿；owner 權杖可預覽草稿");

  // 2. Publish requires a valid project token.
  const pubNoToken = await publish(id, undefined, 1);
  assert.equal(pubNoToken.status, 403);
  const pubBadToken = await publish(id, "deadbeef".repeat(8), 1);
  assert.equal(pubBadToken.status, 403);
  const pubInvalid = await api(id, "/publish", {
    method: "POST",
    token,
    body: { version: "x" },
  });
  assert.equal(pubInvalid.status, 400);
  console.log("PASS publish 需要有效專案權杖並驗證版本編號");

  // 3. Publish v1 → receipt carries version + timestamp; anon sees v1.
  const pub1 = await publish(id, token, 1);
  assert.equal(pub1.status, 200);
  const receipt1 = await pub1.json();
  assert.equal(receipt1.published, true);
  assert.equal(receipt1.version, 1);
  assert.equal(typeof receipt1.published_at, "number");

  const anonV1 = await player(id);
  assert.equal(anonV1.status, 200);
  assert.match(await anonV1.text(), /VERSION_ONE_PUBLIC/);
  const anonV1Explicit = await player(id, { version: 1 });
  assert.equal(anonV1Explicit.status, 200);
  console.log("PASS publish v1 後匿名 /p/:id（含 ?version=1）播放公開版");

  // 3b. Cross-project isolation: a version that only exists in another
  //     project cannot be published here, and a foreign token fails.
  const createB = await worker.fetch(
    new Request("https://minideck.test/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "2001:db8::publish-b",
      },
      body: JSON.stringify({
        brief: "unrelated deck",
        turnstileToken: "valid-token",
      }),
    }),
    mockEnv,
  );
  assert.equal(createB.status, 200);
  const { id: idB, token: tokenB } = await createB.json();
  assert.equal((await saveDeck(idB, tokenB, V1)).status, 200);
  assert.equal((await saveDeck(idB, tokenB, V2)).status, 200);

  const pubCross = await publish(id, token, 2);
  assert.equal(pubCross.status, 404);
  const pubForeignToken = await publish(id, tokenB, 1);
  assert.equal(pubForeignToken.status, 403);
  console.log("PASS publish 只認同專案版本，他專案權杖被拒 (404/403)");

  // 4. Draft after publish: save v2 — anon still sees v1.
  const save2 = await saveDeck(id, token, V2);
  assert.equal(save2.status, 200);
  assert.deepEqual(await save2.json(), { version: 2 });

  const anonAfterDraft = await player(id);
  assert.equal(anonAfterDraft.status, 200);
  const anonAfterDraftHtml = await anonAfterDraft.text();
  assert.match(anonAfterDraftHtml, /VERSION_ONE_PUBLIC/);
  assert.doesNotMatch(anonAfterDraftHtml, /VERSION_TWO_DRAFT/);
  const anonDraft2 = await player(id, { version: 2 });
  assert.equal(anonDraft2.status, 403);
  console.log("PASS 草稿 v2 不影響匿名公開頁，匿名 ?version=2 被拒 (403)");

  // 5. Owner preview of the draft reuses the public render path with token.
  const ownerPreview2 = await player(id, { version: 2, token });
  assert.equal(ownerPreview2.status, 200);
  assert.match(await ownerPreview2.text(), /VERSION_TWO_DRAFT/);
  const ownerBare = await player(id, { token });
  assert.equal(ownerBare.status, 200);
  assert.match(await ownerBare.text(), /VERSION_ONE_PUBLIC/);
  console.log("PASS owner 以權杖經公開 render path 預覽草稿 v2");

  // 6. State endpoint exposes draft head, published head, pending count.
  const state1 = await projectState(id, token);
  assert.equal(state1.current_version, 2);
  assert.equal(state1.published_version, 1);
  assert.equal(state1.unpublished_changes, 1);
  assert.equal(typeof state1.published_at, "number");
  console.log("PASS 專案狀態回傳 draft head / published head / 未發佈變更數");

  // 7. Publish v2 → anon switches to v2.
  const pub2 = await publish(id, token, 2);
  assert.equal(pub2.status, 200);
  const anonV2 = await player(id);
  assert.match(await anonV2.text(), /VERSION_TWO_DRAFT/);
  const state2 = await projectState(id, token);
  assert.equal(state2.published_version, 2);
  assert.equal(state2.unpublished_changes, 0);
  console.log("PASS publish v2 後匿名連結切到 v2");

  // 8. Rollback while published: v1 → v3 draft, anon stays on v2.
  const rollback = await api(id, "/rollback", {
    method: "POST",
    token,
    body: { version: 1 },
  });
  assert.equal(rollback.status, 200);
  assert.deepEqual(await rollback.json(), { version: 3 });

  const anonAfterRollback = await player(id);
  assert.equal(anonAfterRollback.status, 200);
  assert.match(await anonAfterRollback.text(), /VERSION_TWO_DRAFT/);
  const anonV3 = await player(id, { version: 3 });
  assert.equal(anonV3.status, 403);
  const ownerPreview3 = await player(id, { version: 3, token });
  assert.equal(ownerPreview3.status, 200);
  assert.match(await ownerPreview3.text(), /VERSION_ONE_PUBLIC/);
  console.log("PASS rollback 產生 v3 草稿，不改公開 head；owner 可預覽 v3");

  // 9. Publish the rollback version → anon sees rolled-back content.
  const pub3 = await publish(id, token, 3);
  assert.equal(pub3.status, 200);
  const anonV3After = await player(id);
  assert.match(await anonV3After.text(), /VERSION_ONE_PUBLIC/);
  console.log("PASS publish v3 後匿名播放回退版內容");

  // 10. Publish an older existing version is allowed.
  const pubOlder = await publish(id, token, 2);
  assert.equal(pubOlder.status, 200);
  assert.deepEqual((await pubOlder.json()).version, 2);
  const anonBackTo2 = await player(id);
  assert.match(await anonBackTo2.text(), /VERSION_TWO_DRAFT/);
  console.log("PASS 允許 publish 同專案的舊版本");

  // 11. Publish a version that does not exist → 404.
  const pubMissing = await publish(id, token, 99);
  assert.equal(pubMissing.status, 404);
  const pubGhost = await publish("0".repeat(40), token, 1);
  assert.equal(pubGhost.status, 404);
  console.log("PASS publish 不存在版本 / 不存在專案 被拒 (404)");

  // 12. Concurrent save + publish: public head always lands on a complete,
  //     previously committed version — never a partial state.
  const [save4, pubRace] = await Promise.all([
    saveDeck(id, token, V4),
    publish(id, token, 3),
  ]);
  assert.equal(save4.status, 200);
  assert.equal(pubRace.status, 200);
  const state3 = await projectState(id, token);
  assert.equal(state3.current_version, 4);
  assert.equal(state3.published_version, 3);
  const anonRace = await player(id);
  assert.equal(anonRace.status, 200);
  assert.match(await anonRace.text(), /VERSION_ONE_PUBLIC/);
  console.log("PASS save 與 publish 並行：公開 head 指向完整既有版本");

  // 13. Publish of a concurrently-created version is either rejected (404)
  //     or lands on the fully committed version — never partial.
  const [save5, pubInflight] = await Promise.all([
    saveDeck(id, token, V5),
    publish(id, token, 5),
  ]);
  assert.equal(save5.status, 200);
  assert.ok([200, 404].includes(pubInflight.status));
  if (pubInflight.status === 200) {
    const anonV5 = await player(id);
    assert.equal(anonV5.status, 200);
    assert.match(await anonV5.text(), /VERSION_FIVE_DRAFT/);
  } else {
    const state4 = await projectState(id, token);
    assert.equal(state4.published_version, 3);
  }
  console.log("PASS publish 競爭中的版本：404 或完整版本，無 partial state");

  // 14. Unpublish: anon loses access, drafts/versions survive for owner.
  const unpubNoToken = await unpublish(id);
  assert.equal(unpubNoToken.status, 403);
  const unpub = await unpublish(id, token);
  assert.equal(unpub.status, 200);
  assert.deepEqual(await unpub.json(), { published: false });

  const anonAfterUnpublish = await player(id);
  assert.equal(anonAfterUnpublish.status, 404);
  const anonAnyVersion = await player(id, { version: 3 });
  assert.equal(anonAnyVersion.status, 404);
  const ownerDeck = await api(id, "/deck?version=3", { token });
  assert.equal(ownerDeck.status, 200);
  const state5 = await projectState(id, token);
  assert.equal(state5.published_version, null);
  assert.equal(state5.current_version, 5);
  const unpubAgain = await unpublish(id, token);
  assert.equal(unpubAgain.status, 200);
  console.log("PASS unpublish 後匿名無法取回簡報，owner 仍可讀所有版本");

  // 15. Delete project → public link and all versions die, no R2 leftovers.
  const del = await api(id, "", { method: "DELETE", token });
  assert.equal(del.status, 200);
  const anonDeleted = await player(id);
  assert.equal(anonDeleted.status, 404);
  const ownerDeleted = await api(id, "/deck?version=1", { token });
  assert.equal(ownerDeleted.status, 404);
  console.log("PASS 專案刪除後公開連結與所有版本立即失效");

  // 16. Deck HTML containing String.replace replacement patterns ($&, $', $9)
  //     must reach the player verbatim — a replacement-string splice would
  //     corrupt or drop deck content.
  const saveSentinel = await saveDeck(
    idB,
    tokenB,
    deckHtml("$&PRICE_$'_$9_TAIL"),
  );
  assert.equal(saveSentinel.status, 200);
  const pubSentinel = await publish(idB, tokenB, 3);
  assert.equal(pubSentinel.status, 200);
  const sentinelPlayer = await player(idB);
  assert.equal(sentinelPlayer.status, 200);
  const sentinelHtml = await sentinelPlayer.text();
  assert.ok(sentinelHtml.includes("$&amp;PRICE_$'_$9_TAIL"));
  assert.ok(!sentinelHtml.includes("__MINIDECK_DECK_HTML__"));
  console.log("PASS 播放器原樣呈現含 $ 取代樣式的 deck 內容");

  console.log("ALL PUBLISH LIFECYCLE ACCEPTANCE CRITERIA PASSED");
} finally {
  restoreFetch();
}
