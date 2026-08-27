import { describe, expect, it } from "vitest";
import type {
  Bounds3,
  HierarchyEntry,
  NodeId,
  PointCloudMetadata,
  PointCloudNode,
  PointCloudSource,
} from "cesiumjs-copc-core";
import { boundsIntersect, queryBounds } from "./spatial-query.js";
import { computeStatistics } from "./statistics.js";

const rootId = { depth: 0, x: 0, y: 0, z: 0 } as const;
const rootEntry: HierarchyEntry = {
  id: rootId,
  pointCount: 4,
  bounds: [0, 0, 0, 10, 10, 10],
  spacing: 1,
};
const pointNode: PointCloudNode = {
  id: rootId,
  pointCount: 4,
  positions: new Float64Array([1, 1, 1, 4, 4, 4, 8, 8, 8, 11, 2, 2]),
  colors: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  attributes: {
    Intensity: new Uint16Array([10, 20, 30, 40]),
    Classification: new Uint8Array([2, 2, 5, 6]),
  },
};

class FakeSource implements PointCloudSource {
  metadata(): Promise<PointCloudMetadata> {
    throw new Error("unused");
  }
  root(): Promise<HierarchyEntry> {
    return Promise.resolve(rootEntry);
  }
  getHierarchy(_node: NodeId): Promise<readonly HierarchyEntry[]> {
    return Promise.resolve([]);
  }
  loadNode(): Promise<PointCloudNode> {
    return Promise.resolve(pointNode);
  }
  destroy(): void {}
}

describe("spatial query", () => {
  it("tests three-dimensional box intersection", () => {
    expect(boundsIntersect([0, 0, 0, 1, 1, 1], [1, 1, 1, 2, 2, 2])).toBe(true);
    expect(boundsIntersect([0, 0, 0, 1, 1, 1], [2, 2, 2, 3, 3, 3])).toBe(false);
  });

  it("streams only points inside the query bounds and retains attributes", async () => {
    const nodes: PointCloudNode[] = [];
    for await (const node of queryBounds(new FakeSource(), [0, 0, 0, 5, 5, 5])) nodes.push(node);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.pointCount).toBe(2);
    expect(nodes[0]?.positions).toEqual(new Float64Array([1, 1, 1, 4, 4, 4]));
    expect(nodes[0]?.attributes.Classification).toEqual(new Float64Array([2, 2]));
  });

  it("computes height, intensity, and classification statistics", async () => {
    const statistics = await computeStatistics(
      queryBounds(new FakeSource(), [0, 0, 0, 10, 10, 10] as Bounds3),
    );
    expect(statistics.pointCount).toBe(3);
    expect(statistics.height).toEqual({ minimum: 1, maximum: 8, mean: 13 / 3 });
    expect(statistics.intensity).toEqual({ minimum: 10, maximum: 30, mean: 20 });
    expect(statistics.classifications).toEqual({ 2: 2, 5: 1 });
  });
});
