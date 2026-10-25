import publicationWorker from "./publication-worker.js";

// Local acceptance only. Inject one controlled R2 read failure while retaining
// actual workerd/D1/R2 and the production route's quota/claim/finally behavior.
export default {
  async fetch(request, env, ctx) {
    const bucket = {
      head: (...args) => env.BUCKET.head(...args),
      put: (...args) => env.BUCKET.put(...args),
      delete: (...args) => env.BUCKET.delete(...args),
      async get(...args) {
        const object = await env.BUCKET.get(...args);
        const control = await env.BEFORE_GET.fetch("http://read-gate/control");
        if (!object || control.status !== 503) return object;
        return new Proxy(object, {
          get(target, key) {
            if (key === "text") return async () => { throw new Error("Controlled local R2 text failure"); };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    return publicationWorker.fetch(request, { ...env, BUCKET: bucket }, ctx);
  },
};
