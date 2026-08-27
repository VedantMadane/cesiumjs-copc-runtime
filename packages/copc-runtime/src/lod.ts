import {
  ancestorNodeId,
  formatNodeId,
  type Bounds3,
  type HierarchyEntry,
  type NodeId,
} from "@copc-runtime/core";

export interface ViewState {
  readonly viewportHeight: number;
  readonly verticalFieldOfView: number;
  isVisible(bounds: Bounds3): boolean;
  distanceTo(bounds: Bounds3): number;
  /** Approximate projected screen area used for coverage-aware refinement. */
  screenWeight?(bounds: Bounds3): number;
  /** View-dependent multiplier used to direct limited refinement budget. */
  refinementWeight?(bounds: Bounds3): number;
}

export interface LodOptions {
  readonly maximumScreenSpaceError: number;
  readonly pointBudget: number;
  readonly minimumRefinementCoverage?: number;
}

export interface LodSelection {
  readonly selected: readonly HierarchyEntry[];
  /** Visible leaves that need hierarchy expansion before finer LOD can be selected. */
  readonly refinementRequested: readonly HierarchyEntry[];
  readonly pointCount: number;
}

export type ChildrenLookup = (node: NodeId) => readonly HierarchyEntry[] | undefined;

export interface ReadyLodOptions {
  /** Minimum weighted share of refinable sibling branches before revealing them. */
  readonly minimumRefinementCoverage?: number;
  /** Approximate screen-space weight of a branch. */
  readonly weight?: (node: NodeId) => number;
}

export function screenSpaceError(node: HierarchyEntry, view: ViewState): number {
  const distance = Math.max(view.distanceTo(node.bounds), Number.EPSILON);
  const denominator = 2 * Math.tan(view.verticalFieldOfView / 2);
  return (node.spacing * view.viewportHeight) / (distance * denominator);
}

export function selectLod(
  root: HierarchyEntry,
  childrenOf: ChildrenLookup,
  view: ViewState,
  options: LodOptions,
): LodSelection {
  if (options.pointBudget <= 0) {
    return { selected: [], refinementRequested: [], pointCount: 0 };
  }
  if (!view.isVisible(root.bounds)) {
    return { selected: [], refinementRequested: [], pointCount: 0 };
  }
  const selected = new Map<string, HierarchyEntry>([[formatNodeId(root.id), root]]);
  const candidates: Array<{ node: HierarchyEntry; error: number }> = [];
  const refinementRequested: HierarchyEntry[] = [];
  let pointCount = root.pointCount;

  const consider = (node: HierarchyEntry): void => {
    const baseError = screenSpaceError(node, view);
    if (baseError <= options.maximumScreenSpaceError) return;
    const error = baseError * Math.max(0, view.refinementWeight?.(node.bounds) ?? 1);
    const children = childrenOf(node.id);
    if (children === undefined) {
      refinementRequested.push(node);
      return;
    }
    const visibleChildren = children?.filter((child) => view.isVisible(child.bounds)) ?? [];
    if (visibleChildren.length > 0) candidates.push({ node, error });
  };
  consider(root);

  const minimumCoverage = Math.min(1, Math.max(0, options.minimumRefinementCoverage ?? 0));

  if (minimumCoverage > 0) {
    while (candidates.length > 0) {
      candidates.sort((a, b) => b.error - a.error
        || formatNodeId(a.node.id).localeCompare(formatNodeId(b.node.id)));
      const depth = candidates[0]!.node.id.depth;
      const cohort = candidates.filter((candidate) => candidate.node.id.depth === depth);
      for (const candidate of cohort) candidates.splice(candidates.indexOf(candidate), 1);

      const refinements = cohort.map((candidate) => {
        const children = childrenOf(candidate.node.id)?.filter((child) => view.isVisible(child.bounds)) ?? [];
        const childPoints = children.reduce((total, child) => total + child.pointCount, 0);
        return {
          ...candidate,
          children,
          // COPC follows EPT's additive octree model: parent points are not
          // duplicated in children, so refinement adds rather than replaces.
          pointDelta: childPoints,
          weight: Math.max(0, view.screenWeight?.(candidate.node.bounds) ?? 1),
          refinementWeight: Math.max(0, view.refinementWeight?.(candidate.node.bounds) ?? 1),
        };
      }).filter((candidate) => candidate.children.length > 0);

      const totalWeight = refinements.reduce((total, candidate) => total + candidate.weight, 0);
      const chosen: typeof refinements = [];
      let remainingBudget = options.pointBudget - pointCount;
      let chosenWeight = 0;
      for (const candidate of refinements) {
        if (candidate.pointDelta > remainingBudget) continue;
        chosen.push(candidate);
        chosenWeight += candidate.weight;
        remainingBudget -= candidate.pointDelta;
      }
      const relativeCoverage = totalWeight > 0 ? chosenWeight / totalWeight : 0;
      const viewportCoverage = view.screenWeight ? Math.min(1, chosenWeight) : 0;
      const containsFocus = chosen.some((candidate) => candidate.refinementWeight > 1.25);
      if (relativeCoverage < minimumCoverage
        && viewportCoverage < minimumCoverage
        && !containsFocus) continue;

      const completeCohort = chosen.length === refinements.length;
      const fillsViewport = viewportCoverage >= minimumCoverage;
      for (const candidate of chosen) {
        const key = formatNodeId(candidate.node.id);
        if (!selected.has(key)) continue;
        for (const child of candidate.children) {
          selected.set(formatNodeId(child.id), child);
          // Do not refine deeper after only a partial screen cohort was affordable.
          if (completeCohort || fillsViewport || candidate.refinementWeight > 1.25) consider(child);
        }
        pointCount += candidate.pointDelta;
      }
    }

    return {
      selected: Array.from(selected.values()),
      refinementRequested,
      pointCount,
    };
  }

  while (candidates.length > 0) {
    candidates.sort((a, b) => b.error - a.error
      || formatNodeId(a.node.id).localeCompare(formatNodeId(b.node.id)));
    const candidate = candidates.shift()!;
    const key = formatNodeId(candidate.node.id);
    if (!selected.has(key)) continue;
    const children = childrenOf(candidate.node.id);
    if (!children) continue;
    const visibleChildren = children.filter((child) => view.isVisible(child.bounds));
    if (visibleChildren.length === 0) continue;
    const childPoints = visibleChildren.reduce((total, child) => total + child.pointCount, 0);
    const refinedPointCount = pointCount + childPoints;
    if (refinedPointCount > options.pointBudget) continue;
    for (const child of visibleChildren) {
      selected.set(formatNodeId(child.id), child);
      consider(child);
    }
    pointCount = refinedPointCount;
  }

  return {
    selected: Array.from(selected.values()),
    refinementRequested,
    pointCount,
  };
}

/**
 * Resolves an additive display set while refining sibling branches atomically.
 * Ready ancestors remain visible because their points are not duplicated in
 * descendants; incomplete child cohorts are withheld to avoid patchy detail.
 */
export function resolveReadyLod(
  root: NodeId,
  selected: readonly NodeId[],
  isReady: (node: NodeId) => boolean,
  options: ReadyLodOptions = {},
): readonly NodeId[] {
  if (selected.length === 0) return [];

  const minimumCoverage = Math.min(1, Math.max(0, options.minimumRefinementCoverage ?? 0));
  const weight = options.weight ?? (() => 1);

  // The additive selection contains every requested ancestor. Resolve atomic
  // readiness against only its deepest frontier, then restore ready ancestors.
  const nodesWithSelectedDescendants = new Set<string>();
  for (const node of selected) {
    for (let depth = root.depth; depth < node.depth; depth += 1) {
      nodesWithSelectedDescendants.add(formatNodeId(ancestorNodeId(node, depth)));
    }
  }
  const selectedFrontier = selected.filter((candidate) =>
    !nodesWithSelectedDescendants.has(formatNodeId(candidate)));
  const selectedKeys = new Set(selectedFrontier.map(formatNodeId));
  const childBranches = new Map<string, Map<string, NodeId>>();
  for (const node of selectedFrontier) {
    for (let depth = root.depth; depth < node.depth; depth += 1) {
      const parent = ancestorNodeId(node, depth);
      const child = ancestorNodeId(node, depth + 1);
      const parentKey = formatNodeId(parent);
      let branches = childBranches.get(parentKey);
      if (!branches) {
        branches = new Map<string, NodeId>();
        childBranches.set(parentKey, branches);
      }
      branches.set(formatNodeId(child), child);
    }
  }

  const resolve = (node: NodeId): NodeId[] | undefined => {
    const key = formatNodeId(node);
    if (selectedKeys.has(key)) return isReady(node) ? [node] : undefined;

    const branches = childBranches.get(key);
    if (!branches) return isReady(node) ? [node] : undefined;

    const result: NodeId[] = [];
    const resolvedBranches = new Map<string, NodeId[]>();
    for (const child of branches.values()) {
      const childFrontier = resolve(child);
      if (!childFrontier) return isReady(node) ? [node] : undefined;
      resolvedBranches.set(formatNodeId(child), childFrontier);
    }

    if (minimumCoverage > 0) {
      let refinableWeight = 0;
      let refinedWeight = 0;
      for (const child of branches.values()) {
        const childKey = formatNodeId(child);
        if (!childBranches.has(childKey)) continue;
        const branchWeight = Math.max(0, weight(child));
        refinableWeight += branchWeight;
        const frontier = resolvedBranches.get(childKey)!;
        if (!(frontier.length === 1 && formatNodeId(frontier[0]!) === childKey)) {
          refinedWeight += branchWeight;
        }
      }
      if (refinedWeight > 0
        && refinableWeight > 0
        && refinedWeight / refinableWeight < minimumCoverage
        && (!options.weight || Math.min(1, refinedWeight) < minimumCoverage)) {
        const immediateChildren = Array.from(branches.values());
        return immediateChildren.every(isReady)
          ? immediateChildren
          : (isReady(node) ? [node] : undefined);
      }
    }

    for (const child of branches.values()) {
      result.push(...resolvedBranches.get(formatNodeId(child))!);
    }
    return result;
  };

  const frontier = resolve(root) ?? [];
  const additive = new Map<string, NodeId>();
  for (const node of frontier) {
    for (let depth = root.depth; depth <= node.depth; depth += 1) {
      const ancestor = ancestorNodeId(node, depth);
      const key = formatNodeId(ancestor);
      if (isReady(ancestor)) additive.set(key, ancestor);
    }
  }
  return Array.from(additive.values());
}
