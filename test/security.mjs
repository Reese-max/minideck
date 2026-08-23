import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const player = await readFile(new URL("../public/play.html", import.meta.url), "utf8");
const frame = player.match(/<iframe\b[^>]*id="play-deck"[^>]*>/i)?.[0] ?? "";

assert.match(frame, /\bsandbox="allow-same-origin"/i);
assert.doesNotMatch(frame, /allow-scripts/i);
console.log("PASS 分享播放器 iframe 禁止 deck 腳本執行");
