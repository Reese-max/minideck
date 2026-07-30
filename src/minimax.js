import SYSTEM_DECK from "../prompts/system-deck.md";

const TEXT_URL = "https://api.minimax.io/v1/chat/completions";
const IMAGE_URL = "https://api.minimax.io/v1/image_generation";
const encoder = new TextEncoder();

function sse(type, data) {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function deckIsComplete(html) {
  return (
    (html.match(/<section\s+class=["']slide["'][^>]*>/gi) ?? []).length >= 3 &&
    /<\/html\s*>/i.test(html)
  );
}

async function minimaxError(response, kind) {
  const responseText = await response.text();
  let detail = responseText.slice(0, 500);
  try {
    const payload = JSON.parse(responseText);
    detail =
      payload?.base_resp?.status_msg ??
      payload?.base_resp?.status_message ??
      payload?.error?.message ??
      detail;
  } catch {
    // 保留截短的原始回應供伺服器端診斷。
  }
  console.error(`minimax_${kind}_failed`, response.status, detail);
  return new Error(`MiniMax ${kind === "text" ? "文字" : "圖片"}生成失敗（HTTP ${response.status}）`);
}

async function readTextStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let html = "";

  const consumeLine = async (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error("MiniMax 文字串流格式無效");
    }
    const text = payload?.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) {
      html += text;
      await onText(text);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await consumeLine(line);
    }

    if (done) break;
  }
  if (buffer) await consumeLine(buffer);
  return html;
}

export function streamDeck({ apiKey, messages, ctx, onComplete, onFailure }) {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  let clientConnected = true;

  const send = async (type, data) => {
    if (!clientConnected) return;
    try {
      await writer.write(sse(type, data));
    } catch {
      clientConnected = false;
    }
  };

  const job = (async () => {
    try {
      if (!apiKey) throw new Error("伺服器未設定 MiniMax API key");
      console.log("minimax_text_request", "model=MiniMax-M3");
      const response = await fetch(TEXT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "MiniMax-M3",
          stream: true,
          thinking: { type: "disabled" },
          messages: [{ role: "system", content: SYSTEM_DECK }, ...messages],
        }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) throw await minimaxError(response, "text");
      if (!response.body) throw new Error("MiniMax 文字回應缺少串流內容");

      const html = await readTextStream(response.body, (text) =>
        send("token", { text }),
      );
      if (!deckIsComplete(html)) {
        throw new Error("MiniMax 回傳的簡報結構不完整");
      }

      const done = await onComplete(html);
      console.log("minimax_text_complete", `version=${done.version}`);
      await send("done", done);
    } catch (error) {
      console.error("minimax_text_error", error);
      let failure = {
        message: error?.message ?? "MiniMax 文字生成失敗",
        refunded: false,
      };
      try {
        failure = await onFailure(error);
      } catch (settleError) {
        console.error("minimax_text_settlement_failed", settleError);
      }
      await send("error", failure);
    } finally {
      try {
        await writer.close();
      } catch {
        // 前端已斷線；背景工作仍已完成。
      }
    }
  })();

  ctx.waitUntil(job);
  return new Response(stream.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

export async function imageHash(prompt, aspectRatio) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${prompt}|${aspectRatio}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

export async function generateImage(apiKey, prompt, aspectRatio, hash) {
  if (!apiKey) throw new Error("伺服器未設定 MiniMax API key");

  console.log("minimax_image_request", `hash=${hash}`, `ar=${aspectRatio}`);
  const response = await fetch(IMAGE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "image-01",
      prompt,
      aspect_ratio: aspectRatio,
      response_format: "base64",
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    console.error("minimax_image_non_json", response.status);
    throw new Error(`MiniMax 圖片 API 回傳非 JSON（HTTP ${response.status}）`);
  }

  const apiStatus = payload?.base_resp?.status_code;
  const apiMessage =
    payload?.base_resp?.status_msg ?? payload?.base_resp?.status_message;
  if (!response.ok) {
    console.error("minimax_image_failed", response.status, apiMessage ?? "");
    throw new Error(`MiniMax 圖片生成失敗（HTTP ${response.status}）`);
  }
  if (apiStatus !== undefined && apiStatus !== 0) {
    console.error("minimax_image_failed", apiStatus, apiMessage ?? "");
    throw new Error(`MiniMax 圖片生成失敗（錯誤 ${apiStatus}）`);
  }

  const encoded = payload?.data?.image_base64?.[0];
  if (typeof encoded !== "string" || !encoded) {
    throw new Error("MiniMax 圖片回應缺少 data.image_base64[0]");
  }
  const normalized = encoded.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4) {
    throw new Error("MiniMax API 回傳的圖片不是合法 base64");
  }

  const binary = atob(normalized);
  const image = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const isJpeg =
    image.length >= 3 &&
    image[0] === 0xff &&
    image[1] === 0xd8 &&
    image[2] === 0xff;
  const isPng =
    image.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => image[index] === byte,
    );
  if (image.length <= 10 * 1024 || (!isJpeg && !isPng)) {
    throw new Error(
      `圖片驗證失敗：${image.length} bytes，magic bytes 無效或檔案未超過 10KB`,
    );
  }

  return {
    image,
    contentType: isJpeg ? "image/jpeg" : "image/png",
  };
}
