import { describe, expect, it } from "vitest";
import {
  ancestorNodeId,
  boundsForNode,
  childNodeIds,
  formatNodeId,
  type HierarchyEntry,
  type NodeId,
} from "@copc-runtime/core";
import { resolveReadyLod, screenSpaceError, selectLod, type ViewState } from "./lod.js";

const rootBounds = [0, 0, 0, 8, 8, 8] as const;
const entry = (id: NodeId, pointCount = 100): HierarchyEntry => ({
  id,
  pointCount,
  bounds: boundsForNode(rootBounds, id),
  spacing: 8 / 2 ** id.depth,
});
const root = entry({ depth: 0, x: 0, y: 0, z: 0 });
const children = childNodeIds(root.id).map((id) => entry(id));
const view: ViewState = {
  viewportHeight: 1000,
  verticalFieldOfView: Math.PI / 2,
  isVisible: () => true,
  distanceTo: () => 100,
};

describe("LOD selection", () => {
  it("computes projected point spacing", () => {
    expect(screenSpaceError(root, view)).toBeCloseTo(40);
  });

  it("requests hierarchy for a visible leaf above the threshold", () => {
    const result = selectLod(root, () => undefined, view, {
      maximumScreenSpaceError: 2,
      pointBudget: 1_000,
    });
    expect(result.selected.map((node) => formatNodeId(node.id))).toEqual(["0-0-0-0"]);
    expect(result.refinementRequested).toEqual([root]);
  });

  it("keeps the parent when all visible children do not fit the point budget", () => {
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : [],
      view,
      { maximumScreenSpaceError: 2, pointBudget: 350 },
    );
    expect(result.selected).toEqual([root]);
    expect(result.pointCount).toBe(100);
  });

  it("replaces a parent with the complete visible child frontier when budget allows", () => {
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : [],
      view,
      { maximumScreenSpaceError: 2, pointBudget: 900 },
    );
    expect(result.selected).toHaveLength(8);
    expect(result.pointCount).toBe(800);
  });

  it("does not spend the point budget on a visually small refinement patch", () => {
    const grandchildrenByParent = new Map(children.map((child) => [
      formatNodeId(child.id),
      childNodeIds(child.id).map((id) => entry(id)),
    ]));
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : (grandchildrenByParent.get(formatNodeId(id)) ?? []),
      { ...view, screenWeight: () => 1 },
      { maximumScreenSpaceError: 2, pointBudget: 2_200, minimumRefinementCoverage: 0.4 },
    );
    expect(result.selected).toHaveLength(8);
    expect(result.selected.every((node) => node.id.depth === 1)).toBe(true);
  });

  it("allows a broad refinement cohort and stops it from racing deeper", () => {
    const grandchildrenByParent = new Map(children.map((child) => [
      formatNodeId(child.id),
      childNodeIds(child.id).map((id) => entry(id)),
    ]));
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : (grandchildrenByParent.get(formatNodeId(id)) ?? []),
      { ...view, screenWeight: () => 1 },
      { maximumScreenSpaceError: 2, pointBudget: 3_600, minimumRefinementCoverage: 0.4 },
    );
    expect(result.selected).toHaveLength(36);
    expect(result.selected.filter((node) => node.id.depth === 2)).toHaveLength(32);
    expect(result.pointCount).toBe(3_600);
  });

  it("keeps a ready parent until all requested sibling branches are ready", () => {
    const ready = new Set([formatNodeId(root.id), formatNodeId(children[0]!.id)]);
    const visible = resolveReadyLod(
      root.id,
      children.map((child) => child.id),
      (node) => ready.has(formatNodeId(node)),
    );
    expect(visible.map(formatNodeId)).toEqual([formatNodeId(root.id)]);
  });

  it("switches the complete sibling group together", () => {
    const ready = new Set([formatNodeId(root.id), ...children.map((child) => formatNodeId(child.id))]);
    const visible = resolveReadyLod(
      root.id,
      children.map((child) => child.id),
      (node) => ready.has(formatNodeId(node)),
    );
    expect(visible.map(formatNodeId)).toEqual(children.map((child) => formatNodeId(child.id)));
  });

  it("refines one ready child subtree without forcing its siblings to refine", () => {
    const firstChild = children[0]!;
    const grandchildren = childNodeIds(firstChild.id);
    const selected = [...grandchildren, ...children.slice(1).map((child) => child.id)];
    const ready = new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
      ...grandchildren.map(formatNodeId),
    ]);
    const visible = resolveReadyLod(root.id, selected, (node) => ready.has(formatNodeId(node)));
    expect(visible.map(formatNodeId)).toEqual([
      ...grandchildren.map(formatNodeId),
      ...children.slice(1).map((child) => formatNodeId(child.id)),
    ]);
  });

  it("holds small refined patches until enough sibling screen coverage is ready", () => {
    const grandchildren = children.flatMap((child) => childNodeIds(child.id));
    const refinedParents = new Set(children.slice(0, 2).map((child) => formatNodeId(child.id)));
    const ready = new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
      ...grandchildren
        .filter((node) => refinedParents.has(formatNodeId(ancestorNodeId(node, 1))))
        .map(formatNodeId),
    ]);
    const visible = resolveReadyLod(
      root.id,
      grandchildren,
      (node) => ready.has(formatNodeId(node)),
      { minimumRefinementCoverage: 0.4 },
    );
    expect(visible.map(formatNodeId)).toEqual(children.map((child) => formatNodeId(child.id)));
  });

  it("reveals a refinement cohort after its coverage threshold is reached", () => {
    const grandchildren = children.flatMap((child) => childNodeIds(child.id));
    const refinedParents = new Set(children.slice(0, 4).map((child) => formatNodeId(child.id)));
    const ready = new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
      ...grandchildren
        .filter((node) => refinedParents.has(formatNodeId(ancestorNodeId(node, 1))))
        .map(formatNodeId),
    ]);
    const visible = resolveReadyLod(
      root.id,
      grandchildren,
      (node) => ready.has(formatNodeId(node)),
      { minimumRefinementCoverage: 0.4 },
    );
    expect(visible).toHaveLength(4 * 8 + 4);
  });
});
