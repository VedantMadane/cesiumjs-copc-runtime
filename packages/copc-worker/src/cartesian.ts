import type {
  CartesianPointPositions,
  CartesianTransformDefinition,
  PointCloudNode,
} from "cesiumjs-copc-core";
import proj4 from "proj4";

const WGS84_A = 6_378_137;
const WGS84_E2 = 6.69437999014e-3;
const RADIANS = Math.PI / 180;

/** Projects source positions and packs them relative to a stable ECEF origin. */
export function createCartesianPositions(
  node: PointCloudNode,
  definition: CartesianTransformDefinition,
): CartesianPointPositions {
  if (definition.geoidModel !== undefined) {
    throw new Error("Worker Cartesian packing does not support geoid correction");
  }
  const forward = proj4(definition.horizontalCrs, "EPSG:4326").forward;
  const absolute = new Float64Array(node.pointCount * 3);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < node.pointCount; index += 1) {
    const [longitude, latitude] = forward([
      node.positions[index * 3]!,
      node.positions[index * 3 + 1]!,
    ]);
    const sourceHeight = node.positions[index * 3 + 2]! * definition.verticalUnitToMeters;
    const height = sourceHeight + definition.verticalOffsetMeters;
    const [x, y, z] = geodeticToEcef(longitude, latitude, height);
    absolute[index * 3] = x;
    absolute[index * 3 + 1] = y;
    absolute[index * 3 + 2] = z;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const origin =
    node.pointCount === 0
      ? ([0, 0, 0] as const)
      : ([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] as const);
  const positions = new Float32Array(absolute.length);
  for (let index = 0; index < absolute.length; index += 3) {
    positions[index] = absolute[index]! - origin[0];
    positions[index + 1] = absolute[index + 1]! - origin[1];
    positions[index + 2] = absolute[index + 2]! - origin[2];
  }
  return { origin, positions };
}

function geodeticToEcef(
  longitude: number,
  latitude: number,
  height: number,
): readonly [number, number, number] {
  const longitudeRadians = longitude * RADIANS;
  const latitudeRadians = latitude * RADIANS;
  const sinLatitude = Math.sin(latitudeRadians);
  const cosLatitude = Math.cos(latitudeRadians);
  const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
  return [
    (radius + height) * cosLatitude * Math.cos(longitudeRadians),
    (radius + height) * cosLatitude * Math.sin(longitudeRadians),
    (radius * (1 - WGS84_E2) + height) * sinLatitude,
  ];
}
