import { describe, expect, it } from "vitest";
import { LruCache } from "./lru-cache.js";

describe("LruCache", () => {
  it("evicts least recently used entries by byte size", () => {
    const cache = new LruCache<string, { byteLength: number }>(10);
    cache.set("a", { byteLength: 4 });
    cache.set("b", { byteLength: 4 });
    cache.get("a");
    const evicted = cache.set("c", { byteLength: 4 });
    expect(evicted.map(([key]) => key)).toEqual(["b"]);
    expect(cache.has("a")).toBe(true);
    expect(cache.byteLength).toBe(8);
  });

  it("retains a single oversized value as a soft-budget exception", () => {
    const cache = new LruCache<string, { byteLength: number }>(10);
    expect(cache.set("large", { byteLength: 20 })).toEqual([]);
    expect(cache.has("large")).toBe(true);
    expect(cache.set("small", { byteLength: 4 }).map(([key]) => key)).toEqual(["large"]);
  });
});
