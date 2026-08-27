import { Cartesian3 } from "cesium";
import type { CartesianTransformDefinition } from "cesiumjs-copc-core";
import { egm96ToEllipsoid } from "egm96-universal";
import proj4 from "proj4";
import {
  EPSG_DEFINITIONS,
  normalizeEpsg,
  registerEpsgDefinitions,
} from "./epsg-definitions.js";

export type ToCartesian = (x: number, y: number, z: number, result?: Cartesian3) => Cartesian3;

/** Describes how source Z values should be interpreted before creating ECEF positions. */
export type VerticalDatum =
  | { readonly type: "as-is" }
  | { readonly type: "ellipsoid" }
  | { readonly type: "geoid"; readonly model: "egm96" };

export interface CoordinateTransformerOptions {
  /**
   * Vertical reference of source Z values. No geoid correction is applied when
   * omitted because a WKT vertical CRS is not sufficient to select a geoid model.
   */
  readonly verticalDatum?: VerticalDatum;
  /** @deprecated Use verticalDatum. Explicit "egm96" retains the legacy behavior. */
  readonly geoidModel?: "egm96" | "none";
  /** Additional application-specific offset after datum conversion, in meters. */
  readonly verticalOffsetMeters?: number;
}

export function createCoordinateTransformer(
  sourceCrs: string,
  options: CoordinateTransformerOptions = {},
): ToCartesian {
  const definition = createCoordinateTransformDefinition(sourceCrs, options);
  let transform: proj4.Converter;
  try {
    transform = proj4(definition.horizontalCrs, "EPSG:4326");
  } catch (error) {
    throw new Error(`Unable to create CRS transform from COPC CRS: ${sourceCrs}`, { cause: error });
  }
  return (x, y, z, result) => {
    const [longitude, latitude] = transform.forward([x, y]);
    const heightMeters = z * definition.verticalUnitToMeters;
    const ellipsoidHeight = definition.geoidModel === "egm96"
      ? egm96ToEllipsoid(latitude, longitude, heightMeters)
      : heightMeters;
    return Cartesian3.fromDegrees(
      longitude,
      latitude,
      ellipsoidHeight + definition.verticalOffsetMeters,
      undefined,
      result,
    );
  };
}

export function createCoordinateTransformDefinition(
  sourceCrs: string,
  options: CoordinateTransformerOptions = {},
): CartesianTransformDefinition {
  registerEpsgDefinitions();
  const { horizontalCrs, verticalUnitToMeters, orthometricHeight } = decomposeCrs(sourceCrs);
  if (options.verticalDatum !== undefined && options.geoidModel !== undefined) {
    throw new Error("Pass either verticalDatum or the deprecated geoidModel option, not both");
  }
  const applyEgm96 = options.verticalDatum?.type === "geoid"
    || (options.verticalDatum === undefined
      && options.geoidModel === "egm96"
      && orthometricHeight);
  const verticalOffsetMeters = options.verticalOffsetMeters ?? 0;
  if (!Number.isFinite(verticalOffsetMeters)) {
    throw new RangeError("verticalOffsetMeters must be finite");
  }
  let resolvedHorizontalCrs: string;
  try {
    resolvedHorizontalCrs = resolveHorizontalCrs(horizontalCrs);
    proj4(resolvedHorizontalCrs, "EPSG:4326");
  } catch (error) {
    throw new Error(`Unable to create CRS transform from COPC CRS: ${sourceCrs}`, { cause: error });
  }
  return {
    horizontalCrs: resolvedHorizontalCrs,
    verticalUnitToMeters,
    ...(applyEgm96 ? { geoidModel: "egm96" as const } : {}),
    verticalOffsetMeters,
  };
}

function decomposeCrs(sourceCrs: string): {
  horizontalCrs: string;
  verticalUnitToMeters: number;
  orthometricHeight: boolean;
} {
  if (!/^\s*(?:COMPD_CS|COMPOUNDCRS)\s*\[/i.test(sourceCrs)) {
    return {
      horizontalCrs: sourceCrs,
      verticalUnitToMeters: projectedLinearUnit(sourceCrs) ?? 1,
      orthometricHeight: false,
    };
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

function resolveHorizontalCrs(definition: string): string {
  const directCode = normalizeEpsg(definition);
  if (directCode !== definition || /^EPSG:/i.test(definition)) return directCode;

  const authorityMatches = Array.from(definition.matchAll(
    /(?:AUTHORITY\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)|ID\s*\[\s*["']EPSG["']\s*,\s*(\d+))/gi,
  ));
  const authority = authorityMatches.at(-1);
  const code = authority ? `EPSG:${authority[1] ?? authority[2]}` : undefined;
  const curated = code ? EPSG_DEFINITIONS[code] : undefined;
  if (curated?.includes("+towgs84")
    && !/\b(?:TOWGS84|ABRIDGEDTRANSFORMATION)\s*\[/i.test(definition)) {
    return code!;
  }
  try {
    proj4(definition, "EPSG:4326");
    return definition;
  } catch {
    if (code && proj4.defs(code)) return code;
    throw new Error(`proj4 cannot resolve source CRS${code ? ` or ${code}` : ""}`);
  }
}

/** Finds the outermost projected linear unit, ignoring nested angular units. */
function projectedLinearUnit(wkt: string): number | undefined {
  if (!/^\s*(?:PROJCS|PROJCRS|PROJECTEDCRS)\s*\[/i.test(wkt)) return undefined;
  let depth = 0;
  let quoted = false;
  const candidates: Array<{ depth: number; value: number }> = [];
  for (let index = 0; index < wkt.length; index += 1) {
    const character = wkt[index];
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    else {
      const match = /^(?:LENGTHUNIT|UNIT)\s*\[\s*"[^"]*"\s*,\s*([+\-\d.eE]+)/i.exec(wkt.slice(index));
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) candidates.push({ depth, value });
      index += match[0].length - 1;
    }
  }
  if (candidates.length === 0) return undefined;
  const shallowest = Math.min(...candidates.map((candidate) => candidate.depth));
  return candidates.find((candidate) => candidate.depth === shallowest)?.value;
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
