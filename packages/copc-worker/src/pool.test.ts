import { describe, expect, it } from "vitest";
import type { CopcDecodingMetadata, PointCloudNode } from "cesiumjs-copc-core";
import { CopcDecodeWorkerPool, type WorkerLike } from "./pool.js";
import type { DecoderWorkerRequest, DecoderWorkerResponse } from "./protocol.js";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<DecoderWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: DecoderWorkerRequest[] = [];
  terminated = false;

  postMessage(message: DecoderWorkerRequest): void {
    this.requests.push(message);
    if (message.type === "initialize") {
      queueMicrotask(() => this.respond({ type: "success", id: message.id }));
    }
    if (message.type === "load") {
      const node: PointCloudNode = {
        id: message.node.id,
        pointCount: 1,
        positions: new Float64Array([1, 2, 3]),
        colors: new Uint8Array([4, 5, 6]),
        attributes: {},
      };
      queueMicrotask(() =>
        this.respond({
          type: "success",
          id: message.id,
          node,
          statistics: { decodedNodes: 1, decodeMilliseconds: 12 },
        }),
      );
    }
    if (message.type === "filter") {
      const node: PointCloudNode = {
        ...message.node,
        pointCount: 0,
        positions: new Float64Array(),
        attributes: {},
      };
      queueMicrotask(() => this.respond({ type: "success", id: message.id, node }));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  private respond(response: DecoderWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<DecoderWorkerResponse>);
  }
}

describe("CopcDecodeWorkerPool", () => {
  const metadata: CopcDecodingMetadata = {
    header: {
      pointDataRecordFormat: 7,
      pointDataRecordLength: 36,
      scale: [0.01, 0.01, 0.01],
      offset: [0, 0, 0],
    },
    extraBytes: [],
  };

  it("initializes workers and accumulates decode statistics", async () => {
    const workers: FakeWorker[] = [];
    const pool = await CopcDecodeWorkerPool.create({
      metadata,
      cartesianTransform: {
        horizontalCrs: "EPSG:4326",
        verticalUnitToMeters: 1,
        verticalOffsetMeters: 0,
      },
      workerCount: 2,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const node = await pool.decodeNode(
      {
        id: { depth: 2, x: 1, y: 2, z: 3 },
        pointCount: 1,
        bytes: new Uint8Array([1, 2, 3]),
      },
      ["Red", "Green", "Blue"],
    );
    expect(node.positions).toEqual(new Float64Array([1, 2, 3]));
    expect(pool.statistics).toEqual({ decodedNodes: 1, decodeMilliseconds: 12 });
    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.requests[0]?.type === "initialize")).toBe(true);
    expect(
      workers.every((worker) => {
        const request = worker.requests[0];
        return (
          request?.type === "initialize" &&
          request.cartesianTransform?.horizontalCrs === "EPSG:4326"
        );
      }),
    ).toBe(true);
    pool.destroy();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("forwards cancellation to the active worker", async () => {
    class WaitingWorker extends FakeWorker {
      override postMessage(message: DecoderWorkerRequest): void {
        if (message.type === "load") {
          this.requests.push(message);
          return;
        }
        super.postMessage(message);
      }
    }
    const worker = new WaitingWorker();
    const pool = await CopcDecodeWorkerPool.create({
      metadata,
      workerCount: 1,
      workerFactory: () => worker,
    });
    const controller = new AbortController();
    const request = pool.decodeNode(
      {
        id: { depth: 0, x: 0, y: 0, z: 0 },
        pointCount: 1,
        bytes: new Uint8Array([1]),
      },
      [],
      controller.signal,
    );
    controller.abort(new DOMException("obsolete", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests.some((message) => message.type === "cancel")).toBe(true);
    pool.destroy();
  });

  it("filters decoded nodes without transferring ownership of the source", async () => {
    const worker = new FakeWorker();
    const pool = await CopcDecodeWorkerPool.create({
      metadata,
      workerCount: 1,
      workerFactory: () => worker,
    });
    const source: PointCloudNode = {
      id: { depth: 0, x: 0, y: 0, z: 0 },
      pointCount: 1,
      positions: new Float64Array([1, 2, 3]),
      attributes: { Classification: new Uint8Array([2]) },
    };

    const filtered = await pool.filterNode(source, { classifications: [6] });

    expect(filtered.pointCount).toBe(0);
    expect(source.positions.byteLength).toBe(24);
    expect(worker.requests.some((message) => message.type === "filter")).toBe(true);
    pool.destroy();
  });
});
