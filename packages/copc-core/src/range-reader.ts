import type { Getter } from "copc";

export interface RangeReaderOptions {
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly coalesce?: boolean;
  readonly mergeGapBytes?: number;
  readonly maximumMergedBytes?: number;
  readonly batchDelayMilliseconds?: number;
  readonly compressedCacheSize?: number;
  readonly persistentCache?: PersistentRangeCache;
  readonly cacheKey?: string;
}

export interface PersistentRangeCache {
  get(key: string, begin: number, end: number): Promise<Uint8Array | undefined>;
  set(key: string, begin: number, end: number, bytes: Uint8Array): Promise<void>;
  close?(): void;
}

export interface RangeDiagnostics {
  readonly url: string;
  readonly supportsRanges: boolean;
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly etag?: string;
}

interface PendingRange {
  readonly begin: number;
  readonly end: number;
  readonly signal?: AbortSignal;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (reason?: unknown) => void;
  abortListener?: () => void;
  batch?: RangeBatch;
  settled: boolean;
}

interface RangeBatch {
  readonly begin: number;
  readonly end: number;
  readonly requests: PendingRange[];
  readonly controller: AbortController;
}

interface CachedRange {
  readonly begin: number;
  readonly end: number;
  readonly bytes: Uint8Array;
}

export class HttpRangeReader {
  readonly #url: string;
  readonly #headers: Headers;
  readonly #fetch: typeof fetch;
  readonly #signal: AbortSignal | undefined;
  readonly #coalesce: boolean;
  readonly #mergeGapBytes: number;
  readonly #maximumMergedBytes: number;
  readonly #batchDelayMilliseconds: number;
  readonly #cache: CompressedRangeCache;
  readonly #persistentCache: PersistentRangeCache | undefined;
  readonly #cacheKey: string;
  readonly #active = new Set<AbortController>();
  #pending: PendingRange[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;
  #requests = 0;
  #logicalRequests = 0;
  #cacheHits = 0;
  #persistentCacheHits = 0;
  #coalescedRequests = 0;
  #bytesReceived = 0;
  #contentLength: number | undefined;

  constructor(url: string, options: RangeReaderOptions = {}) {
    this.#url = url;
    this.#headers = new Headers(options.headers);
    // Window.fetch performs a brand check in some browsers. Calling a stored
    // reference as `this.#fetch(...)` would otherwise bind `this` to the
    // HttpRangeReader instance and throw "Illegal invocation".
    this.#fetch = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.#signal = options.signal;
    this.#coalesce = options.coalesce ?? true;
    this.#mergeGapBytes = nonNegative(options.mergeGapBytes ?? 16 * 1024, "mergeGapBytes");
    this.#maximumMergedBytes = positive(options.maximumMergedBytes ?? 4 * 1024 * 1024, "maximumMergedBytes");
    this.#batchDelayMilliseconds = nonNegative(
      options.batchDelayMilliseconds ?? 0,
      "batchDelayMilliseconds",
    );
    this.#cache = new CompressedRangeCache(
      nonNegative(options.compressedCacheSize ?? 64 * 1024 * 1024, "compressedCacheSize"),
    );
    this.#persistentCache = options.persistentCache;
    this.#cacheKey = options.cacheKey ?? url;
  }

  get requestCount(): number { return this.#requests; }
  get logicalRequestCount(): number { return this.#logicalRequests; }
  get cacheHitCount(): number { return this.#cacheHits; }
  get persistentCacheHitCount(): number { return this.#persistentCacheHits; }
  get coalescedRequestCount(): number { return this.#coalescedRequests; }
  get bytesReceived(): number { return this.#bytesReceived; }
  get cachedBytes(): number { return this.#cache.byteLength; }
  get contentLength(): number | undefined { return this.#contentLength; }

  readonly getter: Getter = (begin, end) => this.#get(begin, end);

  getterForSignal(signal: AbortSignal): Getter {
    return (begin, end) => this.#get(begin, end, signal);
  }

  async #get(begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.#assertRange(begin, end);
    signal?.throwIfAborted();
    this.#signal?.throwIfAborted();
    this.#logicalRequests += 1;
    const cached = this.#cache.get(begin, end);
    if (cached) {
      this.#cacheHits += 1;
      return cached;
    }
    const persisted = await this.#getPersisted(begin, end);
    if (persisted) {
      this.#persistentCacheHits += 1;
      this.#cache.set(begin, end, persisted);
      return persisted.slice();
    }
    signal?.throwIfAborted();
    this.#signal?.throwIfAborted();
    if (!this.#coalesce) {
      const bytes = await this.#fetchRange(begin, end, combineSignals(this.#signal, signal));
      this.#cache.set(begin, end, bytes);
      void this.#persist(begin, end, bytes);
      return bytes.slice();
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const request: PendingRange = {
        begin,
        end,
        resolve,
        reject,
        settled: false,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        request.abortListener = () => this.#abortRequest(request, signal.reason);
        signal.addEventListener("abort", request.abortListener, { once: true });
      }
      this.#pending.push(request);
      this.#scheduleFlush();
    });
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flush();
    }, this.#batchDelayMilliseconds);
  }

  #flush(): void {
    const requests = this.#pending.splice(0)
      .filter((request) => !request.settled)
      .sort((left, right) => left.begin - right.begin || left.end - right.end);
    const groups: PendingRange[][] = [];
    for (const request of requests) {
      const current = groups.at(-1);
      if (!current) {
        groups.push([request]);
        continue;
      }
      const begin = current[0]!.begin;
      const end = Math.max(...current.map((item) => item.end));
      const mergedEnd = Math.max(end, request.end);
      if (request.begin <= end + this.#mergeGapBytes && mergedEnd - begin <= this.#maximumMergedBytes) {
        current.push(request);
      } else {
        groups.push([request]);
      }
    }
    for (const group of groups) {
      const begin = group[0]!.begin;
      const end = Math.max(...group.map((request) => request.end));
      const batch: RangeBatch = { begin, end, requests: group, controller: new AbortController() };
      for (const request of group) request.batch = batch;
      if (group.length > 1) this.#coalescedRequests += group.length - 1;
      void this.#runBatch(batch);
    }
  }

  async #runBatch(batch: RangeBatch): Promise<void> {
    this.#active.add(batch.controller);
    try {
      const bytes = await this.#fetchRange(
        batch.begin,
        batch.end,
        combineSignals(this.#signal, batch.controller.signal),
      );
      this.#cache.set(batch.begin, batch.end, bytes);
      for (const request of batch.requests) {
        if (request.settled) continue;
        this.#settle(request);
        const slice = bytes.slice(request.begin - batch.begin, request.end - batch.begin);
        void this.#persist(request.begin, request.end, slice);
        request.resolve(slice);
      }
    } catch (error) {
      for (const request of batch.requests) {
        if (request.settled) continue;
        this.#settle(request);
        request.reject(error);
      }
    } finally {
      this.#active.delete(batch.controller);
    }
  }

  async #fetchRange(begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const headers = new Headers(this.#headers);
    headers.set("Range", `bytes=${begin}-${end - 1}`);
    const response = await this.#fetch(this.#url, {
      method: "GET",
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    this.#requests += 1;
    if (response.status !== 206) {
      throw new Error(`Server did not honor byte range ${begin}-${end - 1}: HTTP ${response.status}`);
    }
    const contentRange = response.headers.get("content-range");
    if (contentRange && !contentRange.startsWith(`bytes ${begin}-`)) {
      throw new Error(`Unexpected Content-Range response: ${contentRange}`);
    }
    const total = contentRange?.match(/\/(\d+)$/)?.[1];
    if (total) this.#contentLength = Number(total);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - begin) {
      throw new Error(`Expected ${end - begin} bytes, received ${bytes.byteLength}`);
    }
    this.#bytesReceived += bytes.byteLength;
    return bytes;
  }

  #abortRequest(request: PendingRange, reason: unknown): void {
    if (request.settled) return;
    this.#settle(request);
    request.reject(reason);
    const batch = request.batch;
    if (batch && batch.requests.every((item) => item.settled)) batch.controller.abort(reason);
  }

  async #getPersisted(begin: number, end: number): Promise<Uint8Array | undefined> {
    if (!this.#persistentCache) return undefined;
    try {
      const bytes = await this.#persistentCache.get(this.#cacheKey, begin, end);
      return bytes?.byteLength === end - begin ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  async #persist(begin: number, end: number, bytes: Uint8Array): Promise<void> {
    try {
      await this.#persistentCache?.set(this.#cacheKey, begin, end, bytes);
    } catch {
      // Persistent caching is an optimization and must not fail point loading.
    }
  }

  #settle(request: PendingRange): void {
    request.settled = true;
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
  }

  #assertRange(begin: number, end: number): void {
    if (this.#destroyed) throw new Error("Range reader has been destroyed");
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) {
      throw new RangeError(`Invalid byte range [${begin}, ${end})`);
    }
  }

  async diagnose(): Promise<RangeDiagnostics> {
    const headers = new Headers(this.#headers);
    headers.set("Range", "bytes=0-0");
    const response = await this.#fetch(this.#url, {
      method: "GET",
      headers,
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
    });
    const contentRange = response.headers.get("content-range");
    const total = contentRange?.match(/\/(\d+)$/)?.[1];
    const contentLength = total ? Number(total) : undefined;
    const result: RangeDiagnostics = {
      url: this.#url,
      // A 206 response is authoritative. Content-Range is not a CORS-safelisted
      // response header, so browsers may hide it even when the server honored
      // the request correctly.
      supportsRanges: response.status === 206,
    };
    const contentType = response.headers.get("content-type") ?? undefined;
    const etag = response.headers.get("etag") ?? undefined;
    await response.body?.cancel();
    return {
      ...result,
      ...(contentLength === undefined ? {} : { contentLength }),
      ...(contentType === undefined ? {} : { contentType }),
      ...(etag === undefined ? {} : { etag }),
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    const error = new DOMException("Range reader destroyed", "AbortError");
    for (const request of this.#pending.splice(0)) {
      if (!request.settled) {
        this.#settle(request);
        request.reject(error);
      }
    }
    for (const controller of this.#active) controller.abort(error);
    this.#active.clear();
    this.#cache.clear();
  }
}

class CompressedRangeCache {
  readonly #entries = new Map<string, CachedRange>();
  readonly #maximumBytes: number;
  #byteLength = 0;

  constructor(maximumBytes: number) { this.#maximumBytes = maximumBytes; }
  get byteLength(): number { return this.#byteLength; }

  get(begin: number, end: number): Uint8Array | undefined {
    let matchKey: string | undefined;
    let match: CachedRange | undefined;
    for (const [key, entry] of this.#entries) {
      if (entry.begin <= begin && entry.end >= end
        && (!match || entry.end - entry.begin < match.end - match.begin)) {
        matchKey = key;
        match = entry;
      }
    }
    if (!match || !matchKey) return undefined;
    this.#entries.delete(matchKey);
    this.#entries.set(matchKey, match);
    return match.bytes.slice(begin - match.begin, end - match.begin);
  }

  set(begin: number, end: number, bytes: Uint8Array): void {
    if (this.#maximumBytes === 0 || bytes.byteLength > this.#maximumBytes) return;
    const key = `${begin}:${end}`;
    const previous = this.#entries.get(key);
    if (previous) this.#byteLength -= previous.bytes.byteLength;
    this.#entries.delete(key);
    this.#entries.set(key, { begin, end, bytes });
    this.#byteLength += bytes.byteLength;
    while (this.#byteLength > this.#maximumBytes) {
      const oldest = this.#entries.entries().next().value as [string, CachedRange] | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#byteLength -= oldest[1].bytes.byteLength;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#byteLength = 0;
  }
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}
