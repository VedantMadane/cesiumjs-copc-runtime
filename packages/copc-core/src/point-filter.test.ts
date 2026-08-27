import { describe, expect, it } from "vitest";
import { filterPointCloudNode } from "./point-filter.js";

describe("filterPointCloudNode", () => {
  it("compacts positions, colors, and attributes without changing the source", () => {
    const source = {
      id: { depth: 1, x: 0, y: 1, z: 0 },
      pointCount: 3,
      positions: new Float64Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      colors: new Uint8Array([10, 11, 12, 20, 21, 22, 30, 31, 32]),
      cartesian: {
        origin: [100, 200, 300] as const,
        positions: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      },
      attributes: {
        Classification: new Uint8Array([2, 6, 2]),
        Intensity: new Uint16Array([100, 200, 300]),
      },
    };

    const filtered = filterPointCloudNode(source, { classifications: [2] });

    expect(filtered.pointCount).toBe(2);
    expect(filtered.positions).toEqual(new Float64Array([0, 1, 2, 6, 7, 8]));
    expect(filtered.colors).toEqual(new Uint8Array([10, 11, 12, 30, 31, 32]));
    expect(filtered.cartesian?.origin).toEqual([100, 200, 300]);
    expect(filtered.cartesian?.positions).toEqual(new Float32Array([0, 1, 2, 6, 7, 8]));
    expect(filtered.attributes.Classification).toEqual(new Uint8Array([2, 2]));
    expect(filtered.attributes.Intensity).toEqual(new Uint16Array([100, 300]));
    expect(source.pointCount).toBe(3);
    expect(source.positions.byteLength).toBeGreaterThan(0);
  });
});
