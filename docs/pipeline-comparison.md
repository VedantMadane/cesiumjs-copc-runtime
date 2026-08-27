# Direct COPC streaming compared with a 3D Tiles pipeline

This project claims that reading COPC directly is better than converting it to 3D
Tiles first. This document states what that claim is worth in numbers, and it is
explicit about which numbers were measured and which were not.

Every row below is tagged:

- **Measured** means this repository produced the number and the command is published.
- **Structural** means the number follows from how each pipeline is defined, so no
  measurement can change it.
- **Lower bound** means the number is derived from a measurement of this project and is
  the smallest value the other pipeline could possibly achieve.
- **Not measured** means we did not run it. No estimate is offered.

The reference dataset throughout is the public Autzen Stadium COPC used by
[the benchmark baseline](benchmarks.md): 10,653,336 points in 77.4 MiB.

## Summary

| Axis                                | 3D Tiles pipeline                     | This project        | Basis       |
| ----------------------------------- | ------------------------------------- | ------------------- | ----------- |
| Preprocessing before first view     | Full-dataset conversion required      | None                | Structural  |
| Floor on that conversion            | At least about 3 minutes 11 seconds   | 0 seconds           | Lower bound |
| Copies of the data to store         | 2 (source plus tileset)               | 1 (source)          | Structural  |
| Cost when the source is updated     | Reconvert the affected dataset        | None                | Structural  |
| Bytes to reach the benchmark view   | Not measured                          | 3,150,366 (3.9%)    | Measured    |
| Time to first point                 | Not measured                          | 2,477 ms            | Measured    |
| Source attributes kept for analysis | Only dimensions selected at conversion| All LAS dimensions  | Structural  |
| Coordinate precision for analysis   | Quantized at conversion               | Source `Float64`    | Structural  |

## Why the conversion floor is about 3 minutes

Any converter that produces 3D Tiles from this file has to decode all 10,653,336
points at least once. It cannot tile points it has not read. So the decode time for
the whole file is a floor on the conversion time, before octree construction, tile
serialization, and re-encoding are counted.

This project measured a median decode throughput of 55,875 points/s on the baseline
hardware:

```text
10,653,336 points / 55,875 points/s = 190.7 s = 3 min 11 s
```

Three cautions apply, and they all matter:

1. The 55,875 points/s median came from decoding 269,241 points, not the full file.
   Extrapolating a small sample to the whole file is approximate.
2. The measurement is single-threaded Node.js decoding. Production converters run in
   parallel and would beat this floor on multi-core hardware.
3. The observed three-run range was 27,365 to 76,670 points/s, which is wide.

So treat 3 minutes 11 seconds as an order-of-magnitude floor, not a benchmark of any
particular converter. The point that survives all three cautions is the shape of the
comparison: the conversion path pays a cost proportional to the entire dataset before
anyone sees a single point, and the streaming path pays a cost proportional to the
current view.

## Why storage is doubled

A 3D Tiles pipeline emits a tileset that is a second, separately stored representation
of the same points. The source file cannot be deleted, because it is the archival copy
and the input to any future reconversion. So both exist.

The tileset size is not reported here because it depends on the converter, the chosen
attributes, quantization settings, and the geometric error targets. We did not measure
it and will not guess. The structural claim stands regardless of its size: the
conversion path stores the data twice, and this project stores it once.

## Why the view cost scales with the view, not the dataset

The benchmark reached its target by transferring 3,150,366 bytes, which is 3.9% of the
77.4 MiB file, using 8 physical range requests coalesced from 11 logical ranges.
Nothing else was downloaded.

This is a property of COPC itself rather than of this implementation. The file is
already an octree addressed by byte ranges, so the client can request exactly the
hierarchy pages and node chunks the camera needs. A 3D Tiles pipeline reaches a
similar per-view transfer profile after conversion, which is precisely the cost this
project removes.

## What the conversion path gives up

Converting to 3D Tiles fixes two choices at conversion time that this project leaves
open at query time.

**Attributes.** The converter writes the dimensions it was configured to write. A
dimension that was not selected is unavailable in the viewer, and recovering it means
reconverting. This project reads dimensions from the source node on demand, so
`Intensity`, `Classification`, GPS time, and the rest stay reachable, including for
`cesiumjs-copc-analysis` queries that never render.

**Precision.** Tile formats quantize positions to keep tiles small. This project keeps
source `Float64` coordinates for picking and analysis and derives node-relative ECEF
`Float32` positions only for the GPU buffers, so rendering precision and analysis
precision are decoupled.

## Where the conversion path is still better

Stating the trade honestly matters more than winning every row.

- A prepared tileset needs no range support from the server. This project requires
  HTTP `206 Partial Content` and CORS, and fails on servers that provide neither.
- A prepared tileset can be tuned offline for a known camera path. Direct streaming
  decides the level of detail at runtime, so a cold view pays decode cost that a warm
  tileset does not.
- 3D Tiles is a published OGC standard with wide client support. This runtime targets
  CesiumJS specifically.
- Conversion happens once and is amortized across every future viewer session. For a
  dataset that is served constantly and never updated, that amortization is real.

The direct path wins when data changes, when storage is expensive, when the full
attribute set matters, or when the operational cost of a conversion step is the actual
problem. It loses when none of those hold.

## Reproducing the measured rows

```sh
npm ci
npm run build
npm run benchmark -- https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz 250000
```

Read [Benchmarks](benchmarks.md) for the hardware, the run protocol, and the
three-run ranges before comparing these numbers with another environment.

## What would make this document stronger

The honest gap is that no row measures an actual 3D Tiles conversion. Closing it means
running a real converter on the same file, on the same machine, and publishing the
wall-clock time, the output size, and the per-view transfer. That work is tracked in
[Issues](https://github.com/yangseungsang/cesiumjs-copc-runtime/issues) rather than
approximated here.
