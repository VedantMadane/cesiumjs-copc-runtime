# Benchmarks

Benchmarks are published as reproducible observations, not universal performance
claims. Network location, server behavior, CPU, selected dimensions, cache state, and
runtime options materially affect results.

## Run the benchmark

```sh
npm ci
npm run build
npm run benchmark -- https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz 250000
```

Run from a cold process. Record the commit, Node version, operating system, CPU,
network location, URL, target points, and whether an intermediary cache is present.
The CLI prints a table and machine-readable JSON.

## Current baseline

Measured on 2026-08-27 using three cold Node.js processes and a 250,000-point target:

- MacBook Pro, Apple M1 Pro (8 cores), 16 GiB memory
- Node.js 22.17.0 and npm 10.9.2
- public Autzen Stadium COPC hosted on Amazon S3
- network location and transient S3/cache conditions were not controlled

| Metric                  | Median or stable result |        Three-run range |
| ----------------------- | ----------------------: | ---------------------: |
| Dataset                 |       10,653,336 points |                 stable |
| File size               |                77.4 MiB |                 stable |
| Metadata load           |                1,376 ms |         1,298–1,493 ms |
| Time to first point     |                2,477 ms |         2,223–3,523 ms |
| Decoded nodes           |                       8 |                 stable |
| Decoded points          |                 269,241 |                 stable |
| Network transfer        |         3,150,366 bytes |                 stable |
| Physical range requests |                       8 |                 stable |
| Logical ranges          |                      11 |                 stable |
| Coalesced ranges        |                       3 |                 stable |
| Decode throughput       |         55,875 points/s | 27,365–76,670 points/s |
| Heap used               |          about 11.5 MiB |          11.4–12.6 MiB |
| Resident memory         |         about 120.0 MiB |        119.3–120.5 MiB |

Each run accumulated nodes from different octree depths and did not download the full
file. Approximately 3.9% of the file bytes were transferred for the target. The wide
decode-throughput range is reported instead of hidden; more controlled repetitions are
required before using the median as a cross-machine comparison.

## What the CLI measures

- metadata load duration;
- hierarchy traversal duration;
- time to first decoded point;
- decoded nodes and points;
- decode throughput;
- physical, logical, coalesced, and cached range counts;
- network and compressed-cache bytes;
- Node.js heap and resident memory.

## Browser benchmark protocol

For viewer comparisons, use the same viewport, camera path, source URL, cold-cache
state, dimensions, point budget, and screen-space error. Report at least three runs
and include median and p95 where possible.

Required browser metrics:

- time to first point and first meaningful view;
- bytes transferred until the view stabilizes;
- median and p95 frame time;
- visible points and nodes;
- peak JS heap and estimated GPU buffer bytes;
- stabilization time after a fixed camera move.

## Comparison rules

Compare equivalent outcomes, not only configuration names. A viewer that renders a
different point count or refinement level is not a like-for-like result. Document
preprocessing and duplicate storage separately when comparing with a 3D Tiles
pipeline. Do not combine cached and uncached runs in one summary.

## Known gaps

The published baseline covers remote transfer and Node decode. Repeatable WebGL FPS,
time-to-first-meaningful-view, GPU memory, 1–2 GiB datasets, and long-duration camera
paths remain future benchmark work. These limitations are stated to prevent the
baseline from being interpreted more broadly than the data supports.
