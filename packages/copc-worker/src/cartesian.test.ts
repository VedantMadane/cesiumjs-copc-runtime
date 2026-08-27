import type { PointCloudNode } from "cesiumjs-copc-core";
import { describe, expect, it } from "vitest";
import { createCartesianPositions } from "./cartesian.js";

describe("worker Cartesian positions", () => {
  it("packs ECEF positions relative to a node origin", () => {
    const node: PointCloudNode = {
      id: { depth: 0, x: 0, y: 0, z: 0 },
      pointCount: 2,
      positions: new Float64Array([127, 37, 100, 127.00001, 37.00001, 101]),
      attributes: {},
    };
    const result = createCartesianPositions(node, {
      horizontalCrs: "EPSG:4326",
      verticalUnitToMeters: 1,
      verticalOffsetMeters: 0,
    });
    expect(result.positions).toHaveLength(6);
    expect(Math.hypot(...result.origin)).toBeGreaterThan(6_000_000);
    expect(Math.max(...Array.from(result.positions, Math.abs))).toBeLessThan(2);
  });

  it("handles empty nodes without infinities", () => {
    const node: PointCloudNode = {
      id: { depth: 0, x: 0, y: 0, z: 0 },
      pointCount: 0,
      positions: new Float64Array(),
      attributes: {},
    };
    expect(createCartesianPositions(node, {
      horizontalCrs: "EPSG:4326",
      verticalUnitToMeters: 1,
      verticalOffsetMeters: 0,
    }).origin).toEqual([0, 0, 0]);
  });
});
