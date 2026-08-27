import {
  matchesPointCloudNodeFilter,
  type PointCloudNode,
  type PointCloudNodeFilter,
} from "cesiumjs-copc-core";

export type CopcPointFilter = PointCloudNodeFilter;

export function matchesPointFilter(
  node: PointCloudNode,
  index: number,
  filter: CopcPointFilter | undefined,
): boolean {
  return matchesPointCloudNodeFilter(node, index, filter);
}
