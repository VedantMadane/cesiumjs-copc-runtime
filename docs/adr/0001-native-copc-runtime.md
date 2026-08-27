# ADR-0001: Render COPC through a native runtime

- Status: Accepted
- Date: 2026-08-23

## Context

The project must visualize large COPC point clouds in CesiumJS without requiring an
offline conversion step. Two broad approaches were considered: generate 3D Tiles at
runtime, or maintain a native COPC hierarchy and render selected nodes as Cesium
primitives.

## Decision

Use a native COPC runtime. Read hierarchy and LAZ node chunks by byte range, select
nodes with a camera-aware scheduler, decode in Workers, and create Cesium GPU buffers
for ready nodes. Keep analysis attached to the same COPC source.

## Consequences

Benefits:

- no preprocessing or duplicate service copy;
- direct access to source attributes and coordinates;
- shared loading and cache infrastructure for rendering and analysis;
- COPC-native hierarchy, transfer, and decode diagnostics.

Costs:

- the project owns LOD, request scheduling, cache eviction, and GPU lifecycle;
- Cesium's experimental buffer point API requires compatibility attention;
- progressive refinement must avoid visible density discontinuities;
- Worker and WASM assets require packaging and bundler verification.

Runtime-generated 3D Tiles can be revisited for interoperability use cases, but it is
not the primary rendering path.
