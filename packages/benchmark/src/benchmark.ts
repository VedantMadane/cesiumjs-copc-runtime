import { CopcSource, formatNodeId, type HierarchyEntry } from "@copc-runtime/core";

export interface BenchmarkOptions {
  readonly targetPoints?: number;
  readonly maximumNodes?: number;
  readonly concurrency?: number;
  readonly dimensions?: readonly string[];
}

export interface BenchmarkResult {
  readonly url: string;
  readonly fileBytes?: number;
  readonly totalPoints: number;
  readonly metadataMilliseconds: number;
  readonly hierarchyMilliseconds: number;
  readonly timeToFirstPointMilliseconds: number;
  readonly decodeMilliseconds: number;
  readonly decodedPoints: number;
  readonly decodedNodes: number;
  readonly pointsPerSecond: number;
  readonly networkRequests: number;
  readonly logicalRangeRequests: number;
  readonly coalescedRangeRequests: number;
  readonly rangeCacheHits: number;
  readonly persistentRangeCacheHits: number;
  readonly networkBytes: number;
  readonly compressedCacheBytes: number;
  readonly heapUsedBytes: number;
  readonly residentSetBytes: number;
  readonly deepestNode: string;
}

export async function benchmarkCopc(
  url: string,
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const targetPoints = options.targetPoints ?? 1_000_000;
  const maximumNodes = options.maximumNodes ?? 32;
  const concurrency = options.concurrency ?? 4;
  if (targetPoints <= 0 || maximumNodes <= 0 || concurrency <= 0) {
    throw new RangeError("Benchmark limits and concurrency must be positive");
  }

  const started = performance.now();
  const source = await CopcSource.fromUrl(url);
  try {
    const metadata = await source.metadata();
    const metadataFinished = performance.now();
    const nodes = await collectBenchmarkNodes(source, targetPoints, maximumNodes);
    const hierarchyFinished = performance.now();
    const dimensions = options.dimensions ?? ["Red", "Green", "Blue", "Intensity", "Classification"];
    const first = nodes[0];
    if (!first) throw new Error("COPC hierarchy does not contain a root node");
    const firstData = await source.loadNode(first.id, dimensions);
    const firstPointFinished = performance.now();
    const rest = await mapConcurrent(
      nodes.slice(1),
      concurrency,
      (node) => source.loadNode(node.id, dimensions),
    );
    const decodeFinished = performance.now();
    const decodedPoints = firstData.pointCount
      + rest.reduce((total, node) => total + node.pointCount, 0);
    const decodeMilliseconds = decodeFinished - hierarchyFinished;
    const memory = process.memoryUsage();
    const statistics = source.statistics;
    const deepest = nodes.reduce((best, node) => node.id.depth > best.id.depth ? node : best);
    return {
      url,
      ...(statistics.contentLength === undefined ? {} : { fileBytes: statistics.contentLength }),
      totalPoints: metadata.pointCount,
      metadataMilliseconds: metadataFinished - started,
      hierarchyMilliseconds: hierarchyFinished - metadataFinished,
      timeToFirstPointMilliseconds: firstPointFinished - started,
      decodeMilliseconds,
      decodedPoints,
      decodedNodes: nodes.length,
      pointsPerSecond: decodedPoints / Math.max(decodeMilliseconds / 1_000, Number.EPSILON),
      networkRequests: statistics.requests,
      logicalRangeRequests: statistics.logicalRequests,
      coalescedRangeRequests: statistics.coalescedRequests,
      rangeCacheHits: statistics.cacheHits,
      persistentRangeCacheHits: statistics.persistentCacheHits,
      networkBytes: statistics.bytesReceived,
      compressedCacheBytes: statistics.cachedBytes,
      heapUsedBytes: memory.heapUsed,
      residentSetBytes: memory.rss,
      deepestNode: formatNodeId(deepest.id),
    };
  } finally {
    source.destroy();
  }
}

async function collectBenchmarkNodes(
  source: CopcSource,
  targetPoints: number,
  maximumNodes: number,
): Promise<HierarchyEntry[]> {
  const root = await source.root();
  const queue = [root];
  const selected: HierarchyEntry[] = [];
  let pointCount = 0;
  while (queue.length > 0 && selected.length < maximumNodes && pointCount < targetPoints) {
    const node = queue.shift()!;
    selected.push(node);
    pointCount += node.pointCount;
    const children = await source.getHierarchy(node.id);
    queue.push(...[...children].sort((a, b) => b.pointCount - a.pointCount));
  }
  return selected;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await transform(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
