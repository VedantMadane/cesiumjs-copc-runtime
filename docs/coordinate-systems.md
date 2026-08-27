# Coordinate systems and vertical references

Point-cloud placement is correct only when horizontal coordinates, units, and vertical
reference are interpreted explicitly.

## Resolution order

1. Use the caller-provided `sourceCrs` when present.
2. Otherwise inspect embedded COPC/LAS WKT.
3. Separate horizontal and vertical components of compound WKT.
4. Normalize horizontal and vertical units independently.
5. Reject or diagnose missing horizontal CRS instead of guessing.

## Built-in Korean grids

The Cesium integration registers commonly encountered public-survey definitions:

- `EPSG:5173`–`EPSG:5188`
- `EPSG:2096`–`EPSG:2098`
- `EPSG:4737`

Legacy Bessel WKT that declares one of these codes but omits its datum shift uses the
curated definition. This avoids silently placing data hundreds of metres away.

## Vertical coordinates

Source vertical units are converted to metres. No geoid correction is applied by
default because CRS metadata alone does not always identify the model used to produce
the heights.

Use an explicit option only when the dataset is known to use EGM96 orthometric height:

```ts
verticalDatum: { type: "geoid", model: "egm96" }
```

This converts orthometric heights to ellipsoid heights. A local vertical offset can
be supplied separately for known project adjustments.

## Rendering precision

Workers preserve source coordinates in `Float64`, transform to ECEF, subtract a node
origin, and transfer node-relative `Float32` positions for rendering. Picking and
analysis continue to use source coordinates and attributes.

## Verification checklist

- confirm the EPSG code or inspect WKT;
- compare known control points, not only visual alignment;
- distinguish ellipsoid height from terrain or orthometric height;
- record any geoid model and local offset;
- test points near the dataset bounds for precision loss.
