import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

// Shared Cloudflare binding fakes for worker-level tests.
// D1 is emulated over node:sqlite; R2 and Assets are in-memory maps.

export function createD1(schemaFile = "../schema.sql") {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL(schemaFile, import.meta.url), "utf8");
  for (const statement of schema.split(";")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }

  // node:sqlite is a single connection, while D1 runs each statement on the
  // server side. Queue every statement so a batch's transaction can never
  // interleave with another request's write and roll it back by accident.
  let queue = Promise.resolve();
  const locked = (work) => {
    const result = queue.then(work, work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    // Raw escape hatch for fixtures that need to seed or damage rows the
    // product API never exposes.
    exec(sql) {
      return locked(() => db.exec(sql));
    },
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        first() {
          const args = bound;
          return locked(() => db.prepare(sql).get(...args) ?? null);
        },
        all() {
          const args = bound;
          return locked(() => ({ results: db.prepare(sql).all(...args) }));
        },
        run() {
          const args = bound;
          return locked(() => {
            const info = db.prepare(sql).run(...args);
            return { meta: { changes: Number(info.changes) } };
          });
        },
        // Unlocked execution, used by batch() while it already owns the queue.
        __all() {
          return { results: db.prepare(sql).all(...bound) };
        },
      };
    },
    batch(statements) {
      // D1 runs a batch inside a single transaction: a statement that throws
      // leaves none of the batch's writes behind. Model that here, otherwise
      // "no partial state" assertions are vacuously true.
      return locked(async () => {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const stmt of statements) {
            results.push(await stmt.__all());
          }
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  };
}

export function createBucket() {
  const store = new Map();
  return {
    async put(key, body, options = {}) {
      let content;
      if (typeof body === "string") {
        content = body;
      } else if (body && typeof body.text === "function") {
        content = await body.text();
      } else {
        content = String(body);
      }
      store.set(key, {
        content,
        httpMetadata: options.httpMetadata ?? {},
      });
      return { key };
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        writeHttpMetadata(headers) {
          if (item.httpMetadata?.contentType) {
            headers.set("content-type", item.httpMetadata.contentType);
          }
        },
        body: item.content,
        async text() {
          return item.content;
        },
      };
    },
    async head(key) {
      return store.has(key) ? {} : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export function createAssets() {
  const playHtml = readFileSync(
    new URL("../public/play.html", import.meta.url),
    "utf8",
  );
  return {
    async fetch(reqUrl) {
      const url = new URL(reqUrl);
      if (url.pathname === "/play.html") {
        return new Response(playHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  };
}

export function createEnv(overrides = {}) {
  return {
    DB: createD1(),
    BUCKET: createBucket(),
    ASSETS: createAssets(),
    IP_SALT: "test-salt-12345",
    LIMIT_IP_PROJECTS: "10",
    LIMIT_GLOBAL_PROJECTS: "100",
    LIMIT_GLOBAL_TEXT: "100",
    LIMIT_GLOBAL_IMAGES: "100",
    LIMIT_PROJECT_REVISES: "5",
    LIMIT_PROJECT_IMAGES: "10",
    TURNSTILE_SECRET: "test-turnstile-secret",
    ...overrides,
  };
}

export function stubTurnstile() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("challenges.cloudflare.com/turnstile")) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(url, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}
