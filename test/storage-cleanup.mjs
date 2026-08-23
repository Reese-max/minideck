import assert from "node:assert/strict";
import { deleteProjectData, saveDeckVersion } from "../src/store.js";

const saveActions = [];
const failingD1 = {
  prepare(sql) {
    if (sql.startsWith("SELECT id")) {
      return {
        bind() {
          return this;
        },
        async first() {
          return { current_version: 0 };
        },
      };
    }
    return { bind() { return this; } };
  },
  async batch() {
    throw new Error("D1 batch failed");
  },
};
const saveBucket = {
  async put(key) {
    saveActions.push(["put", key]);
  },
  async delete(key) {
    saveActions.push(["delete", key]);
  },
};

await assert.rejects(
  saveDeckVersion(failingD1, saveBucket, "project", "<html />", "test"),
  /D1 batch failed/,
);
assert.deepEqual(saveActions, [
  ["put", "decks/project/1.html"],
  ["delete", "decks/project/1.html"],
]);

let deleteBatchCalled = false;
const deleteD1 = {
  prepare(sql) {
    if (sql.startsWith("SELECT id")) {
      return {
        bind() {
          return this;
        },
        async first() {
          return { id: "project", current_version: 1 };
        },
      };
    }
    if (sql.startsWith("SELECT r2_key")) {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [{ r2_key: "decks/project/1.html" }] };
        },
      };
    }
    return { bind() { return this; } };
  },
  async batch() {
    deleteBatchCalled = true;
  },
};
const unavailableR2 = {
  async delete() {
    throw new Error("R2 unavailable");
  },
};

const pending = await deleteProjectData(deleteD1, unavailableR2, "project");
assert.deepEqual(pending, { cleanupPending: 1 });
assert.equal(deleteBatchCalled, false);
console.log("PASS D1 失敗時回收 R2；R2 失敗時保留 D1 metadata");
