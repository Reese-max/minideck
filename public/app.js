(() => {
  "use strict";

  const MD = (globalThis.MD ??= {});
  const IMAGE_PATTERN = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

  function attribute(tag, name) {
    return tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"))?.[2] ?? null;
  }

  function decodeAttribute(value) {
    return value
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  }

  function setSrc(tag, src) {
    const srcPattern = /(\ssrc\s*=\s*)(["'])([\s\S]*?)\2/i;
    if (srcPattern.test(tag)) {
      return tag.replace(srcPattern, (_match, prefix) => `${prefix}"${src}"`);
    }
    const closing = tag.endsWith("/>") ? "/>" : ">";
    return `${tag.slice(0, -closing.length)} src="${src}"${closing}`;
  }

  async function apiError(response) {
    try {
      const payload = await response.json();
      return new Error(payload.error || `請求失敗（HTTP ${response.status}）`);
    } catch {
      return new Error(`請求失敗（HTTP ${response.status}）`);
    }
  }

  async function jsonRequest(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await apiError(response);
    return response.json();
  }

  async function streamAction(path, body, onToken) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await apiError(response);
    if (!response.body) throw new Error("伺服器未提供串流回應");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let donePayload = null;

    const consume = async (block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!event || !data) return;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("伺服器串流格式無效");
      }
      if (event === "token" && typeof payload.text === "string") {
        await onToken?.(payload.text);
      } else if (event === "done") {
        donePayload = payload;
      } else if (event === "error") {
        const error = new Error(payload.message || "簡報生成失敗");
        error.refunded = payload.refunded === true;
        throw error;
      }
    };

    const drain = async (flush = false) => {
      let boundary;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await consume(block);
      }
      if (flush && buffer.trim()) {
        await consume(buffer);
        buffer = "";
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await drain();
    }
    buffer += decoder.decode();
    await drain(true);

    if (!donePayload || !Number.isInteger(donePayload.version)) {
      throw new Error("簡報串流未回傳完成事件");
    }
    return { version: donePayload.version };
  }

  MD.api = {
    createProject(brief, turnstileToken) {
      return jsonRequest("/api/projects", { brief, turnstileToken });
    },
    generate(id, onToken, style = "consultant-dark") {
      return streamAction(`/api/projects/${id}/generate`, { style }, onToken);
    },
    revise(id, message, onToken) {
      return streamAction(`/api/projects/${id}/revise`, { message }, onToken);
    },
    image(id, prompt, ar) {
      return jsonRequest(`/api/projects/${id}/image`, { prompt, ar });
    },
    saveDeck(id, html) {
      return jsonRequest(`/api/projects/${id}/deck`, { html });
    },
    async getProject(id) {
      const response = await fetch(`/api/projects/${id}`, { cache: "no-store" });
      if (!response.ok) throw await apiError(response);
      return response.json();
    },
    rollback(id, version) {
      return jsonRequest(`/api/projects/${id}/rollback`, { version });
    },
  };

  MD.pipeline = {
    scanPlaceholders(html) {
      return [...html.matchAll(IMAGE_PATTERN)]
        .map((match) => match[0])
        .filter((tag) => attribute(tag, "data-gen-prompt") !== null)
        .filter((tag) => !(attribute(tag, "src") ?? "").trim())
        .map((tag) => ({
          prompt: decodeAttribute(attribute(tag, "data-gen-prompt")),
          ar: decodeAttribute(attribute(tag, "data-gen-ar") ?? "16:9"),
        }));
    },

    async fillImages(id, html, onProgress) {
      const matches = [...html.matchAll(IMAGE_PATTERN)].filter((match) => {
        const tag = match[0];
        return (
          attribute(tag, "data-gen-prompt") !== null &&
          !(attribute(tag, "src") ?? "").trim()
        );
      });
      let cursor = 0;
      let output = "";

      for (const [index, match] of matches.entries()) {
        const tag = match[0];
        const prompt = decodeAttribute(attribute(tag, "data-gen-prompt"));
        const ar = decodeAttribute(attribute(tag, "data-gen-ar") ?? "16:9");
        const { url } = await MD.api.image(id, prompt, ar);
        output += html.slice(cursor, match.index) + setSrc(tag, url);
        cursor = match.index + tag.length;
        await onProgress?.(index + 1, matches.length, { prompt, ar, url });
      }

      return output + html.slice(cursor);
    },
  };

  if (typeof document === "undefined") return;

  const form = document.querySelector("#brief-form");
  const submitButton = form.querySelector('button[type="submit"]');
  const frame = document.querySelector("#deck-frame");
  const versionList = document.querySelector("#version-list");
  const previewVersion = document.querySelector("[data-preview-version]");
  const turnstileBox = document.querySelector("#cf-turnstile");
  const stageNames = ["generate", "images", "audit", "revise"];
  const stateLabels = { idle: "等待", active: "進行中", done: "完成", error: "錯誤" };
  const originLabels = {
    generate: "生成",
    imagefill: "填圖",
    revise: "修訂",
    rollback: "回滾",
  };
  let turnstileToken = "";
  let turnstileWidget;
  let busy = false;

  function setStage(name, stageState, detail) {
    const card = document.querySelector(`[data-stage="${name}"]`);
    if (!card) return;
    card.classList.remove("is-idle", "is-active", "is-done", "is-error");
    card.classList.add(`is-${stageState}`);
    card.dataset.state = stageState;
    card.querySelector(".stage-state").textContent = stateLabels[stageState];
    card.querySelector("p").textContent = detail;
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = busy || !turnstileToken;
    form.setAttribute("aria-busy", String(busy));
  }

  function turnstileError(message) {
    turnstileToken = "";
    turnstileBox.classList.add("is-error");
    turnstileBox.textContent = message;
    setBusy(false);
  }

  function initializeTurnstile() {
    const sitekey = document.querySelector('meta[name="turnstile-sitekey"]')?.content;
    if (!sitekey || !globalThis.turnstile?.render) {
      turnstileError("Turnstile 載入失敗，請檢查網路後重新整理。");
      return;
    }
    try {
      turnstileBox.replaceChildren();
      turnstileWidget = globalThis.turnstile.render(turnstileBox, {
        sitekey,
        theme: "dark",
        callback(token) {
          turnstileToken = token;
          turnstileBox.classList.remove("is-error");
          setBusy(false);
        },
        "expired-callback"() {
          turnstileToken = "";
          setBusy(false);
        },
        "error-callback"() {
          turnstileError("Turnstile 驗證失敗，請重新整理後再試。");
        },
      });
    } catch {
      turnstileError("Turnstile 無法初始化，請檢查網路後重新整理。");
    }
  }

  async function fetchDeck(id, version) {
    const response = await fetch(`/api/projects/${id}/deck?version=${version}`, {
      cache: "no-store",
    });
    if (!response.ok) throw await apiError(response);
    return response.text();
  }

  async function refreshQuota() {
    const response = await fetch("/api/quota", { cache: "no-store" });
    if (!response.ok) return;
    const quota = await response.json();
    const remaining = Math.min(
      quota.ipRemaining.projects,
      quota.globalRemaining.projects,
    );
    const quotaBox = document.querySelector(".quota");
    const quotaBar = document.querySelector("#quota-bar");
    quotaBox.querySelector("strong").textContent = remaining;
    quotaBar.setAttribute("aria-valuemax", "3");
    quotaBar.setAttribute("aria-valuenow", String(remaining));
    quotaBar.querySelector("span").style.width = `${Math.min(100, (remaining / 3) * 100)}%`;
  }

  function fitPreview() {
    const doc = frame.contentDocument;
    if (!doc?.head) return;
    doc.querySelector("#md-preview-style")?.remove();
    const scale = Math.min(frame.clientWidth / 1920, frame.clientHeight / 1080);
    const style = doc.createElement("style");
    style.id = "md-preview-style";
    style.textContent = `html,body{width:100%;height:100%;margin:0;overflow:hidden!important}section.slide{display:none!important}section.slide:first-of-type{display:block!important;transform:scale(${scale});transform-origin:top left}`;
    doc.head.append(style);
  }

  async function loadPreview(id, version) {
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.removeAttribute("srcdoc");
      frame.src = `/api/projects/${id}/deck?version=${version}&_=${Date.now()}`;
    });
    fitPreview();
    previewVersion.textContent = `版本 v${version}`;
    console.log("MD preview_loaded", `project=${id}`, `version=${version}`);
  }

  function formatTime(createdAt) {
    return new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "short",
      timeStyle: "medium",
      hour12: false,
    }).format(new Date(createdAt));
  }

  function renderVersions(id, versions) {
    const rows = versionList.querySelector(".version-rows");
    rows.replaceChildren();
    if (!versions.length) {
      const empty = document.createElement("p");
      empty.className = "version-empty";
      empty.textContent = "尚無版本";
      rows.append(empty);
      return;
    }

    for (const item of [...versions].reverse()) {
      const row = document.createElement("div");
      row.className = "version-row";
      const meta = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `v${item.version} · ${originLabels[item.origin] ?? item.origin}（${item.origin}）`;
      const time = document.createElement("time");
      time.dateTime = new Date(item.created_at).toISOString();
      time.textContent = formatTime(item.created_at);
      meta.append(title, time);

      const button = document.createElement("button");
      button.className = "outline-button version-rollback";
      button.type = "button";
      button.textContent = "回滾";
      button.dataset.version = item.version;
      button.addEventListener("click", async () => {
        versionList.querySelectorAll("button").forEach((target) => {
          target.disabled = true;
        });
        try {
          console.log("MD rollback_start", `project=${id}`, `source=${item.version}`);
          const result = await MD.api.rollback(id, item.version);
          console.log(
            "MD rollback_complete",
            `source=${item.version}`,
            `version=${result.version}`,
          );
          const project = await MD.api.getProject(id);
          renderVersions(id, project.versions);
          await loadPreview(id, result.version);
        } catch (error) {
          showError(error);
          versionList.querySelectorAll("button").forEach((target) => {
            target.disabled = false;
          });
        }
      });
      row.append(meta, button);
      rows.append(row);
    }
  }

  async function refreshVersions(id) {
    const project = await MD.api.getProject(id);
    renderVersions(id, project.versions);
    return project;
  }

  async function fillAndSave(id, html) {
    const placeholders = MD.pipeline.scanPlaceholders(html);
    setStage(
      "images",
      "active",
      placeholders.length ? `準備填入 ${placeholders.length} 張圖片` : "沒有圖片佔位符",
    );
    console.log("MD image_fill_start", `project=${id}`, `total=${placeholders.length}`);
    const filled = await MD.pipeline.fillImages(id, html, (current, total) => {
      setStage("images", "active", `配圖 ${current} / ${total}`);
      console.log("MD image_fill_progress", `project=${id}`, `progress=${current}/${total}`);
    });
    const saved = await MD.api.saveDeck(id, filled);
    setStage("images", "done", `已填入 ${placeholders.length} 張，儲存為 v${saved.version}`);
    console.log("MD save_deck_complete", `project=${id}`, `version=${saved.version}`);
    await loadPreview(id, saved.version);
    await refreshVersions(id);
    return saved;
  }

  async function generateAndFill(id, style) {
    let tokenChars = 0;
    let sawToken = false;
    setStage("generate", "active", "等待 MiniMax 串流⋯");
    console.log("MD generate_start", `project=${id}`, `style=${style}`);
    const generated = await MD.api.generate(
      id,
      (text) => {
        tokenChars += text.length;
        setStage("generate", "active", `已接收 ${tokenChars.toLocaleString("zh-TW")} 字元`);
        if (!sawToken) {
          sawToken = true;
          console.log("MD sse_token_received", `project=${id}`, `chars=${text.length}`);
        }
      },
      style,
    );
    setStage("generate", "done", `串流完成，產生 v${generated.version}`);
    console.log("MD generate_done", `project=${id}`, `version=${generated.version}`);
    const html = await fetchDeck(id, generated.version);
    await fillAndSave(id, html);
  }

  function showError(error) {
    const active = stageNames.find((name) =>
      document.querySelector(`[data-stage="${name}"]`)?.classList.contains("is-active"),
    );
    setStage(active ?? "generate", "error", error?.message ?? "處理失敗，請稍後再試");
    console.error("MD pipeline_error", error?.message ?? error);
  }

  async function resume() {
    const id = new URLSearchParams(location.hash.slice(1)).get("p");
    if (!id) return;
    console.log("MD resume_start", `project=${id}`);
    const project = await refreshVersions(id);
    if (!project.versions.length) {
      setStage("generate", "active", "專案仍在生成，請稍後重新整理");
      return;
    }

    const latest = project.versions.at(-1).version;
    setStage("generate", "done", `已恢復至 v${latest}`);
    const html = await fetchDeck(id, latest);
    const placeholders = MD.pipeline.scanPlaceholders(html);
    console.log(
      "MD resume_placeholders",
      `project=${id}`,
      `version=${latest}`,
      `total=${placeholders.length}`,
    );
    if (placeholders.length) {
      await fillAndSave(id, html);
    } else {
      setStage("images", "done", "圖片已完整填入");
      await loadPreview(id, latest);
    }
  }

  function resetShell() {
    setStage("generate", "idle", "等待開始");
    setStage("images", "idle", "等待生成完成");
    setStage("audit", "idle", "尚未執行");
    setStage("revise", "idle", "尚未執行");
    document.querySelector(".audit-summary").textContent = "尚未執行";
    document.querySelector(".audit-list").innerHTML =
      '<div class="audit-item"><strong>待執行</strong><span>目前尚無稽核結果。</span></div>';
    document.querySelector("#chat-log").innerHTML =
      '<div class="message assistant-message"><p>請先生成簡報。</p></div>';
    document.querySelectorAll("#export-buttons button").forEach((button) => {
      button.disabled = true;
    });
    submitButton.disabled = true;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!turnstileToken) {
      turnstileError("請先完成人機驗證。");
      return;
    }

    const brief = document.querySelector("#brief-input").value.trim();
    const pages = document.querySelector("#page-count").value;
    const style = document.querySelector("#style-select").value;
    const fullBrief = `${brief}\n\n請產生 ${pages} 頁。`;
    if ([...fullBrief].length > 2000) {
      showError(new Error("簡報需求加上頁數後不可超過 2000 字"));
      return;
    }

    setBusy(true);
    stageNames.forEach((name) => setStage(name, "idle", "等待中"));
    try {
      const { id } = await MD.api.createProject(fullBrief, turnstileToken);
      history.replaceState(null, "", `#p=${id}`);
      console.log("MD project_created", `project=${id}`);
      await refreshQuota();
      await generateAndFill(id, style);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      if (turnstileWidget !== undefined) {
        globalThis.turnstile?.reset(turnstileWidget);
        turnstileToken = "";
        setBusy(false);
      }
    }
  });

  resetShell();
  initializeTurnstile();
  refreshQuota().catch(() => {});
  addEventListener("resize", fitPreview);
  resume().catch(showError);
})();
