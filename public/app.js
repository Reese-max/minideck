(() => {
  "use strict";

  const MD = (globalThis.MD ??= {});
  const IMAGE_PATTERN = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  const projectTokens = new Map();
  const projectTokenStoragePrefix = "minideck:project-token:";

  function rememberProjectToken(id, token) {
    if (!id || typeof token !== "string" || !token) return;
    projectTokens.set(id, token);
    try {
      globalThis.sessionStorage?.setItem(`${projectTokenStoragePrefix}${id}`, token);
    } catch {
      // 私密瀏覽模式可能禁止 sessionStorage；本頁記憶仍可用。
    }
  }

  function projectTokenFor(id) {
    if (!id) return "";
    const memoryToken = projectTokens.get(id);
    if (memoryToken) return memoryToken;
    try {
      const storedToken = globalThis.sessionStorage?.getItem(
        `${projectTokenStoragePrefix}${id}`,
      );
      if (storedToken) projectTokens.set(id, storedToken);
      return storedToken ?? "";
    } catch {
      return "";
    }
  }

  function projectHeaders(id, json = false) {
    const headers = json ? { "content-type": "application/json" } : {};
    const token = projectTokenFor(id);
    if (token) headers["X-Project-Token"] = token;
    return headers;
  }

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
      const error = new Error(payload.error || `請求失敗（HTTP ${response.status}）`);
      error.status = response.status;
      return error;
    } catch {
      const error = new Error(`請求失敗（HTTP ${response.status}）`);
      error.status = response.status;
      return error;
    }
  }

  async function jsonRequest(path, body, projectId) {
    const response = await fetch(path, {
      method: "POST",
      headers: projectHeaders(projectId, true),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await apiError(response);
    return response.json();
  }

  async function streamAction(path, body, onToken, projectId) {
    const response = await fetch(path, {
      method: "POST",
      headers: projectHeaders(projectId, true),
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
    async createProject(brief, turnstileToken) {
      const result = await jsonRequest("/api/projects", { brief, turnstileToken });
      rememberProjectToken(result.id, result.token);
      return result;
    },
    generate(id, onToken, style = "consultant-dark", sourceData = "") {
      return streamAction(
        `/api/projects/${id}/generate`,
        { style, ...(sourceData ? { sourceData } : {}) },
        onToken,
        id,
      );
    },
    revise(id, message, onToken) {
      return streamAction(`/api/projects/${id}/revise`, { message }, onToken, id);
    },
    image(id, prompt, ar) {
      return jsonRequest(`/api/projects/${id}/image`, { prompt, ar }, id);
    },
    saveDeck(id, html, origin = "imagefill") {
      return jsonRequest(`/api/projects/${id}/deck`, { html, origin }, id);
    },
    async getProject(id) {
      const response = await fetch(`/api/projects/${id}`, {
        cache: "no-store",
        headers: projectHeaders(id),
      });
      if (!response.ok) throw await apiError(response);
      return response.json();
    },
    rollback(id, version) {
      return jsonRequest(`/api/projects/${id}/rollback`, { version }, id);
    },
    judge(id, version) {
      return jsonRequest(`/api/projects/${id}/judge`, { version }, id);
    },
    publish(id, version) {
      return jsonRequest(`/api/projects/${id}/publish`, { version }, id);
    },
    unpublish(id) {
      return jsonRequest(`/api/projects/${id}/unpublish`, {}, id);
    },
    getDeck(id, version) {
      return fetchDeck(id, version);
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

  const CHROME_SELECTOR =
    '.kicker, .topline, .footline, .footer, .mark, .page, .pagenum, .badge, .tag, [class*="footnote"], [class*="page-num"], header, footer';

  function withoutPreviewStyle(doc, action) {
    const previewStyle = doc.querySelector("#md-preview-style");
    const previousMedia = previewStyle?.getAttribute("media");
    previewStyle?.setAttribute("media", "not all");
    try {
      return action();
    } finally {
      if (previewStyle) {
        if (previousMedia === null) previewStyle.removeAttribute("media");
        else previewStyle.setAttribute("media", previousMedia);
      }
    }
  }

  function measureSlides(doc) {
    return withoutPreviewStyle(doc, () =>
      [...doc.querySelectorAll("section.slide, .slide")].map((slide, index) => {
        const walker = doc.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
        const items = [];
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent.trim();
          if (!text) continue;
          const element = node.parentElement;
          const style = doc.defaultView.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            continue;
          }
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          let px = Number.parseFloat(style.fontSize);
          if (element.ownerSVGElement) {
            const svg = element.ownerSVGElement;
            const viewBox = svg.viewBox?.baseVal;
            const svgRect = svg.getBoundingClientRect();
            if (viewBox?.height > 0) px *= svgRect.height / viewBox.height;
          }
          items.push({
            element,
            text: text.slice(0, 40),
            fullText: text,
            px: Math.round(px * 10) / 10,
            length: text.length,
            chrome: Boolean(element.closest(CHROME_SELECTOR)),
          });
        }
        return { slide: index + 1, items };
      }),
    );
  }

  function issue(slide, type, detail) {
    return { slide, type, detail: `第${slide}頁：${detail}` };
  }

  MD.audit = {
    run(iframeDocument) {
      const fails = [];
      const warns = [];
      for (const { slide, items } of measureSlides(iframeDocument)) {
        const isSource = (text) => /^(?:來源|出處|source:)/i.test(text);
        const smallish = [];
        const bodyChars = items
          .filter((item) => !isSource(item.text))
          .reduce((sum, item) => sum + item.length, 0);
        const numbers = new Set();
        for (const item of items) {
          for (const match of item.text.matchAll(/\d+(?:[.,]\d+)?%?/g)) {
            numbers.add(match[0]);
          }
          if (item.px < 13) {
            fails.push(
              issue(slide, "font-min", `可見文字字級 ${item.px}px 低於 13px 底線：「${item.text}」`),
            );
          } else if (
            item.px < 17 &&
            !isSource(item.text) &&
            !item.chrome
          ) {
            smallish.push(item);
          }
        }
        warns.push(
          ...smallish
            .slice(0, 5)
            .map((item) =>
              issue(
                slide,
                "font-min",
                `內文字級 ${item.px}px 落在 13–16px 警示區間：「${item.text}」`,
              ),
            ),
        );
        if (bodyChars > 620) {
          fails.push(issue(slide, "density", `文字密度 ${bodyChars} 字超過 620 字`));
        } else if (bodyChars > 450) {
          warns.push(issue(slide, "density", `文字密度 ${bodyChars} 字偏高`));
        }
        if (numbers.size > 6) {
          warns.push(
            issue(slide, "numbers", `獨立數字 ${numbers.size} 個超過 6 個，可能資訊過載`),
          );
        }
      }
      return { fails, warns };
    },

    fixMechanical(iframeDocument) {
      const changed = new Set();
      for (const { items } of measureSlides(iframeDocument)) {
        for (const item of items) {
          if (item.px < 13 && !changed.has(item.element)) {
            item.element.style.setProperty("font-size", "16px", "important");
            changed.add(item.element);
          }
        }
      }
      return { changed: changed.size, floor: 13, target: 16 };
    },

    buildRevisePrompt(report) {
      const issues = [
        ...report.fails.filter((item) => item.type === "density"),
        ...report.warns.filter((item) => item.type === "numbers"),
      ];
      return [
        "請修正以下簡報稽核問題；保留既有事實、數據與主旨，不要新增投影片：",
        ...issues.map((item) => `- ${item.detail}`),
        "請以重排、分組與精簡重複措辭降低密度及數字過載，不要新增或清空圖片佔位符。",
      ].join("\n");
    },

    buildOptimizePrompt(report) {
      return [
        "目前稽核 WARN 清單：",
        ...(report.warns.length
          ? report.warns.map((item) => `- ${item.detail}`)
          : ["- 無 WARN"]),
        "",
        "強化視覺層級與留白平衡，維持所有內容不變",
        "不要新增或清空圖片佔位符。",
      ].join("\n");
    },

    buildIterationPrompt(report, steer = "") {
      const issues = [...report.fails, ...report.warns];
      const lines = [
        "請依本輪稽核結果修訂完整 HTML；保留既有事實、數據、頁數與主旨，不得捏造數字。",
        ...(steer ? [`使用者下一輪方向：${steer}`] : []),
        ...issues.slice(0, 8).map((item) => `- ${item.detail}`),
        ...(issues.length > 8 ? [`- 另有 ${issues.length - 8} 項同類問題，請一併處理。`] : []),
        "不要新增或清空圖片佔位符。",
      ];
      return [...lines.join("\n")].slice(0, 1000).join("");
    },
  };

  MD.iteration = {
    score(report) {
      return 100 - 20 * report.fails.length - 5 * report.warns.length;
    },

    async run({ maxRounds, step, rollback, shouldStop = () => false, onRound }) {
      const rounds = [];
      let cleanStreak = 0;
      let reason = maxRounds > 0 ? "quota" : shouldStop() ? "user" : "quota";

      while (rounds.length < maxRounds) {
        if (shouldStop()) {
          reason = "user";
          break;
        }
        let result;
        try {
          result = await step({ round: rounds.length + 1, previous: rounds.at(-1) ?? null });
        } catch (error) {
          if (error?.status === 429) {
            reason = "quota";
            break;
          }
          throw error;
        }
        const entry = {
          round: rounds.length + 1,
          version: result.version,
          report: result.report,
          score: MD.iteration.score(result.report),
        };
        rounds.push(entry);
        await onRound?.(entry);
        cleanStreak = entry.report.fails.length || entry.report.warns.length
          ? 0
          : cleanStreak + 1;
        if (cleanStreak >= 2) {
          reason = "clean";
          break;
        }
        if (shouldStop()) {
          reason = "user";
          break;
        }
      }

      const best = rounds.reduce(
        (winner, entry) => (!winner || entry.score >= winner.score ? entry : winner),
        null,
      );
      const rollbackResult = best ? await rollback(best.version) : null;
      return {
        rounds,
        best,
        reason,
        rollbackVersion: rollbackResult?.version ?? null,
      };
    },
  };

  const HQ_STYLES = Object.freeze([
    "consultant-dark",
    "minimal-light",
    "pitch-deck",
  ]);
  const HQ_LENSES = Object.freeze([
    "typography",
    "dataviz",
    "narrative",
    "executive",
  ]);
  const HQ_STYLE_LABELS = Object.freeze({
    "consultant-dark": "顧問深色",
    "minimal-light": "極簡亮色",
    "pitch-deck": "募資提案",
  });

  MD.hq = {
    styles: HQ_STYLES,

    totalScore(judgement) {
      return HQ_LENSES.reduce((total, lens) => {
        const score = judgement?.[lens]?.score;
        if (!Number.isFinite(score) || score < 0 || score > 10) {
          throw new Error(`評審結果缺少合法的 ${lens} 分數`);
        }
        if (!Array.isArray(judgement[lens].issues)) {
          throw new Error(`評審結果缺少合法的 ${lens} issues`);
        }
        return total + score;
      }, 0);
    },

    async run({ generate, prepare, judge, rollback, onVariant }) {
      const variants = [];
      for (const [index, style] of HQ_STYLES.entries()) {
        const generated = await generate(style, index + 1);
        if (!Number.isInteger(generated?.version)) {
          throw new Error("高標準生成未回傳版本");
        }
        const prepared = await prepare(generated.version, style, index + 1);
        const version = Number.isInteger(prepared) ? prepared : prepared?.version;
        if (!Number.isInteger(version)) {
          throw new Error("高標準填圖未回傳版本");
        }
        const judgement = await judge(version, style, index + 1);
        const entry = {
          style,
          generatedVersion: generated.version,
          version,
          judgement,
          total: MD.hq.totalScore(judgement),
        };
        variants.push(entry);
        await onVariant?.(entry, index + 1);
      }

      const winner = variants.reduce(
        (best, entry) => (!best || entry.total > best.total ? entry : best),
        null,
      );
      const rolledBack = await rollback(winner.version, winner);
      if (!Number.isInteger(rolledBack?.version)) {
        throw new Error("高標準回滾未回傳版本");
      }
      return { variants, winner, rollbackVersion: rolledBack.version };
    },

    tableHtml(result) {
      const lensHeaders = ["字體", "資料視覺", "敘事", "決策"];
      const rows = result.variants
        .map((entry) => {
          const cells = HQ_LENSES.map(
            (lens) => `<td>${entry.judgement[lens].score}</td>`,
          ).join("");
          const winner = entry === result.winner;
          return `<tr${winner ? ' class="is-winner"' : ""}><th scope="row">${HQ_STYLE_LABELS[entry.style]} · v${entry.version}${winner ? "（勝出）" : ""}</th>${cells}<td><strong>${entry.total}</strong></td></tr>`;
        })
        .join("");
      return `<table><thead><tr><th scope="col">變體</th>${lensHeaders.map((label) => `<th scope="col">${label}</th>`).join("")}<th scope="col">總分</th></tr></thead><tbody>${rows}</tbody></table><p class="hq-winner">已將 ${HQ_STYLE_LABELS[result.winner.style]} v${result.winner.version} 回滾為目前版本 v${result.rollbackVersion}。</p>`;
    },

    render(result, container) {
      container.innerHTML = MD.hq.tableHtml(result);
      container.hidden = false;
    },
  };

  if (typeof document === "undefined") return;

  const form = document.querySelector("#brief-form");
  if (!form) return;
  const submitButton = form.querySelector('button[type="submit"]');
  const frame = document.querySelector("#deck-frame");
  const optimizeButton = document.querySelector("#btn-optimize");
  const iterateButton = document.querySelector("#btn-iterate");
  const iterateStopButton = document.querySelector("#btn-iterate-stop");
  const iterateSteerInput = document.querySelector("#iterate-steer");
  const iteratePanel = document.querySelector("#iterate-panel");
  const hqMode = document.querySelector("#hq-mode");
  const hqCost = document.querySelector("#hq-cost");
  const hqResult = document.querySelector("#hq-result");
  const hqResultBody = hqResult.querySelector(".hq-result-body");
  const styleSelect = document.querySelector("#style-select");
  const htmlButton = document.querySelector("#btn-html");
  const pdfButton = document.querySelector("#btn-pdf");
  const pptxButton = document.querySelector("#btn-pptx");
  const shareButton = document.querySelector("#btn-share");
  const publishButton = document.querySelector("#btn-publish");
  const unpublishButton = document.querySelector("#btn-unpublish");
  const previewPublicButton = document.querySelector("#btn-preview-public");
  const shareStatus = document.querySelector("[data-share-status]");
  const downloadButtons = [htmlButton, pdfButton, pptxButton, shareButton];
  const versionList = document.querySelector("#version-list");
  const previewVersion = document.querySelector("[data-preview-version]");
  const turnstileBox = document.querySelector("#cf-turnstile");
  const stageNames = ["generate", "images", "audit", "revise"];
  const stateLabels = { idle: "等待", active: "進行中", done: "完成", error: "錯誤" };
  const originLabels = {
    generate: "生成",
    imagefill: "填圖",
    mechfix: "機械修正",
    revise: "修訂",
    rollback: "回滾",
  };
  let turnstileToken = "";
  let turnstileWidget;
  let busy = false;
  let currentAudit = null;
  let currentProjectId = "";
  let currentDeckVersion = 0;
  let publishState = { currentVersion: 0, publishedVersion: null };
  let iterationRunning = false;
  let iterationStopRequested = false;

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
    hqMode.disabled = busy;
    styleSelect.disabled = busy || hqMode.checked;
    optimizeButton.disabled = busy || !currentProjectId || !currentAudit;
    iterateButton.disabled = busy || !currentProjectId || !currentAudit;
    iterateStopButton.disabled = !iterationRunning;
    iterateSteerInput.disabled = !currentProjectId || (busy && !iterationRunning);
    downloadButtons.forEach((button) => {
      button.disabled = busy || !currentProjectId || !currentDeckVersion;
    });
    renderShareStatus();
    form.setAttribute("aria-busy", String(busy));
  }

  function renderShareStatus() {
    const { currentVersion, publishedVersion } = publishState;
    if (!currentProjectId || !currentVersion) {
      shareStatus.textContent = "尚未發佈";
    } else if (publishedVersion === null) {
      shareStatus.textContent = `草稿 v${currentVersion} · 尚未發佈`;
    } else {
      const pending = Math.max(0, currentVersion - publishedVersion);
      shareStatus.textContent = pending
        ? `草稿 v${currentVersion} · 已發佈 v${publishedVersion} · ${pending} 個未發佈變更`
        : `草稿 v${currentVersion} · 已發佈 v${publishedVersion}（最新）`;
    }
    previewPublicButton.disabled = busy || !currentProjectId || !currentDeckVersion;
    publishButton.disabled = busy || !currentProjectId || !currentDeckVersion;
    unpublishButton.disabled =
      busy || !currentProjectId || publishedVersion === null;
  }

  function syncHqMode() {
    hqCost.hidden = !hqMode.checked;
    styleSelect.disabled = busy || hqMode.checked;
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
    const query = version !== undefined && version !== null ? `?version=${version}` : "";
    const response = await fetch(`/api/projects/${id}/deck${query}`, {
      cache: "no-store",
      headers: projectHeaders(id),
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
    const html = await fetchDeck(id, version);
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.removeAttribute("src");
      frame.srcdoc = html;
    });
    fitPreview();
    currentDeckVersion = version;
    previewVersion.textContent = `版本 v${version}`;
    setBusy(busy);
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
      if (item.version === publishState.publishedVersion) {
        const badge = document.createElement("span");
        badge.className = "version-published";
        badge.textContent = "已發佈";
        meta.append(badge);
      }

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
          await refreshVersions(id);
          await loadPreview(id, result.version);
          currentProjectId = id;
          await auditAndFix(id, false);
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
    publishState = {
      currentVersion:
        project.current_version ?? project.versions.at(-1)?.version ?? 0,
      publishedVersion: project.published_version ?? null,
    };
    renderVersions(id, project.versions);
    renderShareStatus();
    iteratePanel.querySelector(".iterate-quota").textContent = `已用修訂額度 ${reviseQuotaUsed(project)} / 6`;
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

  function serializeDeck(doc) {
    const root = doc.documentElement.cloneNode(true);
    root.querySelector("#md-preview-style")?.remove();
    return `<!doctype html>\n${root.outerHTML}`;
  }

  async function latestDeck() {
    if (!currentProjectId) throw new Error("目前沒有可匯出的簡報");
    const project = await MD.api.getProject(currentProjectId);
    const version = project.versions.at(-1)?.version;
    if (!version) throw new Error("目前沒有可匯出的簡報版本");
    return {
      version,
      html: await fetchDeck(currentProjectId, version),
    };
  }

  async function ensureLatestPreview() {
    const deck = await latestDeck();
    if (currentDeckVersion !== deck.version) {
      await loadPreview(currentProjectId, deck.version);
    }
    return deck;
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const PRINT_STYLE = `@page{size:338.667mm 190.5mm;margin:0}
html,body{margin:0!important;padding:0!important;background:#fff!important}
.slide{display:block!important;width:1920px!important;height:1080px!important;overflow:hidden!important;page-break-after:always;break-after:page}
.slide:last-of-type{page-break-after:auto;break-after:auto}`;

  MD.exportx = {
    lastPptxErrors: [],

    async html() {
      const deck = await latestDeck();
      return new Blob([deck.html], { type: "text/html;charset=utf-8" });
    },

    async pdf() {
      const printWindow = window.open("", "_blank");
      if (!printWindow) throw new Error("瀏覽器封鎖了列印視窗，請允許彈出式視窗後重試");
      try {
        const deck = await latestDeck();
        printWindow.document.open();
        printWindow.document.write(deck.html);
        printWindow.document.close();
        await new Promise((resolve) => setTimeout(resolve));
        const base = printWindow.document.createElement("base");
        base.href = `${location.origin}/`;
        printWindow.document.head.prepend(base);
        const style = printWindow.document.createElement("style");
        style.id = "md-print-style";
        style.textContent = PRINT_STYLE;
        printWindow.document.head.append(style);
        await printWindow.document.fonts?.ready;
        await Promise.all(
          [...printWindow.document.images].map((image) =>
            image.complete
              ? Promise.resolve()
              : new Promise((resolve) => {
                  image.addEventListener("load", resolve, { once: true });
                  image.addEventListener("error", resolve, { once: true });
                }),
          ),
        );
        printWindow.focus();
        printWindow.print();
      } catch (error) {
        printWindow.close();
        throw error;
      }
    },

    async pptx(iframeDocument = frame.contentDocument) {
      if (!globalThis.PptxGenJS || !globalThis.htmlToImage?.toPng) {
        throw new Error("PPTX 匯出元件未載入");
      }
      const sourceSlides = [...iframeDocument.querySelectorAll("section.slide")];
      if (!sourceSlides.length) throw new Error("簡報沒有可匯出的投影片");

      const textBySlide = measureSlides(iframeDocument).map(({ items }) =>
        items.map((item) => item.fullText).join("\n"),
      );
      const pptx = new globalThis.PptxGenJS();
      pptx.layout = "LAYOUT_WIDE";
      pptx.author = "minideck";
      pptx.company = "minideck";
      pptx.subject = "minideck HTML 簡報匯出";
      pptx.title = iframeDocument.title || "minideck 簡報";
      const failures = [];
      const previewStyle = iframeDocument.querySelector("#md-preview-style");
      const previewMedia = previewStyle?.getAttribute("media");
      previewStyle?.setAttribute("media", "not all");

      try {
        await new Promise(requestAnimationFrame);
        for (const [index, sourceSlide] of sourceSlides.entries()) {
          const slide = pptx.addSlide();
          const notes = textBySlide[index].trim();
          slide.addNotes(notes || `第 ${index + 1} 頁無可見文字`);
          const name = notes.split("\n")[0]?.slice(0, 50) || `第 ${index + 1} 頁`;
          try {
            const data = await globalThis.htmlToImage.toPng(sourceSlide, {
              width: 1920,
              height: 1080,
              canvasWidth: 1920,
              canvasHeight: 1080,
              pixelRatio: 1,
              cacheBust: true,
            });
            slide.addImage({ data, x: 0, y: 0, w: 13.333, h: 7.5 });
          } catch (error) {
            failures.push(`${index + 1}. ${name}`);
            console.error("MD pptx_slide_failed", `slide=${index + 1}`, name, error);
            slide.addText(`第 ${index + 1} 頁匯出失敗：${name}`, {
              x: 0.8,
              y: 3.2,
              w: 11.7,
              h: 0.8,
              align: "center",
              color: "7A2430",
              fontFace: "Microsoft JhengHei",
              fontSize: 20,
            });
          }
        }
      } finally {
        if (previewStyle) {
          if (previewMedia === null) previewStyle.removeAttribute("media");
          else previewStyle.setAttribute("media", previewMedia);
        }
      }

      MD.exportx.lastPptxErrors = failures;
      return pptx.write({ outputType: "blob" });
    },

    async share() {
      if (!currentProjectId) throw new Error("目前沒有可分享的簡報");
      const url = `${location.origin}/p/${currentProjectId}`;
      await navigator.clipboard.writeText(url);
      return url;
    },
  };

  function renderAudit(report) {
    const reportBox = document.querySelector("#audit-report");
    const list = reportBox.querySelector(".audit-list");
    const total = report.fails.length + report.warns.length;
    reportBox.classList.toggle("has-fails", report.fails.length > 0);
    reportBox.classList.toggle(
      "has-warns",
      report.fails.length === 0 && report.warns.length > 0,
    );
    reportBox.querySelector(".audit-summary").textContent = report.fails.length
      ? `${report.fails.length} FAIL / ${report.warns.length} WARN`
      : report.warns.length
        ? `0 FAIL / ${report.warns.length} WARN`
        : "PASS";
    list.replaceChildren();

    const rows = total
      ? [
          ...report.fails.map((item) => ["FAIL", "audit-fail", item.detail]),
          ...report.warns.map((item) => ["WARN", "audit-warn", item.detail]),
        ]
      : [["PASS", "audit-pass", "所有投影片均通過目前稽核判準。"]];
    for (const [label, className, detail] of rows) {
      const row = document.createElement("div");
      row.className = `audit-item ${className}`;
      const strong = document.createElement("strong");
      strong.textContent = label;
      const text = document.createElement("span");
      text.textContent = detail;
      row.append(strong, text);
      list.append(row);
    }
    reportBox.open = report.fails.length > 0;
    currentAudit = report;
  }

  function logAudit(phase, report) {
    console.log(
      "MD audit_result",
      `phase=${phase}`,
      `fails=${report.fails.length}`,
      `warns=${report.warns.length}`,
    );
  }

  function reviseQuotaUsed(project) {
    return project.messages.filter((message) => message.role === "user").length;
  }

  function resetIterationPanel() {
    iteratePanel.querySelector(".iterate-status").textContent = "尚未開始";
    iteratePanel.querySelector(".iterate-quota").textContent = "已用修訂額度 0 / 6";
    iteratePanel.querySelector(".iterate-rounds").innerHTML =
      '<p class="iterate-empty">每輪分數會顯示在這裡。</p>';
  }

  function renderIterationRound(entry, used) {
    const rows = iteratePanel.querySelector(".iterate-rounds");
    rows.querySelector(".iterate-empty")?.remove();
    const row = document.createElement("div");
    row.className = "iterate-round";
    const score = document.createElement("strong");
    score.textContent = `第 ${entry.round} 輪 · ${entry.score} 分`;
    const detail = document.createElement("span");
    detail.textContent = `v${entry.version} · ${entry.report.fails.length} FAIL / ${entry.report.warns.length} WARN`;
    row.append(score, detail);
    rows.append(row);
    iteratePanel.querySelector(".iterate-quota").textContent = `已用修訂額度 ${used} / 6`;
  }

  async function auditAndFix(id, allowAutoRevise = true) {
    currentProjectId = id;
    optimizeButton.disabled = true;
    setStage("audit", "active", "量測所有投影片⋯");
    let report = MD.audit.run(frame.contentDocument);
    logAudit("initial", report);

    if (report.fails.some((item) => item.type === "font-min")) {
      const fixed = MD.audit.fixMechanical(frame.contentDocument);
      console.log(
        "MD mechfix_apply",
        `project=${id}`,
        `elements=${fixed.changed}`,
        `floor=${fixed.floor}px`,
        `target=${fixed.target}px`,
      );
      if (fixed.changed) {
        const saved = await MD.api.saveDeck(
          id,
          serializeDeck(frame.contentDocument),
          "mechfix",
        );
        console.log("MD mechfix_saved", `project=${id}`, `version=${saved.version}`);
        await loadPreview(id, saved.version);
        await refreshVersions(id);
        report = MD.audit.run(frame.contentDocument);
        logAudit("after_mechfix", report);
      }
    }

    renderAudit(report);
    const reviseIssues = [
      ...report.fails.filter((item) => item.type === "density"),
      ...report.warns.filter((item) => item.type === "numbers"),
    ];
    const autoFixKey = `md-auto-revise:${id}`;
    if (
      allowAutoRevise &&
      reviseIssues.length &&
      sessionStorage.getItem(autoFixKey) !== "attempted"
    ) {
      sessionStorage.setItem(autoFixKey, "attempted");
      const prompt = MD.audit.buildRevisePrompt(report);
      setStage("revise", "active", `修正 ${reviseIssues.length} 項密度／數字問題⋯`);
      console.log("MD auto_revise_start", `project=${id}`, `issues=${reviseIssues.length}`);
      const revised = await MD.api.revise(id, prompt);
      console.log("MD auto_revise_done", `project=${id}`, `version=${revised.version}`);
      const html = await fetchDeck(id, revised.version);
      await fillAndSave(id, html);
      report = MD.audit.run(frame.contentDocument);
      logAudit("after_revise", report);
      renderAudit(report);
      setStage("revise", "done", `已完成一次自動修訂；最終仍有 ${report.fails.length} FAIL`);
    } else {
      setStage(
        "revise",
        "done",
        reviseIssues.length ? "已停止自動修訂，請查看剩餘清單" : "不需使用修訂額度",
      );
    }
    setStage(
      "audit",
      "done",
      `最終 ${report.fails.length} FAIL / ${report.warns.length} WARN`,
    );
    console.log(
      "MD audit_final",
      `project=${id}`,
      `fails=${report.fails.length}`,
      `warns=${report.warns.length}`,
    );
    optimizeButton.disabled = busy || !currentProjectId;
    return report;
  }

  async function generateAndFill(id, style, sourceData) {
    let tokenChars = 0;
    let sawToken = false;
    setStage("generate", "active", "等待 MiniMax 串流⋯");
    console.log(
      "MD generate_start",
      `project=${id}`,
      `style=${style}`,
      `source_chars=${[...sourceData].length}`,
    );
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
      sourceData,
    );
    setStage("generate", "done", `串流完成，產生 v${generated.version}`);
    console.log("MD generate_done", `project=${id}`, `version=${generated.version}`);
    const html = await fetchDeck(id, generated.version);
    await fillAndSave(id, html);
    await auditAndFix(id);
  }

  async function runHighQuality(id, sourceData) {
    hqResult.hidden = false;
    hqResultBody.textContent = "準備三個變體⋯";
    setStage("revise", "idle", "競賽完成後回滾勝出版本");
    console.log(
      "MD hq_start",
      `project=${id}`,
      "text_calls_expected=6",
      "variants=3",
    );

    const result = await MD.hq.run({
      generate: async (style, index) => {
        let tokenChars = 0;
        setStage("generate", "active", `生成變體 ${index} / 3（${HQ_STYLE_LABELS[style]}）⋯`);
        console.log(
          "MD hq_generate_start",
          `project=${id}`,
          `variant=${index}/3`,
          `style=${style}`,
        );
        const generated = await MD.api.generate(
          id,
          (text) => {
            tokenChars += text.length;
            setStage(
              "generate",
              "active",
              `變體 ${index} / 3 已接收 ${tokenChars.toLocaleString("zh-TW")} 字元`,
            );
          },
          style,
          sourceData,
        );
        console.log(
          "MD hq_generate_done",
          `project=${id}`,
          `variant=${index}/3`,
          `version=${generated.version}`,
        );
        return generated;
      },
      prepare: async (generatedVersion, style, index) => {
        const html = await fetchDeck(id, generatedVersion);
        const saved = await fillAndSave(id, html);
        console.log(
          "MD hq_variant_prepared",
          `project=${id}`,
          `variant=${index}/3`,
          `style=${style}`,
          `generated=${generatedVersion}`,
          `version=${saved.version}`,
        );
        return saved;
      },
      judge: async (version, style, index) => {
        setStage("audit", "active", `四鏡頭評審變體 ${index} / 3⋯`);
        const judgement = await MD.api.judge(id, version);
        console.log(
          "MD hq_judge_done",
          `project=${id}`,
          `variant=${index}/3`,
          `style=${style}`,
          `version=${version}`,
          `total=${MD.hq.totalScore(judgement)}`,
        );
        return judgement;
      },
      onVariant: (entry, index) => {
        hqResultBody.textContent = `已完成 ${index} / 3：${HQ_STYLE_LABELS[entry.style]} ${entry.total} 分`;
      },
      rollback: async (version) => {
        const rolledBack = await MD.api.rollback(id, version);
        console.log(
          "MD hq_rollback",
          `project=${id}`,
          `source=${version}`,
          `version=${rolledBack.version}`,
        );
        return rolledBack;
      },
    });

    MD.hq.render(result, hqResultBody);
    await refreshVersions(id);
    await loadPreview(id, result.rollbackVersion);
    const report = MD.audit.run(frame.contentDocument);
    renderAudit(report);
    logAudit("hq_winner", report);
    setStage("generate", "done", "三個風格變體皆已生成");
    setStage("images", "done", "三個變體皆已依序填圖");
    setStage("audit", "done", `勝出版本 ${report.fails.length} FAIL / ${report.warns.length} WARN`);
    setStage("revise", "done", `已回滾勝出版本為 v${result.rollbackVersion}`);
    console.log(
      "MD hq_complete",
      `project=${id}`,
      `winner_style=${result.winner.style}`,
      `winner_version=${result.winner.version}`,
      `winner_total=${result.winner.total}`,
      `rollback_version=${result.rollbackVersion}`,
      "text_calls=6",
    );
    return result;
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
    currentProjectId = id;
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
    await auditAndFix(id);
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
    currentAudit = null;
    currentProjectId = "";
    currentDeckVersion = 0;
    publishState = { currentVersion: 0, publishedVersion: null };
    shareStatus.textContent = "尚未發佈";
    iterationRunning = false;
    iterationStopRequested = false;
    resetIterationPanel();
    hqResult.hidden = true;
    hqResultBody.replaceChildren();
    iterateSteerInput.value = "";
    submitButton.disabled = true;
  }

  async function runExport(button, label, action) {
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = `${label}中⋯`;
    try {
      await action();
    } catch (error) {
      console.error("MD export_error", `type=${label}`, error);
      alert(error?.message ?? `${label}失敗`);
    } finally {
      button.innerHTML = original;
      setBusy(busy);
    }
  }

  htmlButton.addEventListener("click", () =>
    runExport(htmlButton, "HTML 匯出", async () => {
      const blob = await MD.exportx.html();
      downloadBlob(blob, `minideck-${currentProjectId}.html`);
      console.log("MD export_complete", "type=html", `bytes=${blob.size}`);
    }),
  );

  pdfButton.addEventListener("click", () =>
    runExport(pdfButton, "PDF 列印", () => MD.exportx.pdf()),
  );

  pptxButton.addEventListener("click", () =>
    runExport(pptxButton, "PPTX 匯出", async () => {
      await ensureLatestPreview();
      const blob = await MD.exportx.pptx(frame.contentDocument);
      downloadBlob(blob, `minideck-${currentProjectId}.pptx`);
      console.log(
        "MD export_complete",
        "type=pptx",
        `bytes=${blob.size}`,
        `failed_slides=${MD.exportx.lastPptxErrors.length}`,
      );
      if (MD.exportx.lastPptxErrors.length) {
        alert(`以下投影片轉圖失敗，已保留頁面與備忘稿：\n${MD.exportx.lastPptxErrors.join("\n")}`);
      }
    }),
  );

  shareButton.addEventListener("click", () =>
    runExport(shareButton, "複製分享連結", async () => {
      if (
        publishState.publishedVersion === null &&
        !confirm("尚未發佈任何版本，收件者暫時無法開啟連結。仍要複製嗎？")
      ) {
        return;
      }
      const url = await MD.exportx.share();
      console.log("MD share_link_copied", url);
    }),
  );

  previewPublicButton.addEventListener("click", () =>
    runExport(previewPublicButton, "公開預覽", async () => {
      const response = await fetch(
        `/p/${currentProjectId}?version=${currentDeckVersion}`,
        { cache: "no-store", headers: projectHeaders(currentProjectId) },
      );
      if (!response.ok) throw await apiError(response);
      const html = await response.text();
      if (!html.includes("<head>")) throw new Error("公開預覽頁面格式異常");
      const previewHtml = html.replace(
        "<head>",
        `<head><base href="${location.origin}/">`,
      );
      const url = URL.createObjectURL(
        new Blob([previewHtml], { type: "text/html" }),
      );
      const opened = window.open(url, "_blank", "noopener");
      if (opened) {
        opened.addEventListener("load", () => URL.revokeObjectURL(url), {
          once: true,
        });
      } else {
        URL.revokeObjectURL(url);
      }
      console.log(
        "MD public_preview_opened",
        `project=${currentProjectId}`,
        `version=${currentDeckVersion}`,
      );
    }),
  );

  publishButton.addEventListener("click", () =>
    runExport(publishButton, "發佈", async () => {
      if (!confirm(`發佈預覽中的 v${currentDeckVersion} 為公開版本？`)) return;
      const result = await MD.api.publish(currentProjectId, currentDeckVersion);
      console.log(
        "MD publish_done",
        `project=${currentProjectId}`,
        `version=${result.version}`,
      );
      await refreshVersions(currentProjectId);
    }),
  );

  unpublishButton.addEventListener("click", () =>
    runExport(unpublishButton, "下線", async () => {
      if (!confirm("確定下線公開分享連結？專案與所有草稿版本會保留。")) return;
      await MD.api.unpublish(currentProjectId);
      console.log("MD unpublish_done", `project=${currentProjectId}`);
      await refreshVersions(currentProjectId);
    }),
  );

  optimizeButton.addEventListener("click", async () => {
    if (busy || !currentProjectId || !currentAudit) return;
    setBusy(true);
    try {
      const prompt = MD.audit.buildOptimizePrompt(currentAudit);
      console.log("MD optimize_start", `project=${currentProjectId}`);
      console.log("MD optimize_prompt", prompt.replaceAll("\n", " | "));
      setStage("revise", "active", "依 WARN 清單進行一鍵優化⋯");
      const revised = await MD.api.revise(currentProjectId, prompt);
      console.log(
        "MD optimize_revise_done",
        `project=${currentProjectId}`,
        `version=${revised.version}`,
      );
      const html = await fetchDeck(currentProjectId, revised.version);
      await fillAndSave(currentProjectId, html);
      await auditAndFix(currentProjectId, false);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  });

  iterateStopButton.addEventListener("click", () => {
    if (!iterationRunning) return;
    iterationStopRequested = true;
    iterateStopButton.disabled = true;
    iterateSteerInput.disabled = true;
    iteratePanel.querySelector(".iterate-status").textContent = "本輪完成後停止並回到最高分版本⋯";
    console.log("MD iterate_stop_requested", `project=${currentProjectId}`);
  });

  iterateButton.addEventListener("click", async () => {
    if (busy || !currentProjectId || !currentAudit) return;
    const id = currentProjectId;
    iterationRunning = true;
    iterationStopRequested = false;
    resetIterationPanel();
    setBusy(true);
    try {
      const project = await MD.api.getProject(id);
      let quotaUsed = reviseQuotaUsed(project);
      iteratePanel.querySelector(".iterate-quota").textContent = `已用修訂額度 ${quotaUsed} / 6`;
      iteratePanel.querySelector(".iterate-status").textContent = "迭代進行中⋯";
      const result = await MD.iteration.run({
        maxRounds: Math.max(0, 6 - quotaUsed),
        shouldStop: () => iterationStopRequested,
        step: async ({ round, previous }) => {
          const steer = iterateSteerInput.value.trim();
          iterateSteerInput.value = "";
          const prompt = MD.audit.buildIterationPrompt(previous?.report ?? currentAudit, steer);
          console.log(
            "MD iterate_round_start",
            `project=${id}`,
            `round=${round}`,
            `steer_chars=${[...steer].length}`,
          );
          setStage("revise", "active", `迭代第 ${round} 輪修訂中⋯`);
          const revised = await MD.api.revise(id, prompt);
          console.log(
            "MD iterate_revise_done",
            `project=${id}`,
            `round=${round}`,
            `version=${revised.version}`,
          );
          const html = await fetchDeck(id, revised.version);
          await fillAndSave(id, html);
          const report = await auditAndFix(id, false);
          logAudit(`iterate_${round}`, report);
          renderAudit(report);
          quotaUsed += 1;
          console.log(
            "MD iterate_round_score",
            `project=${id}`,
            `round=${round}`,
            `version=${currentDeckVersion}`,
            `score=${MD.iteration.score(report)}`,
            `fails=${report.fails.length}`,
            `warns=${report.warns.length}`,
            `quota=${quotaUsed}/6`,
          );
          return { version: currentDeckVersion, report };
        },
        onRound: (entry) => renderIterationRound(entry, quotaUsed),
        rollback: async (version) => {
          const rolledBack = await MD.api.rollback(id, version);
          console.log(
            "MD iterate_rollback",
            `project=${id}`,
            `source=${version}`,
            `version=${rolledBack.version}`,
          );
          return rolledBack;
        },
      });

      if (result.rollbackVersion) {
        await refreshVersions(id);
        await loadPreview(id, result.rollbackVersion);
        const report = MD.audit.run(frame.contentDocument);
        renderAudit(report);
        setStage("audit", "done", `最高分版本：${report.fails.length} FAIL / ${report.warns.length} WARN`);
      }
      const reason = {
        user: "使用者已停止",
        quota: "修訂額度已用罄",
        clean: "連續兩輪 0 FAIL / 0 WARN",
      }[result.reason];
      iteratePanel.querySelector(".iterate-status").textContent = result.best
        ? `${reason}；最高 ${result.best.score} 分（v${result.best.version}），已回滾為 v${result.rollbackVersion}`
        : `${reason}；尚無可回滾的迭代版本`;
      console.log(
        "MD iterate_complete",
        `project=${id}`,
        `reason=${result.reason}`,
        `rounds=${result.rounds.length}`,
        `best_score=${result.best?.score ?? "none"}`,
        `best_version=${result.best?.version ?? "none"}`,
        `rollback_version=${result.rollbackVersion ?? "none"}`,
        `quota=${quotaUsed}/6`,
      );
    } catch (error) {
      showError(error);
    } finally {
      iterationRunning = false;
      iterationStopRequested = false;
      setBusy(false);
    }
  });

  hqMode.addEventListener("change", syncHqMode);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!turnstileToken) {
      turnstileError("請先完成人機驗證。");
      return;
    }

    const brief = document.querySelector("#brief-input").value.trim();
    const pages = document.querySelector("#page-count").value;
    const style = styleSelect.value;
    const sourceData = document.querySelector("#source-data").value.trim();
    const highQuality = hqMode.checked;
    const fullBrief = `${brief}\n\n請產生 ${pages} 頁。`;
    if ([...fullBrief].length > 2000) {
      showError(new Error("簡報需求加上頁數後不可超過 2000 字"));
      return;
    }

    setBusy(true);
    stageNames.forEach((name) => setStage(name, "idle", "等待中"));
    hqResult.hidden = true;
    hqResultBody.replaceChildren();
    try {
      const { id } = await MD.api.createProject(fullBrief, turnstileToken);
      currentProjectId = id;
      history.replaceState(null, "", `#p=${id}`);
      console.log("MD project_created", `project=${id}`);
      await refreshQuota();
      if (highQuality) await runHighQuality(id, sourceData);
      else await generateAndFill(id, style, sourceData);
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
  syncHqMode();
  initializeTurnstile();
  refreshQuota().catch(() => {});
  addEventListener("resize", fitPreview);
  resume().catch(showError);
})();
