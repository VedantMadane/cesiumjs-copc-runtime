import type { PointCloudSource } from "cesiumjs-copc-core";
import { queryBounds, type SpatialQueryOptions } from "./spatial-query.js";

export type Point2 = readonly [x: number, y: number];

export interface HeightProfileOptions extends Omit<SpatialQueryOptions, "pointLimit"> {
  readonly width: number;
  readonly pointLimit?: number;
}

export interface HeightProfileResult {
  readonly pointCount: number;
  readonly distance: Float64Array;
  readonly elevation: Float64Array;
  /** XYZ positions interleaved in the source COPC CRS. */
  readonly positions: Float64Array;
  readonly classification?: Float64Array;
  readonly intensity?: Float64Array;
}

/** Queries points inside a source-CRS corridor and sorts them along its centerline. */
export async function computeHeightProfile(
  source: PointCloudSource,
  start: Point2,
  end: Point2,
  options: HeightProfileOptions,
): Promise<HeightProfileResult> {
  if (!Number.isFinite(options.width) || options.width <= 0) {
    throw new RangeError("Height profile width must be positive");
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) throw new RangeError("Height profile line must have non-zero length");
  const length = Math.sqrt(lengthSquared);
  const halfWidth = options.width / 2;
  const metadata = await source.metadata();
  const bounds = [
    Math.min(start[0], end[0]) - halfWidth,
    Math.min(start[1], end[1]) - halfWidth,
    metadata.bounds[2],
    Math.max(start[0], end[0]) + halfWidth,
    Math.max(start[1], end[1]) + halfWidth,
    metadata.bounds[5],
  ] as const;
  const dimensions = Array.from(new Set([
    ...(options.dimensions ?? []),
    "Classification",
    "Intensity",
  ]));
  const matches: Array<{
    distance: number;
    x: number;
    y: number;
    z: number;
    classification?: number;
    intensity?: number;
  }> = [];
  const pointLimit = options.pointLimit ?? Number.POSITIVE_INFINITY;
  const query = queryBounds(source, bounds, {
    dimensions,
    ...(options.maximumDepth === undefined ? {} : { maximumDepth: options.maximumDepth }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  outer: for await (const node of query) {
    for (let i = 0; i < node.pointCount; i += 1) {
      const x = node.positions[i * 3]!;
      const y = node.positions[i * 3 + 1]!;
      const projection = ((x - start[0]) * dx + (y - start[1]) * dy) / lengthSquared;
      if (projection < 0 || projection > 1) continue;
      const nearestX = start[0] + projection * dx;
      const nearestY = start[1] + projection * dy;
      if (Math.hypot(x - nearestX, y - nearestY) > halfWidth) continue;
      matches.push({
        distance: projection * length,
        x,
        y,
        z: node.positions[i * 3 + 2]!,
        ...(node.attributes.Classification ? { classification: node.attributes.Classification[i]! } : {}),
        ...(node.attributes.Intensity ? { intensity: node.attributes.Intensity[i]! } : {}),
      });
      if (matches.length >= pointLimit) break outer;
    }
  }
  matches.sort((left, right) => left.distance - right.distance);
  const distance = new Float64Array(matches.length);
  const elevation = new Float64Array(matches.length);
  const positions = new Float64Array(matches.length * 3);
  const hasClassification = matches.some((point) => point.classification !== undefined);
  const hasIntensity = matches.some((point) => point.intensity !== undefined);
  const classification = hasClassification ? new Float64Array(matches.length) : undefined;
  const intensity = hasIntensity ? new Float64Array(matches.length) : undefined;
  for (let i = 0; i < matches.length; i += 1) {
    const point = matches[i]!;
    distance[i] = point.distance;
    elevation[i] = point.z;
    positions[i * 3] = point.x;
    positions[i * 3 + 1] = point.y;
    positions[i * 3 + 2] = point.z;
    if (classification) classification[i] = point.classification ?? Number.NaN;
    if (intensity) intensity[i] = point.intensity ?? Number.NaN;
  }
  return {
    pointCount: matches.length,
    distance,
    elevation,
    positions,
    ...(classification === undefined ? {} : { classification }),
    ...(intensity === undefined ? {} : { intensity }),
  };
}
