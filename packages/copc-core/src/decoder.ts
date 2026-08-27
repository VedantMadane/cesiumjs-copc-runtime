import { Las, type Copc } from "copc";
import type { CompressedPointCloudNode, PointAttributeArray, PointCloudNode } from "./types.js";

export interface CopcDecodingMetadata {
  readonly header: Pick<
    Copc["header"],
    "pointDataRecordFormat" | "pointDataRecordLength" | "scale" | "offset"
  >;
  readonly extraBytes: Copc["eb"];
}

export async function decodeCompressedPointNode(
  metadata: CopcDecodingMetadata,
  node: CompressedPointCloudNode,
  dimensions: readonly string[],
  signal?: AbortSignal,
): Promise<PointCloudNode> {
  signal?.throwIfAborted();
  const buffer = await Las.PointData.decompressChunk(node.bytes, {
    pointCount: node.pointCount,
    pointDataRecordFormat: metadata.header.pointDataRecordFormat,
    pointDataRecordLength: metadata.header.pointDataRecordLength,
  });
  signal?.throwIfAborted();
  const requested = Array.from(new Set(["X", "Y", "Z", ...dimensions]));
  const view = Las.View.create(buffer, metadata.header, metadata.extraBytes, requested);
  const positions = new Float64Array(node.pointCount * 3);
  const x = view.getter("X");
  const y = view.getter("Y");
  const z = view.getter("Z");
  for (let i = 0; i < node.pointCount; i += 1) {
    positions[i * 3] = x(i);
    positions[i * 3 + 1] = y(i);
    positions[i * 3 + 2] = z(i);
  }

  let colors: Uint8Array | undefined;
  if (["Red", "Green", "Blue"].every((name) => name in view.dimensions)) {
    colors = new Uint8Array(node.pointCount * 3);
    const red = view.getter("Red");
    const green = view.getter("Green");
    const blue = view.getter("Blue");
    const raw = new Uint16Array(node.pointCount * 3);
    let maximum = 0;
    for (let i = 0; i < node.pointCount; i += 1) {
      raw[i * 3] = red(i);
      raw[i * 3 + 1] = green(i);
      raw[i * 3 + 2] = blue(i);
      maximum = Math.max(maximum, raw[i * 3]!, raw[i * 3 + 1]!, raw[i * 3 + 2]!);
    }
    const divisor = maximum > 255 ? 257 : 1;
    for (let i = 0; i < raw.length; i += 1) colors[i] = Math.round(raw[i]! / divisor);
  }

  const attributes: Record<string, PointAttributeArray> = {};
  for (const name of dimensions) {
    if (["X", "Y", "Z", "Red", "Green", "Blue"].includes(name)) continue;
    if (!(name in view.dimensions)) continue;
    const getter = view.getter(name);
    const values = new Float64Array(node.pointCount);
    for (let i = 0; i < node.pointCount; i += 1) values[i] = getter(i);
    attributes[name] = values;
  }
  return {
    id: node.id,
    pointCount: node.pointCount,
    positions,
    attributes,
    ...(colors === undefined ? {} : { colors }),
  };
}
