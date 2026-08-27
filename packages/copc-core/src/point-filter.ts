import type { PointAttributeArray, PointCloudNode } from "./types.js";

export interface PointCloudNodeFilter {
  readonly classifications?: readonly number[];
  readonly intensity?: readonly [minimum: number, maximum: number];
  readonly elevation?: readonly [minimum: number, maximum: number];
  readonly gpsTime?: readonly [minimum: number, maximum: number];
}

export function matchesPointCloudNodeFilter(
  node: PointCloudNode,
  index: number,
  filter: PointCloudNodeFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.classifications) {
    const classification = node.attributes.Classification?.[index];
    if (classification === undefined || !filter.classifications.includes(classification))
      return false;
  }
  if (filter.intensity) {
    const intensity = node.attributes.Intensity?.[index];
    if (
      intensity === undefined ||
      intensity < filter.intensity[0] ||
      intensity > filter.intensity[1]
    ) {
      return false;
    }
  }
  if (filter.elevation) {
    const elevation = node.positions[index * 3 + 2];
    if (
      elevation === undefined ||
      elevation < filter.elevation[0] ||
      elevation > filter.elevation[1]
    ) {
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

/** Creates a compact node containing only points accepted by the filter. */
export function filterPointCloudNode(
  node: PointCloudNode,
  filter: PointCloudNodeFilter | undefined,
): PointCloudNode {
  if (!filter) return node;
  const indices: number[] = [];
  for (let i = 0; i < node.pointCount; i += 1) {
    if (matchesPointCloudNodeFilter(node, i, filter)) indices.push(i);
  }

  const positions = new Float64Array(indices.length * 3);
  const colors = node.colors ? new Uint8Array(indices.length * 3) : undefined;
  const cartesianPositions = node.cartesian ? new Float32Array(indices.length * 3) : undefined;
  for (let target = 0; target < indices.length; target += 1) {
    const source = indices[target]!;
    positions[target * 3] = node.positions[source * 3]!;
    positions[target * 3 + 1] = node.positions[source * 3 + 1]!;
    positions[target * 3 + 2] = node.positions[source * 3 + 2]!;
    if (colors && node.colors) {
      colors[target * 3] = node.colors[source * 3]!;
      colors[target * 3 + 1] = node.colors[source * 3 + 1]!;
      colors[target * 3 + 2] = node.colors[source * 3 + 2]!;
    }
    if (cartesianPositions && node.cartesian) {
      cartesianPositions[target * 3] = node.cartesian.positions[source * 3]!;
      cartesianPositions[target * 3 + 1] = node.cartesian.positions[source * 3 + 1]!;
      cartesianPositions[target * 3 + 2] = node.cartesian.positions[source * 3 + 2]!;
    }
  }

  const attributes: Record<string, PointAttributeArray> = {};
  for (const [name, source] of Object.entries(node.attributes)) {
    const Target = source.constructor as new (length: number) => PointAttributeArray;
    const target = new Target(indices.length);
    for (let i = 0; i < indices.length; i += 1) target[i] = source[indices[i]!]!;
    attributes[name] = target;
  }

  return {
    id: node.id,
    pointCount: indices.length,
    positions,
    ...(colors === undefined ? {} : { colors }),
    ...(cartesianPositions === undefined || node.cartesian === undefined
      ? {}
      : {
          cartesian: { origin: node.cartesian.origin, positions: cartesianPositions },
        }),
    attributes,
  };
}
