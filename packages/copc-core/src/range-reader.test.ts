import { describe, expect, it, vi } from "vitest";
import { HttpRangeReader } from "./range-reader.js";

describe("HttpRangeReader", () => {
  it("binds the default fetch implementation to the global object", async () => {
    const originalFetch = globalThis.fetch;
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { "Content-Range": "bytes 0-0/1" },
        }),
      );
    }) as unknown as typeof fetch;
    globalThis.fetch = receiverSensitiveFetch;
    try {
      const reader = new HttpRangeReader("https://example.test/cloud.copc.laz");
      await expect(reader.diagnose()).resolves.toMatchObject({ supportsRanges: true });
      reader.destroy();
      expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses an inclusive HTTP Range header for an exclusive input range", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: { "Content-Range": "bytes 2-4/10" },
      }),
    );
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", { fetch: fetchMock });
    await expect(reader.getter(2, 5)).resolves.toEqual(new Uint8Array([2, 3, 4]));
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("Range")).toBe("bytes=2-4");
    expect(reader.bytesReceived).toBe(3);
    expect(reader.contentLength).toBe(10);
  });

  it("rejects servers that ignore range requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array(10), { status: 200 }));
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", { fetch: fetchMock });
    await expect(reader.getter(0, 1)).rejects.toThrow("did not honor byte range");
  });

  it("reports range support and total content length", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/12345", ETag: "test" },
      }),
    );
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", { fetch: fetchMock });
    await expect(reader.diagnose()).resolves.toMatchObject({
      supportsRanges: true,
      contentLength: 12345,
      etag: "test",
    });
  });

  it("accepts a 206 response when CORS hides Content-Range", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([0]), { status: 206 }));
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", { fetch: fetchMock });
    await expect(reader.diagnose()).resolves.toEqual({
      url: "https://example.test/cloud.copc.laz",
      supportsRanges: true,
    });
  });

  it("aborts the underlying fetch with a per-request signal", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", { fetch: fetchMock });
    const controller = new AbortController();
    const request = reader.getterForSignal(controller.signal)(0, 1);
    controller.abort(new DOMException("obsolete", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("coalesces adjacent ranges and slices the merged response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const range = new Headers(init?.headers).get("Range")!;
      const [, first, last] = range.match(/bytes=(\d+)-(\d+)/)!;
      const begin = Number(first);
      const end = Number(last) + 1;
      return new Response(
        Uint8Array.from({ length: end - begin }, (_, index) => begin + index),
        {
          status: 206,
          headers: { "Content-Range": `bytes ${begin}-${end - 1}/100` },
        },
      );
    });
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", {
      fetch: fetchMock,
      mergeGapBytes: 2,
    });
    const first = reader.getter(0, 4);
    const second = reader.getter(6, 10);
    await expect(Promise.all([first, second])).resolves.toEqual([
      new Uint8Array([0, 1, 2, 3]),
      new Uint8Array([6, 7, 8, 9]),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("Range")).toBe("bytes=0-9");
    expect(reader.coalescedRequestCount).toBe(1);
  });

  it("serves a covered range from the compressed byte cache", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/10" },
      }),
    );
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", { fetch: fetchMock });
    await reader.getter(0, 4);
    await expect(reader.getter(1, 3)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reader.cacheHitCount).toBe(1);
    expect(reader.cachedBytes).toBe(4);
  });

  it("uses a persistent exact-range cache before the network", async () => {
    const persistent = {
      get: vi.fn().mockResolvedValue(new Uint8Array([7, 8])),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi.fn<typeof fetch>();
    const reader = new HttpRangeReader("https://example.test/cloud.copc.laz", {
      fetch: fetchMock,
      persistentCache: persistent,
    });
    await expect(reader.getter(10, 12)).resolves.toEqual(new Uint8Array([7, 8]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reader.persistentCacheHitCount).toBe(1);
  });
});
