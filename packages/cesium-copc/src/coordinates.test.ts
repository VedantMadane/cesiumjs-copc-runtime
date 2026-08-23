import { Cartographic, Math as CesiumMath } from "cesium";
import { meanSeaLevel } from "egm96-universal";
import { describe, expect, it } from "vitest";
import { createCoordinateTransformer } from "./coordinates.js";

describe("coordinate transformer", () => {
  it("places EPSG:4326 coordinates on the WGS84 ellipsoid", () => {
    const cartesian = createCoordinateTransformer("EPSG:4326")(127, 37, 123);
    const cartographic = Cartographic.fromCartesian(cartesian);
    expect(CesiumMath.toDegrees(cartographic.longitude)).toBeCloseTo(127, 8);
    expect(CesiumMath.toDegrees(cartographic.latitude)).toBeCloseTo(37, 8);
    expect(cartographic.height).toBeCloseTo(123, 4);
  });

  it("supports compound projected CRS and converts its vertical unit", () => {
    const compoundCrs = `COMPD_CS["NAD83 / Oregon GIC Lambert (ft) + NAVD88 height (ftUS)",
      PROJCS["NAD83 / Oregon GIC Lambert (ft)",
        GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],
          PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],
        PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",41.75],
        PARAMETER["central_meridian",-120.5],PARAMETER["standard_parallel_1",43],
        PARAMETER["standard_parallel_2",45.5],PARAMETER["false_easting",1312335.958],
        PARAMETER["false_northing",0],UNIT["foot",0.3048]],
      VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],
        UNIT["US survey foot",0.304800609601219],AXIS["Gravity-related height",UP]]]`;

    const cartesian = createCoordinateTransformer(compoundCrs)(637_900, 851_200, 100);
    const cartographic = Cartographic.fromCartesian(cartesian);
    expect(CesiumMath.toDegrees(cartographic.longitude)).toBeGreaterThan(-124);
    expect(CesiumMath.toDegrees(cartographic.longitude)).toBeLessThan(-116);
    expect(CesiumMath.toDegrees(cartographic.latitude)).toBeGreaterThan(41);
    expect(CesiumMath.toDegrees(cartographic.latitude)).toBeLessThan(47);
    const latitude = CesiumMath.toDegrees(cartographic.latitude);
    const longitude = CesiumMath.toDegrees(cartographic.longitude);
    expect(cartographic.height).toBeCloseTo(
      30.4800609601219 + meanSeaLevel(latitude, longitude),
      4,
    );
  });

  it("allows automatic geoid correction to be disabled", () => {
    const compoundCrs = `COMPD_CS["test",GEOGCS["WGS 84",DATUM["WGS_1984",
      SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],
      UNIT["degree",0.0174532925199433]],VERT_CS["NAVD88 height",
      VERT_DATUM["NAVD88",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]`;
    const cartographic = Cartographic.fromCartesian(
      createCoordinateTransformer(compoundCrs, { geoidModel: "none" })(-123, 44, 100),
    );
    expect(cartographic.height).toBeCloseTo(100, 4);
  });
});
