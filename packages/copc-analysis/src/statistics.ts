import type { PointCloudNode } from "cesiumjs-copc-core";

export interface PointCloudStatisticsResult {
  readonly pointCount: number;
  readonly height: {
    readonly minimum: number;
    readonly maximum: number;
    readonly mean: number;
  };
  readonly intensity?: {
    readonly minimum: number;
    readonly maximum: number;
    readonly mean: number;
  };
  readonly classifications: Readonly<Record<number, number>>;
}

export async function computeStatistics(
  nodes: AsyncIterable<PointCloudNode> | Iterable<PointCloudNode>,
): Promise<PointCloudStatisticsResult> {
  let pointCount = 0;
  let heightMinimum = Number.POSITIVE_INFINITY;
  let heightMaximum = Number.NEGATIVE_INFINITY;
  let heightSum = 0;
  let intensityCount = 0;
  let intensityMinimum = Number.POSITIVE_INFINITY;
  let intensityMaximum = Number.NEGATIVE_INFINITY;
  let intensitySum = 0;
  const classifications: Record<number, number> = {};

  for await (const node of nodes) {
    const intensity = node.attributes.Intensity;
    const classification = node.attributes.Classification;
    for (let i = 0; i < node.pointCount; i += 1) {
      const height = node.positions[i * 3 + 2]!;
      heightMinimum = Math.min(heightMinimum, height);
      heightMaximum = Math.max(heightMaximum, height);
      heightSum += height;
      pointCount += 1;
      if (intensity) {
        const value = intensity[i]!;
        intensityMinimum = Math.min(intensityMinimum, value);
        intensityMaximum = Math.max(intensityMaximum, value);
        intensitySum += value;
        intensityCount += 1;
      }
      if (classification) {
        const value = classification[i]!;
        classifications[value] = (classifications[value] ?? 0) + 1;
      }
    }
  }

  return {
    pointCount,
    height: {
      minimum: pointCount === 0 ? Number.NaN : heightMinimum,
      maximum: pointCount === 0 ? Number.NaN : heightMaximum,
      mean: pointCount === 0 ? Number.NaN : heightSum / pointCount,
    },
    ...(intensityCount === 0
      ? {}
      : {
          intensity: {
            minimum: intensityMinimum,
            maximum: intensityMaximum,
            mean: intensitySum / intensityCount,
          },
        }),
    classifications,
  };
}
