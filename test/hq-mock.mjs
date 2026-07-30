import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const context = { console };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "public/app.js" });
const { MD } = context;

const scores = {
  1: [5, 6, 5, 6],
  2: [7, 6, 6, 6],
  3: [4, 5, 5, 5],
};
const judgement = (version) => {
  const [typography, dataviz, narrative, executive] = scores[version];
  return {
    typography: { score: typography, issues: [] },
    dataviz: { score: dataviz, issues: [] },
    narrative: { score: narrative, issues: [] },
    executive: { score: executive, issues: [] },
  };
};

let nextVersion = 0;
let rollbackSource = 0;
const result = await MD.hq.run({
  async generate() {
    nextVersion += 1;
    return { version: nextVersion };
  },
  async prepare(version) {
    return { version };
  },
  async judge(version) {
    return judgement(version);
  },
  async rollback(version) {
    rollbackSource = version;
    return { version: 4 };
  },
});

assert.deepEqual(
  Array.from(result.variants, (variant) => variant.total),
  [22, 25, 19],
);
assert.equal(result.winner.version, 2);
assert.equal(rollbackSource, 2);
assert.equal(result.rollbackVersion, 4);

const hqResult = { hidden: true, innerHTML: "" };
MD.hq.render(result, hqResult);
assert.equal(hqResult.hidden, false);
assert.match(hqResult.innerHTML, /<table>/);
assert.match(hqResult.innerHTML, />22</);
assert.match(hqResult.innerHTML, />25</);
assert.match(hqResult.innerHTML, />19</);
assert.match(hqResult.innerHTML, /v2（勝出）/);
assert.match(hqResult.innerHTML, /目前版本 v4/);
console.log(
  "PASS HQ mock：三版分數 22/25/19，勝者 v2，rollback 來源 v2，目前 v4，#hq-result 三版分數表已渲染",
);
