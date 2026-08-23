import type { PointCloudNode } from "@copc-runtime/core";

export interface CopcPointFilter {
  readonly classifications?: readonly number[];
  readonly intensity?: readonly [minimum: number, maximum: number];
  readonly elevation?: readonly [minimum: number, maximum: number];
  readonly gpsTime?: readonly [minimum: number, maximum: number];
}

export function matchesPointFilter(
  node: PointCloudNode,
  index: number,
  filter: CopcPointFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.classifications) {
    const classification = node.attributes.Classification?.[index];
    if (classification === undefined || !filter.classifications.includes(classification)) return false;
  }
  if (filter.intensity) {
    const intensity = node.attributes.Intensity?.[index];
    if (intensity === undefined || intensity < filter.intensity[0] || intensity > filter.intensity[1]) {
      return false;
    }
  }
  if (filter.elevation) {
    const elevation = node.positions[index * 3 + 2];
    if (elevation === undefined || elevation < filter.elevation[0] || elevation > filter.elevation[1]) {
      return false;
    }
  }
  if (filter.gpsTime) {
    const gpsTime = node.attributes.GpsTime?.[index];
    if (gpsTime === undefined || gpsTime < filter.gpsTime[0] || gpsTime > filter.gpsTime[1]) {
      return false;
    }
  }
  return true;
}
