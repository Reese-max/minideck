import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const player = await readFile(new URL("../public/play.html", import.meta.url), "utf8");
const editor = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const frame = player.match(/<iframe\b[^>]*id="play-deck"[^>]*>/i)?.[0] ?? "";
const previewFrame = editor.match(/<iframe\b[^>]*title="公開播放器預覽"[^>]*>/i)?.[0] ?? "";

assert.match(frame, /\bsandbox="allow-same-origin"/i);
assert.doesNotMatch(frame, /allow-scripts/i);
assert.match(previewFrame, /\bsandbox="allow-scripts"/i);
assert.doesNotMatch(previewFrame, /allow-same-origin/i);
console.log("PASS 分享播放器 iframe 禁止 deck 腳本執行");
console.log("PASS 編輯器預覽 iframe 不授予同源權限");
