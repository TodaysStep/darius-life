// A tiny in-memory R2Bucket substitute for tests — just enough of
// put/get/head/delete for Bench Notes' document and recording uploads.
// Both Workers only ever write keys shaped by
// workers/shared/bench-data.js's benchBlobKey.
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
      return { key, size: bytes.length };
    },
    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return { body: obj.bytes, httpMetadata: obj.httpMetadata, size: obj.bytes.length, arrayBuffer: async () => obj.bytes.buffer.slice(obj.bytes.byteOffset, obj.bytes.byteOffset + obj.bytes.byteLength) };
    },
    async head(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return { key, size: obj.bytes.length, httpMetadata: obj.httpMetadata };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
