import worker from "../../src/worker.js";

export default {
  fetch(request, env, ctx) {
    // Gate the real workerd upload; the Node-side R2 proxy is a separate object.
    const bucket = {
      get: (...args) => env.BUCKET.get(...args),
      head: (...args) => env.BUCKET.head(...args),
      delete: (...args) => env.BUCKET.delete(...args),
      async put(key, ...args) {
        await env.BEFORE_PUT.fetch(`http://put-gate/${encodeURIComponent(key)}`);
        return env.BUCKET.put(key, ...args);
      },
    };
    return worker.fetch(request, { ...env, BUCKET: bucket }, ctx);
  },
};
