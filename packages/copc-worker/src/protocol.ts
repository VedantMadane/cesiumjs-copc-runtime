import type {
  CompressedPointCloudNode,
  CopcDecodingMetadata,
  PointCloudNodeFilter,
  PointCloudNode,
} from "@copc-runtime/core";

export interface WorkerStatistics {
  readonly decodedNodes: number;
  readonly decodeMilliseconds: number;
}

export type DecoderWorkerRequest =
  | {
      readonly type: "initialize";
      readonly id: number;
      readonly metadata: CopcDecodingMetadata;
    }
  | {
      readonly type: "load";
      readonly id: number;
      readonly node: CompressedPointCloudNode;
      readonly dimensions: readonly string[];
    }
  | {
      readonly type: "filter";
      readonly id: number;
      readonly node: PointCloudNode;
      readonly filter?: PointCloudNodeFilter;
    }
  | { readonly type: "cancel"; readonly id: number }
  | { readonly type: "destroy"; readonly id: number };

export type DecoderWorkerResponse =
  | {
      readonly type: "success";
      readonly id: number;
      readonly node?: PointCloudNode;
      readonly statistics?: WorkerStatistics;
    }
  | {
      readonly type: "error";
      readonly id: number;
      readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
    };
