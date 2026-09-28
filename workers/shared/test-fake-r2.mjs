// A tiny in-memory R2Bucket substitute for tests — just enough of put/get
// for Bench Notes' document uploads. Both Workers only ever write keys
// shaped by workers/shared/bench-data.js's documentObjectKey, and only ever
// call put(key, stream-or-bytes, { httpMetadata }) and get(key).
export function createFakeR2() {
  const objects = new Map();

  async function toBuffer(value) {
    if (value && typeof value.getReader === "function") {
      const reader = value.getReader();
      const chunks = [];
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    }
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (typeof value === "string") return Buffer.from(value);
    if (typeof value?.arrayBuffer === "function") return Buffer.from(await value.arrayBuffer());
    return Buffer.from(value);
  }

  return {
    objects,
    async put(key, value, options = {}) {
      const bytes = await toBuffer(value);
      objects.set(key, { bytes, httpMetadata: options.httpMetadata || {} });
      return { key };
    },
    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return { body: obj.bytes, httpMetadata: obj.httpMetadata };
    },
  };
}
