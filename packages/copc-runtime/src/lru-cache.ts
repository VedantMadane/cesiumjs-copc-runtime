export interface CacheValue {
  readonly byteLength: number;
}

export class LruCache<K, V extends CacheValue> {
  readonly #values = new Map<K, V>();
  #maximumBytes: number;
  #byteLength = 0;

  constructor(maximumBytes: number) {
    if (!Number.isFinite(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("maximumBytes must be a non-negative finite number");
    }
    this.#maximumBytes = maximumBytes;
  }

  get byteLength(): number { return this.#byteLength; }
  get size(): number { return this.#values.size; }

  has(key: K): boolean { return this.#values.has(key); }

  get(key: K): V | undefined {
    const value = this.#values.get(key);
    if (value === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value);
    return value;
  }

  set(key: K, value: V): readonly [K, V][] {
    const previous = this.#values.get(key);
    if (previous) this.#byteLength -= previous.byteLength;
    this.#values.delete(key);
    this.#values.set(key, value);
    this.#byteLength += value.byteLength;
    return this.#evict();
  }

  delete(key: K): boolean {
    const value = this.#values.get(key);
    if (!value) return false;
    this.#byteLength -= value.byteLength;
    return this.#values.delete(key);
  }

  clear(): void {
    this.#values.clear();
    this.#byteLength = 0;
  }

  resize(maximumBytes: number): readonly [K, V][] {
    if (!Number.isFinite(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("maximumBytes must be a non-negative finite number");
    }
    this.#maximumBytes = maximumBytes;
    return this.#evict();
  }

  #evict(): Array<[K, V]> {
    const evicted: Array<[K, V]> = [];
    // Keep one oversized newest value to avoid an endless load/evict/reload loop.
    while (this.#byteLength > this.#maximumBytes && this.#values.size > 1) {
      const oldest = this.#values.entries().next().value as [K, V] | undefined;
      if (!oldest) break;
      this.#values.delete(oldest[0]);
      this.#byteLength -= oldest[1].byteLength;
      evicted.push(oldest);
    }
    return evicted;
  }
}
