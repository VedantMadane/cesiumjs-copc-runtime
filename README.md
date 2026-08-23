# COPC Runtime for CesiumJS

Cloud-native COPC streaming for CesiumJS without a 3D Tiles preprocessing step.

> Status: working MVP. The repository implements coalesced HTTP range streaming, COPC hierarchy and Worker LAZ decoding, camera-driven LOD and point budgets, three-stage caching, source-CRS analysis, and Cesium GPU buffer rendering.

## Packages

- `@copc-runtime/core`: COPC source, range reader, hierarchy and decoded point types
- `@copc-runtime/runtime`: screen-space LOD, point-budget selection, request queue and byte-sized LRU cache
- `@copc-runtime/cesium`: CesiumJS primitive-style integration
- `@copc-runtime/worker`: transferable browser Worker pool for LAZ decoding
- `@copc-runtime/analysis`: streaming bounds queries and point-cloud statistics

## Viewer behavior and design choices

The demo and Cesium integration include several choices made specifically to keep
raw COPC data spatially correct and visually coherent while it streams:

- Remote sources are diagnosed before opening, including CORS byte-range support,
  COPC metadata, dimensions, and embedded CRS. Nearby range reads are coalesced and
  cached in memory and IndexedDB.
- Source coordinates are transformed to WGS84 Cartesian coordinates. Compound CRS
  definitions, US survey feet, and NAVD88 orthometric heights are handled, with an
  EGM96 geoid correction and an optional local vertical offset.
- Cesium World Terrain and the WGS84 ellipsoid can be selected as independent
  surface references. Picking a point reports its ellipsoid height, sampled surface
  height, and vertical difference instead of silently clamping the cloud.
- Imagery, terrain, point coloring/filtering, opacity, outline, and eye-dome lighting
  are independently selectable so terrain and COPC geometry can be compared directly.
- Normal dragging moves the map. Holding Space while dragging orbits around the
  position under the center of the viewport; Heading and Pitch controls use the same
  center pivot.
- Point size is a shared shader uniform, so changing it is constant-time and does not
  rewrite every point's GPU attributes.
- Streaming requests are reprioritized toward the camera center. Parent nodes remain
  visible until child cohorts are ready, and higher-detail cohorts are revealed only
  when they cover a meaningful portion of the viewport. This avoids small isolated
  patches of unusually dense points during loading and under a constrained budget.

## Usage

```ts
import { Viewer } from "cesium";
import { CopcPointCloud } from "@copc-runtime/cesium";
import { IndexedDbRangeCache } from "@copc-runtime/core";

const viewer = new Viewer("cesiumContainer");
const persistentCache = IndexedDbRangeCache.supported
  ? new IndexedDbRangeCache({ maximumBytes: 512 * 1024 * 1024 })
  : undefined;
const pointCloud = await CopcPointCloud.fromUrl(
  "https://example.com/data.copc.laz",
  {
    maximumScreenSpaceError: 2,
    workerCount: 4,
    pointBudget: 2_000_000,
    minimumRefinementCoverage: 0.4,
    pointSize: 2,
    opacity: 1,
    cacheSize: 512 * 1024 * 1024,
    decodedCacheSize: 768 * 1024 * 1024,
    range: {
      compressedCacheSize: 128 * 1024 * 1024,
      persistentCache,
    },
    colorBy: "rgb",
    allowPicking: true,
    dimensions: ["Red", "Green", "Blue", "Intensity", "Classification", "GpsTime"],
  },
);

viewer.scene.primitives.add(pointCloud);

// These can be changed while the layer is visible.
pointCloud.colorBy = "classification"; // rgb | classification | intensity | elevation
pointCloud.pointSize = 3;
pointCloud.filter = { classifications: [2, 6], intensity: [500, 65_535] };

pointCloud.bindClock(viewer.clock, {
  start: viewer.clock.startTime,
  stop: viewer.clock.stopTime,
  gpsStart: 1_000_000,
  gpsStop: 1_000_120,
  window: 10,
});

const point = pointCloud.pick(viewer.scene, windowPosition);
console.log(point?.node, point?.height, point?.attributes.Classification);
```

The COPC server must support CORS and return `206 Partial Content` for byte range requests. If the file does not contain a CRS WKT, provide `sourceCrs`, for example `sourceCrs: "EPSG:32652"`.

`CopcPointCloud.validateUrl(url)` checks byte-range support, file size, COPC metadata, available dimensions, and embedded CRS before a layer is opened.

## Development

```sh
npm install
npm test
npm run build
```

Run a repeatable streaming/decode benchmark against any CORS-enabled COPC URL:

```sh
npm run benchmark -- https://example.com/data.copc.laz 1000000
```

The report includes metadata load, time to first point, decode throughput, HTTP range bytes, coalescing and cache hits, and process memory.

Spatial queries operate directly in the source COPC CRS and return an async stream, so callers can process large areas without first materializing the complete result:

```ts
import { queryBounds, computeStatistics } from "@copc-runtime/analysis";

const nodes = queryBounds(source, [minX, minY, minZ, maxX, maxY, maxZ], {
  pointLimit: 2_000_000,
  dimensions: ["Intensity", "Classification"],
});
const statistics = await computeStatistics(nodes);
```

Height profiles use the same streaming query path:

```ts
const profile = await computeHeightProfile(source, [startX, startY], [endX, endY], {
  width: 5,
  pointLimit: 1_000_000,
});
```

## Current limitations

- Set `useWorkers: false` only when Web Workers are unavailable; browser decoding uses a transferable worker pool by default.
- Cesium's buffer point API is experimental, so minor Cesium releases may require compatibility updates.
- Runtime color and filter changes update Cesium buffer attributes on the CPU; point size uses a shared shader uniform, while general custom shader expressions are not implemented yet.
- `CopcEyeDomeLighting` uses Cesium's supported scene-depth post-process path. It improves point-cloud depth cues, but also shades depth discontinuities on terrain and other opaque scene geometry.
- Compound CRS heights marked as NAVD88/orthometric are converted to WGS84 ellipsoid heights with a bundled EGM96 grid. GEOID18 and local survey datums can differ from EGM96; use `verticalOffsetMeters` when a higher-accuracy local correction is available.
- IndexedDB uses URL + exact byte range keys; applications should set `range.cacheKey` when a URL can serve changing content.
