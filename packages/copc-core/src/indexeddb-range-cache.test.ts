import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRangeCache } from "./indexeddb-range-cache.js";

describe("IndexedDbRangeCache", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", fakeIndexedDb);
  });

  it("persists exact URL and byte-range keys", async () => {
    const cache = new IndexedDbRangeCache({
      databaseName: `copc-test-${crypto.randomUUID()}`,
      maximumBytes: 16,
    });
    await cache.set("dataset-v1", 10, 14, new Uint8Array([1, 2, 3, 4]));
    await expect(cache.get("dataset-v1", 10, 14)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(cache.get("dataset-v2", 10, 14)).resolves.toBeUndefined();
    cache.close();
  });

  it("evicts least recently used ranges to enforce its byte budget", async () => {
    const cache = new IndexedDbRangeCache({
      databaseName: `copc-test-${crypto.randomUUID()}`,
      maximumBytes: 4,
    });
    await cache.set("dataset", 0, 4, new Uint8Array([0, 1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.set("dataset", 4, 8, new Uint8Array([4, 5, 6, 7]));
    await expect(cache.get("dataset", 0, 4)).resolves.toBeUndefined();
    await expect(cache.get("dataset", 4, 8)).resolves.toEqual(new Uint8Array([4, 5, 6, 7]));
    cache.close();
  });
});
