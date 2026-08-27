import { describe, expect, it } from "vitest";
import type { PointCloudNode } from "cesiumjs-copc-core";
import { matchesPointFilter } from "./filter.js";

const node: PointCloudNode = {
  id: { depth: 0, x: 0, y: 0, z: 0 },
  pointCount: 2,
  positions: new Float64Array([0, 0, 10, 0, 0, 20]),
  attributes: {
    Classification: new Uint8Array([2, 6]),
    Intensity: new Uint16Array([100, 1_000]),
    GpsTime: new Float64Array([50, 100]),
  },
};

describe("point filter", () => {
  it("combines classification, intensity, and elevation predicates", () => {
    const filter = {
      classifications: [2],
      intensity: [50, 200] as const,
      elevation: [5, 15] as const,
      gpsTime: [40, 60] as const,
    };
    expect(matchesPointFilter(node, 0, filter)).toBe(true);
    expect(matchesPointFilter(node, 1, filter)).toBe(false);
  });

  it("rejects a requested dimension that is unavailable", () => {
    expect(matchesPointFilter(node, 0, { classifications: [5] })).toBe(false);
  });
});
