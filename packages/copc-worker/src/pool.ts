import type {
  CompressedPointCloudNode,
  CopcDecodingMetadata,
  PointCloudNodeFilter,
  PointCloudNode,
} from "@copc-runtime/core";
import type { DecoderWorkerRequest, DecoderWorkerResponse, WorkerStatistics } from "./protocol.js";

export interface WorkerLike {
  onmessage: ((event: MessageEvent<DecoderWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DecoderWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export type DecoderWorkerFactory = () => WorkerLike;

export interface CopcDecodeWorkerPoolOptions {
  readonly metadata: CopcDecodingMetadata;
  readonly workerCount?: number;
  readonly workerFactory?: DecoderWorkerFactory;
}

interface PendingRequest {
  readonly resolve: (response: DecoderWorkerResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

type RpcRequest =
  | Omit<Extract<DecoderWorkerRequest, { type: "initialize" }>, "id">
  | Omit<Extract<DecoderWorkerRequest, { type: "load" }>, "id">
  | Omit<Extract<DecoderWorkerRequest, { type: "filter" }>, "id">;

class WorkerClient {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #destroyed = false;
  active = 0;

  constructor(factory: DecoderWorkerFactory) {
    this.#worker = factory();
    this.#worker.onmessage = (event) => this.#handleMessage(event.data);
    this.#worker.onerror = (event) => {
      this.#rejectAll(new Error(event.message || "COPC decoder worker failed"));
    };
  }

  async initialize(metadata: CopcDecodingMetadata): Promise<void> {
    await this.#request({ type: "initialize", metadata });
  }

  async decodeNode(
    node: CompressedPointCloudNode,
    dimensions: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ node: PointCloudNode; statistics: WorkerStatistics }> {
    this.active += 1;
    try {
      const response = await this.#request({ type: "load", node, dimensions }, signal);
      if (response.type !== "success" || !response.node) {
        throw new Error("Decoder worker returned an empty point node");
      }
      return {
        node: response.node,
        statistics: response.statistics ?? { decodedNodes: 0, decodeMilliseconds: 0 },
      };
    } finally {
      this.active -= 1;
    }
  }

  async filterNode(
    node: PointCloudNode,
    filter: PointCloudNodeFilter | undefined,
    signal?: AbortSignal,
  ): Promise<PointCloudNode> {
    this.active += 1;
    try {
      const response = await this.#request({
        type: "filter",
        node,
        ...(filter === undefined ? {} : { filter }),
      }, signal);
      if (response.type !== "success" || !response.node) {
        throw new Error("Decoder worker returned an empty filtered node");
      }
      return response.node;
    } finally {
      this.active -= 1;
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const id = this.#nextId++;
    this.#worker.postMessage({ type: "destroy", id });
    this.#worker.terminate();
    this.#rejectAll(new DOMException("Decoder worker pool destroyed", "AbortError"));
  }

  #request(
    request: RpcRequest,
    signal?: AbortSignal,
  ): Promise<DecoderWorkerResponse> {
    if (this.#destroyed) return Promise.reject(new Error("Decoder worker has been destroyed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const abortSignal = signal;
      const abort = abortSignal ? () => {
        this.#pending.delete(id);
        this.#worker.postMessage({ type: "cancel", id });
        reject(abortSignal.reason);
      } : undefined;
      if (abort && abortSignal) abortSignal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(abort === undefined ? {} : { abort }),
      });
      const message = { ...request, id } as DecoderWorkerRequest;
      const transfer = message.type === "load" && message.node.bytes.buffer instanceof ArrayBuffer
        ? [message.node.bytes.buffer]
        : undefined;
      this.#worker.postMessage(message, transfer);
    });
  }

  #handleMessage(response: DecoderWorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    if (response.type === "error") {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      if (response.error.stack) error.stack = response.error.stack;
      pending.reject(error);
    } else {
      pending.resolve(response);
    }
  }

  #rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export class CopcDecodeWorkerPool {
  readonly #workers: WorkerClient[];
  #decodedNodes = 0;
  #decodeMilliseconds = 0;
  #destroyed = false;

  private constructor(workers: WorkerClient[]) {
    this.#workers = workers;
  }

  static async create(options: CopcDecodeWorkerPoolOptions): Promise<CopcDecodeWorkerPool> {
    const count = options.workerCount ?? defaultWorkerCount();
    if (!Number.isInteger(count) || count < 1) throw new RangeError("workerCount must be positive");
    const factory = options.workerFactory ?? defaultWorkerFactory;
    const workers = Array.from({ length: count }, () => new WorkerClient(factory));
    const pool = new CopcDecodeWorkerPool(workers);
    try {
      await Promise.all(workers.map((worker) => worker.initialize(options.metadata)));
      return pool;
    } catch (error) {
      pool.destroy();
      throw error;
    }
  }

  async decodeNode(
    node: CompressedPointCloudNode,
    dimensions: readonly string[],
    signal?: AbortSignal,
  ): Promise<PointCloudNode> {
    if (this.#destroyed) throw new Error("Decoder worker pool has been destroyed");
    const worker = this.#workers.reduce((best, candidate) =>
      candidate.active < best.active ? candidate : best);
    const result = await worker.decodeNode(node, dimensions, signal);
    this.#decodedNodes += result.statistics.decodedNodes;
    this.#decodeMilliseconds += result.statistics.decodeMilliseconds;
    return result.node;
  }

  async filterNode(
    node: PointCloudNode,
    filter: PointCloudNodeFilter | undefined,
    signal?: AbortSignal,
  ): Promise<PointCloudNode> {
    if (this.#destroyed) throw new Error("Decoder worker pool has been destroyed");
    const worker = this.#workers.reduce((best, candidate) =>
      candidate.active < best.active ? candidate : best);
    return worker.filterNode(node, filter, signal);
  }

  get statistics(): WorkerStatistics {
    return { decodedNodes: this.#decodedNodes, decodeMilliseconds: this.#decodeMilliseconds };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const worker of this.#workers) worker.destroy();
  }
}

function defaultWorkerFactory(): WorkerLike {
  if (typeof Worker === "undefined") throw new Error("Web Workers are not available in this environment");
  return new Worker(new URL("./decoder-worker.js", import.meta.url), { type: "module" });
}

function defaultWorkerCount(): number {
  const cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(4, cores - 1));
}
