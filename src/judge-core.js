export const JUDGE_KEYS = Object.freeze([
  "typography",
  "dataviz",
  "narrative",
  "executive",
]);

export function parseJudgeJson(content) {
  const text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("MiniMax 評審回應不是 JSON");

  let payload;
  try {
    payload = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("MiniMax 評審回應不是合法 JSON");
  }

  const normalized = {};
  for (const key of JUDGE_KEYS) {
    const lens = payload?.[key];
    if (
      !lens ||
      typeof lens !== "object" ||
      !Number.isFinite(lens.score) ||
      lens.score < 0 ||
      lens.score > 10 ||
      !Array.isArray(lens.issues) ||
      lens.issues.some((issue) => typeof issue !== "string")
    ) {
      throw new Error(`MiniMax 評審回應缺少合法的 ${key} 結果`);
    }
    normalized[key] = {
      score: lens.score,
      issues: lens.issues
        .map((issue) => [...issue.trim()].slice(0, 500).join(""))
        .filter(Boolean)
        .slice(0, 20),
    };
  }
  return normalized;
}

export function htmlToPlainText(html, maxChars = 8000) {
  const withoutHiddenContent = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/section\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = withoutHiddenContent
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return " ";
      }
    })
    .replace(/&#(\d+);/g, (_match, decimal) => {
      try {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      } catch {
        return " ";
      }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return [...decoded].slice(0, maxChars).join("");
}
