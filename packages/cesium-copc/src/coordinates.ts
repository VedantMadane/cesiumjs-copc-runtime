import { Cartesian3 } from "cesium";
import { egm96ToEllipsoid } from "egm96-universal";
import proj4 from "proj4";

export type ToCartesian = (x: number, y: number, z: number, result?: Cartesian3) => Cartesian3;

export interface CoordinateTransformerOptions {
  /** Disable when source heights are already ellipsoidal. */
  readonly geoidModel?: "egm96" | "none";
  /** Additional application-specific offset after datum conversion, in meters. */
  readonly verticalOffsetMeters?: number;
}

export function createCoordinateTransformer(
  sourceCrs: string,
  options: CoordinateTransformerOptions = {},
): ToCartesian {
  const { horizontalCrs, verticalUnitToMeters, orthometricHeight } = decomposeCrs(sourceCrs);
  const verticalOffsetMeters = options.verticalOffsetMeters ?? 0;
  if (!Number.isFinite(verticalOffsetMeters)) {
    throw new RangeError("verticalOffsetMeters must be finite");
  }
  let transform: proj4.Converter;
  try {
    transform = proj4(horizontalCrs, "EPSG:4326");
  } catch (error) {
    throw new Error(`Unable to create CRS transform from COPC CRS: ${sourceCrs}`, { cause: error });
  }
  return (x, y, z, result) => {
    const [longitude, latitude] = transform.forward([x, y]);
    const heightMeters = z * verticalUnitToMeters;
    const ellipsoidHeight = orthometricHeight && options.geoidModel !== "none"
      ? egm96ToEllipsoid(latitude, longitude, heightMeters)
      : heightMeters;
    return Cartesian3.fromDegrees(
      longitude,
      latitude,
      ellipsoidHeight + verticalOffsetMeters,
      undefined,
      result,
    );
  };
}

function decomposeCrs(sourceCrs: string): {
  horizontalCrs: string;
  verticalUnitToMeters: number;
  orthometricHeight: boolean;
} {
  if (!/^\s*(?:COMPD_CS|COMPOUNDCRS)\s*\[/i.test(sourceCrs)) {
    return { horizontalCrs: sourceCrs, verticalUnitToMeters: 1, orthometricHeight: false };
  }

  const horizontalCrs = extractWktComponent(sourceCrs, ["PROJCS", "PROJCRS"])
    ?? extractWktComponent(sourceCrs, ["GEOGCS", "GEOGCRS"])
    ?? sourceCrs;
  const verticalCrs = extractWktComponent(sourceCrs, ["VERT_CS", "VERTCRS"]);
  const unitMatch = verticalCrs?.match(
    /\b(?:LENGTHUNIT|UNIT)\s*\[\s*"[^"]*"\s*,\s*([+\-\d.eE]+)/i,
  );
  const parsedUnit = unitMatch ? Number(unitMatch[1]) : 1;
  return {
    horizontalCrs,
    verticalUnitToMeters: Number.isFinite(parsedUnit) && parsedUnit > 0 ? parsedUnit : 1,
    orthometricHeight: verticalCrs !== undefined
      && /NAVD\s*88|EGM\s*(?:84|96|2008)|orthometric|gravity-related/i.test(verticalCrs),
  };
}

function extractWktComponent(wkt: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`\\b${name}\\s*\\[`, "i").exec(wkt);
    if (!match) continue;
    const start = match.index;
    const openingBracket = wkt.indexOf("[", start);
    let depth = 0;
    let quoted = false;
    for (let index = openingBracket; index < wkt.length; index += 1) {
      const character = wkt[index];
      if (character === '"') {
        if (quoted && wkt[index + 1] === '"') {
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (!quoted && character === "[") {
        depth += 1;
      } else if (!quoted && character === "]") {
        depth -= 1;
        if (depth === 0) return wkt.slice(start, index + 1);
      }
    }
  }
  return undefined;
}
