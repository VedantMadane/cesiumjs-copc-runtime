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

  it("adds the complete visible child frontier while retaining its parent", () => {
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : [],
      view,
      { maximumScreenSpaceError: 2, pointBudget: 900 },
    );
    expect(result.selected).toHaveLength(9);
    expect(result.selected[0]).toEqual(root);
    expect(result.pointCount).toBe(900);
  });

  it("does not spend the point budget on a visually small refinement patch", () => {
    const grandchildrenByParent = new Map(children.map((child) => [
      formatNodeId(child.id),
      childNodeIds(child.id).map((id) => entry(id)),
    ]));
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : (grandchildrenByParent.get(formatNodeId(id)) ?? []),
      { ...view, screenWeight: () => 0.05 },
      { maximumScreenSpaceError: 2, pointBudget: 2_200, minimumRefinementCoverage: 0.4 },
    );
    expect(result.selected).toHaveLength(9);
    expect(result.selected.filter((node) => node.id.depth === 1)).toHaveLength(8);
    expect(result.pointCount).toBe(900);
  });

  it("allows a broad refinement cohort and stops it from racing deeper", () => {
    const grandchildrenByParent = new Map(children.map((child) => [
      formatNodeId(child.id),
      childNodeIds(child.id).map((id) => entry(id)),
    ]));
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : (grandchildrenByParent.get(formatNodeId(id)) ?? []),
      { ...view, screenWeight: () => 0.05 },
      { maximumScreenSpaceError: 2, pointBudget: 4_100, minimumRefinementCoverage: 0.4 },
    );
    expect(result.selected).toHaveLength(41);
    expect(result.selected.filter((node) => node.id.depth === 2)).toHaveLength(32);
    expect(result.pointCount).toBe(4_100);
  });

  it("refines an enlarged region even when it is a small share of the candidate set", () => {
    const grandchildrenByParent = new Map(children.map((child) => [
      formatNodeId(child.id),
      childNodeIds(child.id).map((id) => entry(id)),
    ]));
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : (grandchildrenByParent.get(formatNodeId(id)) ?? []),
      {
        ...view,
        screenWeight: (bounds) => bounds[0] === children[0]!.bounds[0]
          && bounds[1] === children[0]!.bounds[1]
          && bounds[2] === children[0]!.bounds[2]
          ? 0.5
          : 0.01,
      },
      { maximumScreenSpaceError: 2, pointBudget: 1_700, minimumRefinementCoverage: 0.4 },
    );
    expect(result.selected.filter((node) => node.id.depth === 2)).toHaveLength(8);
    expect(result.pointCount).toBe(1_700);
  });

  it("spends limited refinement budget on the view focus", () => {
    const grandchildrenByParent = new Map(children.map((child) => [
      formatNodeId(child.id),
      childNodeIds(child.id).map((id) => entry(id)),
    ]));
    const focusedParent = children.at(-1)!;
    const result = selectLod(
      root,
      (id) => id.depth === 0 ? children : (grandchildrenByParent.get(formatNodeId(id)) ?? []),
      {
        ...view,
        screenWeight: () => 0.05,
        refinementWeight: (bounds) => bounds === focusedParent.bounds ? 2.5 : 1,
      },
      { maximumScreenSpaceError: 2, pointBudget: 1_700, minimumRefinementCoverage: 0.4 },
    );

    const refinedParents = new Set(result.selected
      .filter((node) => node.id.depth === 2)
      .map((node) => formatNodeId(ancestorNodeId(node.id, 1))));
    expect(refinedParents).toEqual(new Set([formatNodeId(focusedParent.id)]));
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
    expect(new Set(visible.map(formatNodeId))).toEqual(new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
    ]));
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
    expect(new Set(visible.map(formatNodeId))).toEqual(new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
      ...grandchildren.map(formatNodeId),
    ]));
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
    expect(new Set(visible.map(formatNodeId))).toEqual(new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
    ]));
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
    expect(visible).toHaveLength(1 + 8 + 4 * 8);
  });

  it("reveals a loaded refinement when that region fills the viewport", () => {
    const grandchildren = children.flatMap((child) => childNodeIds(child.id));
    const refinedParent = formatNodeId(children[0]!.id);
    const ready = new Set([
      formatNodeId(root.id),
      ...children.map((child) => formatNodeId(child.id)),
      ...grandchildren
        .filter((node) => formatNodeId(ancestorNodeId(node, 1)) === refinedParent)
        .map(formatNodeId),
    ]);
    const visible = resolveReadyLod(
      root.id,
      grandchildren,
      (node) => ready.has(formatNodeId(node)),
      { minimumRefinementCoverage: 0.4, weight: () => 0.4 },
    );
    expect(visible).toHaveLength(1 + 8 + 8);
  });
});
