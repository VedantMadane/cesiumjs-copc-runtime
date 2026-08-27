# Getting started

This guide opens the demo, validates a remote COPC source, and creates a point-cloud
primitive from application code.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- a WebGL-capable browser
- a COPC server that allows CORS and HTTP byte-range requests

## Run the demo

```sh
git clone https://github.com/yangseungsang/cesiumjs-copc-runtime.git
cd cesiumjs-copc-runtime
npm ci
npm run build
npm run demo
```

The demo starts with the public Autzen Stadium dataset. Paste another `.copc.laz`
URL and select **Load** to inspect it. The diagnostics panel reports visible points,
node counts, network bytes, physical and logical ranges, cache hits, decode/build
time, FPS, and time to first point.

## Validate a source

Call `CopcPointCloud.validateUrl(url)` before creating a layer. Validation checks:

- response size and HTTP `206 Partial Content` support;
- COPC header and info metadata;
- available LAS dimensions;
- embedded CRS WKT.

A signed URL may change while cached. Provide a stable `range.cacheKey` when the URL
contains rotating credentials or can return different content.

## Create a layer

```ts
import { Viewer } from "cesium";
import { CopcPointCloud } from "cesiumjs-copc";

const viewer = new Viewer("cesiumContainer");
const cloud = await CopcPointCloud.fromUrl(url, {
  maximumScreenSpaceError: 2,
  pointBudget: 2_000_000,
  cacheSize: 512 * 1024 * 1024,
  decodedCacheSize: 768 * 1024 * 1024,
  colorBy: "rgb",
  dimensions: ["Red", "Green", "Blue", "Intensity", "Classification"],
});

viewer.scene.primitives.add(cloud);
```

`maximumScreenSpaceError` controls refinement: lower values request more detail.
`pointBudget` limits the selected points. Defaults adapt to the detected low, medium,
or high device tier, and every budget remains overridable.

## Clean up

Remove the primitive and call `destroy()` when a layer is no longer needed. Destroying
the source cancels queued work, terminates owned Workers, and releases GPU resources.

## Next steps

- [Architecture](architecture.md)
- [API reference](api-reference.md)
- [Coordinate systems](coordinate-systems.md)
- [Troubleshooting](troubleshooting.md)
- [Development](development.md)
