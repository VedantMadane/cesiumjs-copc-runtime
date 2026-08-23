import { describe, expect, it } from "vitest";
import { ancestorNodeId, boundsForNode, childNodeIds, formatNodeId, parseNodeId } from "./node-id.js";

describe("COPC node identifiers", () => {
  it("round trips a hierarchy key", () => {
    expect(formatNodeId(parseNodeId("3-4-2-7"))).toBe("3-4-2-7");
  });

  it("creates all octree children", () => {
    const ids = childNodeIds({ depth: 1, x: 1, y: 0, z: 1 });
    expect(ids).toHaveLength(8);
    expect(ids).toContainEqual({ depth: 2, x: 3, y: 1, z: 3 });
  });

  it("computes child bounds from the root cube", () => {
    expect(boundsForNode([0, 0, 0, 8, 8, 8], { depth: 1, x: 1, y: 0, z: 1 }))
      .toEqual([4, 0, 4, 8, 4, 8]);
  });

  it("finds an ancestor without string manipulation", () => {
    expect(ancestorNodeId({ depth: 4, x: 11, y: 6, z: 15 }, 2))
      .toEqual({ depth: 2, x: 2, y: 1, z: 3 });
  });
});
