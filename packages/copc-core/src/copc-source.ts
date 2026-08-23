import { Copc, Las, type Getter, type Hierarchy } from "copc";
import { ancestorNodeId, boundsForNode, childNodeIds, formatNodeId, parseNodeId } from "./node-id.js";
import { HttpRangeReader, type RangeDiagnostics, type RangeReaderOptions } from "./range-reader.js";
import { decodeCompressedPointNode, type CopcDecodingMetadata } from "./decoder.js";
import type {
  Bounds3,
  CompressedPointCloudNode,
  HierarchyEntry,
  NodeId,
  PointCloudMetadata,
  PointCloudNode,
  PointCloudSource,
} from "./types.js";

const DEFAULT_DIMENSIONS = ["X", "Y", "Z", "Red", "Green", "Blue"] as const;

export interface CopcSourceOptions extends RangeReaderOptions {
  readonly getter?: Getter;
}

export interface CopcUrlDiagnostics extends RangeDiagnostics {
  readonly copcValid: boolean;
  readonly corsReadable: boolean;
  readonly metadata?: PointCloudMetadata;
  readonly error?: string;
}

export class CopcSource implements PointCloudSource {
  readonly #input: Getter;
  readonly #reader: HttpRangeReader | undefined;
  #copc: Copc | undefined;
  #metadata: PointCloudMetadata | undefined;
  #nodes = new Map<string, Hierarchy.Node>();
  #pages = new Map<string, Hierarchy.Page>();
  #loadedPages = new Set<string>();
  #pageLoads = new Map<string, Promise<void>>();
  #destroyed = false;

  private constructor(url: string, options: CopcSourceOptions) {
    if (options.getter) {
      this.#input = options.getter;
    } else {
      this.#reader = new HttpRangeReader(url, options);
      this.#input = this.#reader.getter;
    }
  }

  static async fromUrl(url: string, options: CopcSourceOptions = {}): Promise<CopcSource> {
    const source = new CopcSource(url, options);
    await source.#initialize();
    return source;
  }

  static async validateUrl(
    url: string,
    options: RangeReaderOptions = {},
  ): Promise<CopcUrlDiagnostics> {
    const reader = new HttpRangeReader(url, options);
    let range: RangeDiagnostics;
    try {
      range = await reader.diagnose();
    } finally {
      reader.destroy();
    }
    if (!range.supportsRanges) {
      return {
        ...range,
        copcValid: false,
        corsReadable: true,
        error: "Server did not return 206 Partial Content for a byte range request",
      };
    }
    try {
      const source = await CopcSource.fromUrl(url, options);
      try {
        return {
          ...range,
          copcValid: true,
          corsReadable: true,
          metadata: await source.metadata(),
        };
      } finally {
        source.destroy();
      }
    } catch (error) {
      return {
        ...range,
        copcValid: false,
        corsReadable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #initialize(): Promise<void> {
    this.#assertAlive();
    const copc = await Copc.create(this.#input);
    this.#copc = copc;
    const rootBounds = copc.info.cube as Bounds3;
    this.#metadata = {
      bounds: rootBounds,
      spacing: copc.info.spacing,
      pointCount: copc.header.pointCount,
      pointDataRecordFormat: copc.header.pointDataRecordFormat,
      dimensions: Object.keys(Las.Dimensions.create(Las.Extractor.create(copc.header, copc.eb), copc.eb)),
      ...(copc.wkt === undefined ? {} : { crs: copc.wkt }),
      gpsTimeRange: copc.info.gpsTimeRange,
    };
    await this.#loadPage("0-0-0-0", copc.info.rootHierarchyPage);
  }

  async #loadPage(key: string, page: Hierarchy.Page): Promise<void> {
    const pageId = `${page.pageOffset}:${page.pageLength}`;
    if (this.#loadedPages.has(pageId)) return;
    const existing = this.#pageLoads.get(pageId);
    if (existing) return existing;
    const load = Copc.loadHierarchyPage(this.#input, page).then((subtree) => {
      for (const [nodeKey, node] of Object.entries(subtree.nodes)) {
        if (node) this.#nodes.set(nodeKey, node);
      }
      for (const [nodeKey, childPage] of Object.entries(subtree.pages)) {
        if (childPage) this.#pages.set(nodeKey, childPage);
      }
      this.#loadedPages.add(pageId);
      // A page is indexed by the node whose descendants it contains.
      this.#pages.delete(key);
    }).finally(() => this.#pageLoads.delete(pageId));
    this.#pageLoads.set(pageId, load);
    return load;
  }

  async metadata(): Promise<PointCloudMetadata> {
    this.#assertAlive();
    return this.#metadata!;
  }

  async root(): Promise<HierarchyEntry> {
    this.#assertAlive();
    return this.#entry(parseNodeId("0-0-0-0"));
  }

  async getHierarchy(node: NodeId): Promise<readonly HierarchyEntry[]> {
    this.#assertAlive();
    const key = formatNodeId(node);
    const children = childNodeIds(node);
    // A hierarchy page placeholder may replace either the requested node or
    // one of its immediate children, depending on where the page boundary fell.
    for (const candidate of [node, ...children]) {
      const candidateKey = formatNodeId(candidate);
      const page = this.#pages.get(candidateKey);
      if (page) await this.#loadPage(candidateKey, page);
    }
    return children
      .filter((child) => this.#nodes.has(formatNodeId(child)))
      .map((child) => this.#entry(child));
  }

  async loadNode(
    id: NodeId,
    dimensions: readonly string[] = DEFAULT_DIMENSIONS,
    signal?: AbortSignal,
  ): Promise<PointCloudNode> {
    const compressed = await this.loadCompressedNode(id, signal);
    return decodeCompressedPointNode(this.decodingMetadata(), compressed, dimensions, signal);
  }

  async loadCompressedNode(
    id: NodeId,
    signal?: AbortSignal,
  ): Promise<CompressedPointCloudNode> {
    this.#assertAlive();
    signal?.throwIfAborted();
    const key = formatNodeId(id);
    const node = await this.#resolveNode(id, signal);
    if (!node) throw new Error(`COPC hierarchy node not found: ${key}`);
    const bytes = await Copc.loadCompressedPointDataBuffer(
      this.#inputForSignal(signal),
      node,
    );
    signal?.throwIfAborted();
    return {
      id,
      pointCount: node.pointCount,
      bytes,
    };
  }

  decodingMetadata(): CopcDecodingMetadata {
    this.#assertAlive();
    const copc = this.#copc!;
    return {
      header: {
        pointDataRecordFormat: copc.header.pointDataRecordFormat,
        pointDataRecordLength: copc.header.pointDataRecordLength,
        scale: copc.header.scale,
        offset: copc.header.offset,
      },
      extraBytes: copc.eb,
    };
  }

  async diagnose(): Promise<RangeDiagnostics | undefined> {
    return this.#reader?.diagnose();
  }

  get statistics(): {
    requests: number;
    logicalRequests: number;
    cacheHits: number;
    persistentCacheHits: number;
    coalescedRequests: number;
    bytesReceived: number;
    networkMilliseconds: number;
    cachedBytes: number;
    contentLength?: number;
  } {
    const contentLength = this.#reader?.contentLength;
    return {
      requests: this.#reader?.requestCount ?? 0,
      logicalRequests: this.#reader?.logicalRequestCount ?? 0,
      cacheHits: this.#reader?.cacheHitCount ?? 0,
      persistentCacheHits: this.#reader?.persistentCacheHitCount ?? 0,
      coalescedRequests: this.#reader?.coalescedRequestCount ?? 0,
      bytesReceived: this.#reader?.bytesReceived ?? 0,
      networkMilliseconds: this.#reader?.networkMilliseconds ?? 0,
      cachedBytes: this.#reader?.cachedBytes ?? 0,
      ...(contentLength === undefined ? {} : { contentLength }),
    };
  }

  #entry(id: NodeId): HierarchyEntry {
    const node = this.#nodes.get(formatNodeId(id));
    if (!node) throw new Error(`COPC hierarchy node not found: ${formatNodeId(id)}`);
    return {
      id,
      pointCount: node.pointCount,
      bounds: boundsForNode(this.#metadata!.bounds, id),
      spacing: this.#metadata!.spacing / 2 ** id.depth,
    };
  }

  async #resolveNode(id: NodeId, signal?: AbortSignal): Promise<Hierarchy.Node | undefined> {
    const key = formatNodeId(id);
    let node = this.#nodes.get(key);
    if (!node) {
      for (let depth = 0; depth < id.depth && !node; depth += 1) {
        await this.getHierarchy(ancestorNodeId(id, depth));
        signal?.throwIfAborted();
        node = this.#nodes.get(key);
      }
    }
    return node;
  }

  #inputForSignal(signal?: AbortSignal): Getter {
    if (!signal) return this.#input;
    if (this.#reader) return this.#reader.getterForSignal(signal);
    return async (begin, end) => {
      signal.throwIfAborted();
      const bytes = await this.#input(begin, end);
      signal.throwIfAborted();
      return bytes;
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#reader?.destroy();
    this.#nodes.clear();
    this.#pages.clear();
    this.#pageLoads.clear();
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("COPC source has been destroyed");
  }
}
