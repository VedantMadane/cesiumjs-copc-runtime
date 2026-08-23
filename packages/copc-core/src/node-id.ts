import type { Bounds3, NodeId } from "./types.js";

export function parseNodeId(value: string): NodeId {
  const parts = value.split("-").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid COPC node key: ${value}`);
  }
  const [depth, x, y, z] = parts;
  return { depth: depth!, x: x!, y: y!, z: z! };
}

export function formatNodeId(node: NodeId): string {
  return `${node.depth}-${node.x}-${node.y}-${node.z}`;
}

export function childNodeIds(parent: NodeId): NodeId[] {
  const depth = parent.depth + 1;
  const result: NodeId[] = [];
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        result.push({
          depth,
          x: parent.x * 2 + x,
          y: parent.y * 2 + y,
          z: parent.z * 2 + z,
        });
      }
    }
  }
  return result;
}

export function ancestorNodeId(node: NodeId, depth: number): NodeId {
  if (!Number.isInteger(depth) || depth < 0 || depth > node.depth) {
    throw new RangeError(`Ancestor depth must be between 0 and ${node.depth}`);
  }
  const divisor = 2 ** (node.depth - depth);
  return {
    depth,
    x: Math.floor(node.x / divisor),
    y: Math.floor(node.y / divisor),
    z: Math.floor(node.z / divisor),
  };
}

export function boundsForNode(root: Bounds3, node: NodeId): Bounds3 {
  const divisions = 2 ** node.depth;
  const width = (root[3] - root[0]) / divisions;
  const height = (root[4] - root[1]) / divisions;
  const depth = (root[5] - root[2]) / divisions;
  const minX = root[0] + width * node.x;
  const minY = root[1] + height * node.y;
  const minZ = root[2] + depth * node.z;
  return [minX, minY, minZ, minX + width, minY + height, minZ + depth];
}
