/// <reference lib="webworker" />

import {
  decodeCompressedPointNode,
  filterPointCloudNode,
  type CopcDecodingMetadata,
  type CartesianTransformDefinition,
  type PointCloudNode,
} from "@copc-runtime/core";
import { createCartesianPositions } from "./cartesian.js";
import type { DecoderWorkerRequest, DecoderWorkerResponse } from "./protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const controllers = new Map<number, AbortController>();
let metadata: CopcDecodingMetadata | undefined;
let cartesianTransform: CartesianTransformDefinition | undefined;

scope.onmessage = (event: MessageEvent<DecoderWorkerRequest>) => {
  void handle(event.data);
};

async function handle(request: DecoderWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case "initialize":
        metadata = request.metadata;
        cartesianTransform = request.cartesianTransform;
        respond({ type: "success", id: request.id });
        return;
      case "load": {
        if (!metadata) throw new Error("Decoder worker has not been initialized");
        const controller = new AbortController();
        controllers.set(request.id, controller);
        const started = performance.now();
        try {
          const decoded = await decodeCompressedPointNode(
            metadata,
            request.node,
            request.dimensions,
            controller.signal,
          );
          const node = cartesianTransform === undefined ? decoded : {
            ...decoded,
            cartesian: createCartesianPositions(decoded, cartesianTransform),
          };
          respond({
            type: "success",
            id: request.id,
            node,
            statistics: {
              decodedNodes: 1,
              decodeMilliseconds: performance.now() - started,
            },
          }, transferables(node));
        } finally {
          controllers.delete(request.id);
        }
        return;
      }
      case "filter": {
        const node = filterPointCloudNode(request.node, request.filter);
        respond({ type: "success", id: request.id, node }, transferables(node));
        return;
      }
      case "cancel":
        controllers.get(request.id)?.abort(new DOMException("Node decode cancelled", "AbortError"));
        return;
      case "destroy":
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        metadata = undefined;
        cartesianTransform = undefined;
        scope.close();
        return;
    }
  } catch (error) {
    respond({ type: "error", id: request.id, error: serializeError(error) });
  }
}

function respond(response: DecoderWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer);
}

function transferables(node: PointCloudNode): Transferable[] {
  const buffers = [
    node.positions.buffer,
    ...(node.colors ? [node.colors.buffer] : []),
    ...Object.values(node.attributes).map((attribute) => attribute.buffer),
    ...(node.cartesian ? [node.cartesian.positions.buffer] : []),
  ];
  return buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
