import type { PersistentRangeCache } from "./range-reader.js";

export interface IndexedDbRangeCacheOptions {
  readonly databaseName?: string;
  readonly maximumBytes?: number;
}

interface StoredRange {
  readonly key: string;
  readonly bytes: ArrayBuffer;
  readonly byteLength: number;
  readonly lastAccess: number;
}

const STORE_NAME = "ranges";

/** Persistent exact-range cache for repeat visits in browser environments. */
export class IndexedDbRangeCache implements PersistentRangeCache {
  readonly #database: Promise<IDBDatabase>;
  readonly #maximumBytes: number;
  #closed = false;

  constructor(options: IndexedDbRangeCacheOptions = {}) {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available");
    this.#maximumBytes = options.maximumBytes ?? 512 * 1024 * 1024;
    if (!Number.isFinite(this.#maximumBytes) || this.#maximumBytes < 0) {
      throw new RangeError("IndexedDB cache maximumBytes must be non-negative");
    }
    this.#database = openDatabase(options.databaseName ?? "copc-runtime-range-cache");
  }

  static get supported(): boolean { return typeof indexedDB !== "undefined"; }

  async get(key: string, begin: number, end: number): Promise<Uint8Array | undefined> {
    this.#assertOpen();
    const database = await this.#database;
    const cacheKey = makeKey(key, begin, end);
    const read = database.transaction(STORE_NAME, "readonly");
    const entry = await requestResult<StoredRange | undefined>(read.objectStore(STORE_NAME).get(cacheKey));
    if (!entry) return undefined;
    const touch = database.transaction(STORE_NAME, "readwrite");
    touch.objectStore(STORE_NAME).put({ ...entry, lastAccess: Date.now() });
    await transactionDone(touch);
    return new Uint8Array(entry.bytes.slice(0));
  }

  async set(key: string, begin: number, end: number, bytes: Uint8Array): Promise<void> {
    this.#assertOpen();
    if (this.#maximumBytes === 0 || bytes.byteLength > this.#maximumBytes) return;
    const database = await this.#database;
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: makeKey(key, begin, end),
      bytes: bytes.slice().buffer,
      byteLength: bytes.byteLength,
      lastAccess: Date.now(),
    } satisfies StoredRange);
    await transactionDone(transaction);
    await this.#evict(database);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#database.then((database) => database.close());
  }

  async #evict(database: IDBDatabase): Promise<void> {
    const read = database.transaction(STORE_NAME, "readonly");
    const entries = await requestResult<StoredRange[]>(read.objectStore(STORE_NAME).getAll());
    await transactionDone(read);
    let bytes = entries.reduce((total, entry) => total + entry.byteLength, 0);
    if (bytes <= this.#maximumBytes) return;
    entries.sort((left, right) => left.lastAccess - right.lastAccess);
    const write = database.transaction(STORE_NAME, "readwrite");
    const store = write.objectStore(STORE_NAME);
    for (const entry of entries) {
      if (bytes <= this.#maximumBytes) break;
      store.delete(entry.key);
      bytes -= entry.byteLength;
    }
    await transactionDone(write);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("IndexedDB range cache is closed");
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function makeKey(key: string, begin: number, end: number): string {
  return `${key}\u0000${begin}:${end}`;
}
