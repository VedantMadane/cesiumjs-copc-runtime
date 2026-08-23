export interface RequestOptions {
  readonly priority?: number;
  readonly signal?: AbortSignal;
  /** Stable identifier used to update the priority of pending work. */
  readonly key?: string;
}

interface Pending<T> {
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly controller: AbortController;
  priority: number;
  readonly key?: string;
  readonly order: number;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export class RequestQueue {
  readonly #concurrency: number;
  #pending: Pending<unknown>[] = [];
  readonly #activeControllers = new Set<AbortController>();
  #active = 0;
  #order = 0;
  #destroyed = false;

  constructor(concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    this.#concurrency = concurrency;
  }

  get activeCount(): number { return this.#active; }
  get pendingCount(): number { return this.#pending.length; }

  add<T>(run: (signal: AbortSignal) => Promise<T>, options: RequestOptions = {}): Promise<T> {
    if (this.#destroyed) return Promise.reject(new Error("Request queue has been destroyed"));
    const controller = new AbortController();
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({
        run,
        controller,
        priority: options.priority ?? 0,
        ...(options.key === undefined ? {} : { key: options.key }),
        order: this.#order++,
        resolve,
        reject,
      } as Pending<unknown>);
      this.#pending.sort((a, b) => b.priority - a.priority || a.order - b.order);
      this.#drain();
    });
  }

  /** Updates queued work without interrupting work that has already started. */
  reprioritize(key: string, priority: number): boolean {
    const pending = this.#pending.find((request) => request.key === key);
    if (!pending) return false;
    pending.priority = priority;
    this.#pending.sort((a, b) => b.priority - a.priority || a.order - b.order);
    return true;
  }

  clear(reason: unknown = new DOMException("Request cancelled", "AbortError")): void {
    for (const request of this.#pending.splice(0)) {
      request.controller.abort(reason);
      request.reject(reason);
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.clear(new DOMException("Request queue destroyed", "AbortError"));
    for (const controller of this.#activeControllers) {
      controller.abort(new DOMException("Request queue destroyed", "AbortError"));
    }
  }

  #drain(): void {
    while (this.#active < this.#concurrency && this.#pending.length > 0) {
      const request = this.#pending.shift()!;
      if (request.controller.signal.aborted) {
        request.reject(request.controller.signal.reason);
        continue;
      }
      this.#active += 1;
      this.#activeControllers.add(request.controller);
      void request.run(request.controller.signal).then(request.resolve, request.reject).finally(() => {
        this.#active -= 1;
        this.#activeControllers.delete(request.controller);
        this.#drain();
      });
    }
  }
}
