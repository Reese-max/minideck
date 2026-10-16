import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const admission = readFileSync(new URL("../docs/ci-admission.md", import.meta.url), "utf8");

test("CI documentation preserves verified main and PR-head success receipts", () => {
  assert.ok(!/自動觸發目前被帳號 Actions budget 阻擋/.test(readme), "README must not report the historical budget block as current");
  assert.ok(!/目前仍是此狀態|\*\*自動觸發／CI 執行\*\*：仍被/.test(admission), "Admission diagnosis must distinguish historical failures from verified success");
  for (const [run, sha] of [
    ["34690640060", "31f7131ae24af9d89287000e8048750e598686a1"],
    ["36695770634", "1eb700f5b28fd0493d5bc0bfbaf1da737fd79766"],
  ]) {
    assert.ok(admission.includes(`https://github.com/Reese-max/minideck/actions/runs/${run}`));
    assert.ok(admission.includes(sha));
  }
});

test("Successful historical local result is bound to its candidate SHA", () => {
  assert.ok(/\| candidate SHA \| `1eb700f5b28fd0493d5bc0bfbaf1da737fd79766`/.test(admission), "Successful local evidence must identify its candidate revision");
});
