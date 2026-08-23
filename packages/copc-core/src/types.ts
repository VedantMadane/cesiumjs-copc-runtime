export type Vec3 = readonly [x: number, y: number, z: number];
export type Bounds3 = readonly [
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
];

export interface NodeId {
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface HierarchyEntry {
  readonly id: NodeId;
  readonly pointCount: number;
  readonly bounds: Bounds3;
  readonly spacing: number;
}

export interface PointCloudMetadata {
  readonly bounds: Bounds3;
  readonly spacing: number;
  readonly pointCount: number;
  readonly pointDataRecordFormat: number;
  readonly dimensions: readonly string[];
  readonly crs?: string;
  readonly gpsTimeRange?: readonly [number, number];
}

export type PointAttributeArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

export interface PointCloudNode {
  readonly id: NodeId;
  readonly pointCount: number;
  /** XYZ values interleaved in the source CRS. */
  readonly positions: Float64Array;
  /** RGB values interleaved and normalized to 0..255 when present. */
  readonly colors?: Uint8Array;
  readonly attributes: Readonly<Record<string, PointAttributeArray>>;
}

export interface CompressedPointCloudNode {
  readonly id: NodeId;
  readonly pointCount: number;
  readonly bytes: Uint8Array;
}

export interface PointCloudSource {
  metadata(): Promise<PointCloudMetadata>;
  root(): Promise<HierarchyEntry>;
  getHierarchy(node: NodeId): Promise<readonly HierarchyEntry[]>;
  loadNode(
    node: NodeId,
    dimensions?: readonly string[],
    signal?: AbortSignal,
  ): Promise<PointCloudNode>;
  destroy(): void;
}
