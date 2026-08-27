import proj4 from "proj4";

const GRS80 = "+ellps=GRS80 +units=m +no_defs";
const BESSEL = "+ellps=bessel +units=m +no_defs "
  + "+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43";

function tmerc(lon: number, northing: number, datum: string, scale = 1, easting = 200_000): string {
  return `+proj=tmerc +lat_0=38 +lon_0=${lon} +k=${scale} +x_0=${easting} +y_0=${northing} ${datum}`;
}

/** Korean national grids that proj4js does not register by default. */
export const EPSG_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  "EPSG:4737": "+proj=longlat +ellps=GRS80 +no_defs",
  "EPSG:5179": tmerc(127.5, 2_000_000, GRS80, 0.9996, 1_000_000),
  "EPSG:5180": tmerc(125, 500_000, GRS80),
  "EPSG:5181": tmerc(127, 500_000, GRS80),
  "EPSG:5182": tmerc(127, 550_000, GRS80),
  "EPSG:5183": tmerc(129, 500_000, GRS80),
  "EPSG:5184": tmerc(131, 500_000, GRS80),
  "EPSG:5185": tmerc(125, 600_000, GRS80),
  "EPSG:5186": tmerc(127, 600_000, GRS80),
  "EPSG:5187": tmerc(129, 600_000, GRS80),
  "EPSG:5188": tmerc(131, 600_000, GRS80),
  "EPSG:5173": tmerc(125.00289027777778, 500_000, BESSEL),
  "EPSG:5174": tmerc(127.00289027777778, 500_000, BESSEL),
  "EPSG:5175": tmerc(127.00289027777778, 550_000, BESSEL),
  "EPSG:5176": tmerc(129.00289027777778, 500_000, BESSEL),
  "EPSG:5177": tmerc(131.00289027777778, 500_000, BESSEL),
  "EPSG:5178": tmerc(127.5, 2_000_000, BESSEL, 0.9996, 1_000_000),
  "EPSG:2096": tmerc(129, 500_000, BESSEL),
  "EPSG:2097": tmerc(127, 500_000, BESSEL),
  "EPSG:2098": tmerc(125, 500_000, BESSEL),
});

let registered = false;

export function registerEpsgDefinitions(): void {
  if (registered) return;
  registered = true;
  for (const [code, definition] of Object.entries(EPSG_DEFINITIONS)) {
    if (!proj4.defs(code)) proj4.defs(code, definition);
  }
}

export function isKnownEpsg(code: string): boolean {
  registerEpsgDefinitions();
  return Boolean(proj4.defs(normalizeEpsg(code)));
}

export function normalizeEpsg(code: string): string {
  const match = /^\s*(?:EPSG\s*:\s*)?(\d+)\s*$/i.exec(code);
  return match ? `EPSG:${match[1]}` : code;
}
