import { describe, expect, it } from "vitest";
import type {
  HierarchyEntry,
  NodeId,
  PointCloudMetadata,
  PointCloudNode,
  PointCloudSource,
} from "cesiumjs-copc-core";
import { computeHeightProfile } from "./height-profile.js";

const root: HierarchyEntry = {
  id: { depth: 0, x: 0, y: 0, z: 0 },
  pointCount: 4,
  bounds: [0, -5, 0, 10, 5, 100],
  spacing: 1,
};

class ProfileSource implements PointCloudSource {
  metadata(): Promise<PointCloudMetadata> {
    return Promise.resolve({
      bounds: root.bounds,
      spacing: 1,
      pointCount: 4,
      pointDataRecordFormat: 7,
      dimensions: ["X", "Y", "Z", "Classification", "Intensity"],
    });
  }
  root(): Promise<HierarchyEntry> { return Promise.resolve(root); }
  getHierarchy(_node: NodeId): Promise<readonly HierarchyEntry[]> { return Promise.resolve([]); }
  loadNode(): Promise<PointCloudNode> {
    return Promise.resolve({
      id: root.id,
      pointCount: 4,
      positions: new Float64Array([8, 0.5, 80, 2, 0, 20, 5, 2, 50, -1, 0, 10]),
      attributes: {
        Classification: new Uint8Array([5, 2, 6, 2]),
        Intensity: new Uint16Array([800, 200, 500, 100]),
      },
    });
  }
  destroy(): void {}
}

describe("height profile", () => {
  it("filters a corridor and sorts points by distance along the line", async () => {
    const result = await computeHeightProfile(new ProfileSource(), [0, 0], [10, 0], { width: 2 });
    expect(result.pointCount).toBe(2);
    expect(result.distance).toEqual(new Float64Array([2, 8]));
    expect(result.elevation).toEqual(new Float64Array([20, 80]));
    expect(result.classification).toEqual(new Float64Array([2, 5]));
  });
});
