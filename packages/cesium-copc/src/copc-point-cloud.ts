import {
  BoundingSphere,
  BufferPoint,
  BufferPointCollection,
  BufferPointMaterial,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ComponentDatatype,
  type Clock,
  Intersect,
  Math as CesiumMath,
  Matrix4,
  OrientedBoundingBox,
  JulianDate,
  PrimitiveCollection,
  type Scene,
} from "cesium";
import {
  ancestorNodeId,
  CopcSource,
  boundsForNode,
  filterPointCloudNode,
  formatNodeId,
  type Bounds3,
  type HierarchyEntry,
  type NodeId,
  type PointCloudNode,
  type RangeReaderOptions,
} from "@copc-runtime/core";
import {
  LruCache,
  RequestQueue,
  resolveReadyLod,
  selectLod,
  type ViewState,
} from "@copc-runtime/runtime";
import { CopcDecodeWorkerPool } from "@copc-runtime/worker";
import {
  createCoordinateTransformer,
  type ToCartesian,
  type VerticalDatum,
} from "./coordinates.js";
import type { CopcPointFilter } from "./filter.js";
import { installGlobalPointSize, type GlobalPointSize } from "./global-point-size.js";

export interface CopcPointCloudOptions {
  readonly pointBudget?: number;
  readonly maximumScreenSpaceError?: number;
  readonly workerCount?: number;
  /** Maximum number of node fetch/decode pipelines in flight. */
  readonly requestConcurrency?: number;
  /** Set to false for environments where Web Workers are unavailable. */
  readonly useWorkers?: boolean;
  readonly pointSize?: number;
  /** Main-thread time allowed for incremental GPU collection builds per frame. */
  readonly uploadTimeBudgetMilliseconds?: number;
  /** Minimum projected viewport coverage before a higher-detail cohort is revealed. */
  readonly minimumRefinementCoverage?: number;
  readonly opacity?: number;
  readonly outlineWidth?: number;
  readonly outlineColor?: Color;
  readonly cacheSize?: number;
  readonly decodedCacheSize?: number;
  readonly colorBy?: CopcColorMode;
  readonly allowPicking?: boolean;
  readonly filter?: CopcPointFilter;
  readonly sourceCrs?: string;
  /** Vertical reference of source Z values. Defaults to no vertical correction. */
  readonly verticalDatum?: VerticalDatum;
  /** @deprecated Use verticalDatum. */
  readonly geoidModel?: "egm96" | "none";
  /** Additional vertical correction after CRS/geoid conversion, in meters. */
  readonly verticalOffsetMeters?: number;
  readonly dimensions?: readonly string[];
  readonly headers?: HeadersInit;
  readonly range?: Omit<RangeReaderOptions, "headers">;
}

export type CopcColorMode = "rgb" | "classification" | "intensity" | "elevation";

export interface CopcPointCloudStatistics {
  readonly visibleNodes: number;
  readonly visiblePoints: number;
  readonly loadedNodes: number;
  readonly decodedNodes: number;
  readonly decodedBytes: number;
  readonly gpuBytes: number;
  readonly workerDecodedNodes: number;
  readonly workerDecodeMilliseconds: number;
  readonly mainThreadBuildMilliseconds: number;
  readonly loadingNodes: number;
  readonly buildingNodes: number;
  readonly activeRequests: number;
  readonly pendingRequests: number;
  readonly networkRequests: number;
  readonly networkBytes: number;
  readonly networkMilliseconds: number;
  readonly logicalRangeRequests: number;
  readonly coalescedRangeRequests: number;
  readonly rangeCacheHits: number;
  readonly persistentRangeCacheHits: number;
  readonly compressedCacheBytes: number;
}

export interface CopcPickedPoint {
  readonly position: Cartesian3;
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly node: string;
  readonly index: number;
  readonly attributes: Readonly<Record<string, number>>;
}

export interface CopcClockBindingOptions {
  readonly start: JulianDate;
  readonly stop: JulianDate;
  readonly gpsStart: number;
  readonly gpsStop: number;
  readonly window?: number;
  readonly steps?: number;
}

interface RenderedNode {
  readonly collection: BufferPointCollection;
  readonly pointCount: number;
  /** Compact data represented by the GPU collection. */
  readonly data: PointCloudNode;
  /** Unfiltered decoded data retained for future filter variants. */
  readonly sourceData: PointCloudNode;
}

interface PreparedNode {
  readonly sourceData: PointCloudNode;
  readonly renderData: PointCloudNode;
  readonly filterGeneration: number;
}

interface CollectionBuild {
  readonly key: string;
  readonly sourceData: PointCloudNode;
  readonly renderData: PointCloudNode;
  readonly filterGeneration: number;
  readonly replaced?: RenderedNode;
  readonly collection: BufferPointCollection;
  readonly origin: Cartesian3;
  readonly worldPosition: Cartesian3;
  readonly localPosition: Cartesian3;
  readonly point: BufferPoint;
  readonly material: BufferPointMaterial;
  index: number;
}

interface CachedRenderedNode {
  readonly byteLength: number;
  readonly rendered: RenderedNode;
}

interface CachedDecodedNode {
  readonly byteLength: number;
  readonly data: PointCloudNode;
}

/** Minimal subset of Cesium's internal frame state used by custom primitives. */
interface CesiumFrameState {
  readonly camera: {
    readonly directionWC: Cartesian3;
    readonly positionWC: Cartesian3;
    readonly frustum: { readonly fovy?: number };
  };
  readonly context: { readonly drawingBufferHeight: number };
  readonly cullingVolume: {
    computeVisibility(boundingVolume: BoundingSphere): Intersect;
  };
}

interface UpdatablePrimitiveCollection extends PrimitiveCollection {
  update(frameState: CesiumFrameState): void;
}

export class CopcPointCloud {
  pointBudget: number;
  maximumScreenSpaceError: number;
  minimumRefinementCoverage: number;
  uploadTimeBudgetMilliseconds: number;
  show = true;

  readonly #source: CopcSource;
  readonly #root: HierarchyEntry;
  readonly #toCartesian: ToCartesian;
  readonly #dimensions: readonly string[];
  readonly #allowPicking: boolean;
  readonly #primitives = new PrimitiveCollection({ destroyPrimitives: true }) as UpdatablePrimitiveCollection;
  readonly #requests: RequestQueue;
  readonly #decoder: CopcDecodeWorkerPool | undefined;
  readonly #children = new Map<string, readonly HierarchyEntry[]>();
  readonly #hierarchyLoading = new Set<string>();
  readonly #nodeLoading = new Set<string>();
  readonly #nodeControllers = new Map<string, AbortController>();
  readonly #rendered = new Map<string, RenderedNode>();
  readonly #pointSizePending = new Set<BufferPointCollection>();
  readonly #filterPending = new Set<string>();
  readonly #filterLoading = new Map<string, AbortController>();
  readonly #collectionBuilds = new Map<string, CollectionBuild>();
  readonly #gpuCache: LruCache<string, CachedRenderedNode>;
  readonly #decodedCache: LruCache<string, CachedDecodedNode>;
  readonly #spheres = new Map<string, BoundingSphere>();
  readonly #boxes = new Map<string, OrientedBoundingBox>();
  #visibleNodes = 0;
  #visiblePoints = 0;
  #mainThreadBuildMilliseconds = 0;
  #lastError: unknown;
  readonly #pointSize: GlobalPointSize;
  #opacity: number;
  #outlineWidth: number;
  #outlineColor: Color;
  #colorBy: CopcColorMode;
  #filter: CopcPointFilter | undefined;
  #filterGeneration = 0;
  #detailDirection: Cartesian3 | undefined;
  #destroyed = false;
  #clockUnsubscribe: (() => void) | undefined;

  private constructor(
    source: CopcSource,
    root: HierarchyEntry,
    toCartesian: ToCartesian,
    decoder: CopcDecodeWorkerPool | undefined,
    options: CopcPointCloudOptions,
  ) {
    this.#source = source;
    this.#root = root;
    this.#toCartesian = toCartesian;
    this.#decoder = decoder;
    this.#dimensions = options.dimensions
      ?? ["Red", "Green", "Blue", "Intensity", "Classification", "GpsTime"];
    this.#allowPicking = options.allowPicking ?? true;
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 2;
    this.uploadTimeBudgetMilliseconds = nonNegativeFinite(
      options.uploadTimeBudgetMilliseconds ?? 2,
      "uploadTimeBudgetMilliseconds",
    );
    this.minimumRefinementCoverage = normalized(
      options.minimumRefinementCoverage ?? 0.4,
      "minimumRefinementCoverage",
    );
    this.#pointSize = { value: options.pointSize ?? 2 };
    this.#opacity = normalized(options.opacity ?? 1, "opacity");
    this.#outlineWidth = nonNegativeFinite(options.outlineWidth ?? 0, "outlineWidth");
    this.#outlineColor = Color.clone(options.outlineColor ?? Color.BLACK);
    this.#colorBy = options.colorBy ?? "rgb";
    this.#filter = options.filter;
    const gpuCacheSize = options.cacheSize ?? 512 * 1024 * 1024;
    this.#gpuCache = new LruCache(gpuCacheSize);
    this.#decodedCache = new LruCache(options.decodedCacheSize ?? Math.round(gpuCacheSize * 1.5));
    this.#requests = new RequestQueue(options.requestConcurrency ?? 8);
  }

  static async fromUrl(url: string, options: CopcPointCloudOptions = {}): Promise<CopcPointCloud> {
    const source = await CopcSource.fromUrl(url, {
      ...options.range,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
    let decoder: CopcDecodeWorkerPool | undefined;
    try {
      const metadata = await source.metadata();
      const sourceCrs = options.sourceCrs ?? metadata.crs;
      if (!sourceCrs) {
        throw new Error("COPC CRS is missing; pass sourceCrs in CopcPointCloudOptions");
      }
      const root = await source.root();
      const toCartesian = createCoordinateTransformer(sourceCrs, {
        ...(options.verticalDatum === undefined
          ? {}
          : { verticalDatum: options.verticalDatum }),
        ...(options.geoidModel === undefined ? {} : { geoidModel: options.geoidModel }),
        ...(options.verticalOffsetMeters === undefined
          ? {}
          : { verticalOffsetMeters: options.verticalOffsetMeters }),
      });
      decoder = options.useWorkers !== false && typeof Worker !== "undefined"
        ? await CopcDecodeWorkerPool.create({
            metadata: source.decodingMetadata(),
            ...(options.workerCount === undefined ? {} : { workerCount: options.workerCount }),
          })
        : undefined;
      const pointCloud = new CopcPointCloud(
        source,
        root,
        toCartesian,
        decoder,
        options,
      );
      pointCloud.#children.set(formatNodeId(root.id), await source.getHierarchy(root.id));
      pointCloud.#requestNode(root, Number.POSITIVE_INFINITY);
      return pointCloud;
    } catch (error) {
      decoder?.destroy();
      source.destroy();
      throw error;
    }
  }

  static validateUrl(url: string, options: Pick<CopcPointCloudOptions, "headers"> = {}) {
    return CopcSource.validateUrl(url, {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
  }

  get pointSize(): number { return this.#pointSize.value; }

  set pointSize(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("pointSize must be positive");
    this.#pointSize.value = value;
  }

  get opacity(): number { return this.#opacity; }

  set opacity(value: number) {
    this.#opacity = normalized(value, "opacity");
    for (const rendered of this.#rendered.values()) this.#applyColors(rendered);
  }

  get outlineWidth(): number { return this.#outlineWidth; }

  set outlineWidth(value: number) {
    this.#outlineWidth = nonNegativeFinite(value, "outlineWidth");
    this.#applyOutlineToAll();
  }

  get outlineColor(): Color { return Color.clone(this.#outlineColor); }

  set outlineColor(value: Color) {
    this.#outlineColor = Color.clone(value);
    this.#applyOutlineToAll();
  }

  get colorBy(): CopcColorMode { return this.#colorBy; }

  set colorBy(value: CopcColorMode) {
    this.#colorBy = value;
    for (const rendered of this.#rendered.values()) this.#applyColors(rendered);
  }

  get filter(): CopcPointFilter | undefined { return this.#filter; }

  set filter(value: CopcPointFilter | undefined) {
    this.#filter = value;
    this.#filterGeneration += 1;
    for (const controller of this.#filterLoading.values()) {
      controller.abort(new DOMException("Point filter changed", "AbortError"));
    }
    this.#filterLoading.clear();
    for (const build of this.#collectionBuilds.values()) build.collection.destroy();
    this.#collectionBuilds.clear();
    // Keep current GPU collections visible while compact replacements are
    // produced. Visible nodes are rebuilt before cached off-screen nodes.
    this.#filterPending.clear();
    for (const [key, rendered] of this.#rendered) {
      if (rendered.collection.show) this.#filterPending.add(key);
    }
    for (const [key, rendered] of this.#rendered) {
      if (!rendered.collection.show) this.#filterPending.add(key);
    }
  }

  update(frameState: CesiumFrameState): void {
    this.#assertAlive();
    this.#primitives.show = this.show;
    if (!this.show) {
      this.#primitives.update(frameState);
      return;
    }
    const view = this.#createViewState(frameState);
    this.#applyNextPendingFilter(view, frameState.camera);
    const selection = selectLod(
      this.#root,
      (id) => this.#children.get(formatNodeId(id)),
      view,
      {
        maximumScreenSpaceError: this.maximumScreenSpaceError,
        pointBudget: this.pointBudget,
        minimumRefinementCoverage: this.minimumRefinementCoverage,
      },
    );
    for (const node of selection.refinementRequested) this.#requestHierarchy(node);
    const prioritizedNodes = selection.selected.map((node) => ({
      node,
      priority: this.#priority(node, view, frameState.camera),
    })).sort((a, b) => b.priority - a.priority
      || formatNodeId(a.node.id).localeCompare(formatNodeId(b.node.id)));
    for (const { node, priority } of prioritizedNodes) {
      this.#requestNode(node, priority);
    }
    this.#processCollectionBuilds(view, frameState.camera);

    const retainedKeys = this.#ancestorKeys(selection.selected.map((node) => node.id));
    for (const key of retainedKeys) {
      this.#gpuCache.get(key);
      this.#decodedCache.get(key);
    }
    for (const [key, controller] of this.#nodeControllers) {
      if (!retainedKeys.has(key)) {
        controller.abort(new DOMException("Node is no longer visible", "AbortError"));
      }
    }
    for (const [key, build] of this.#collectionBuilds) {
      if (!retainedKeys.has(key) && build.replaced === undefined) this.#cancelCollectionBuild(key);
    }
    const visibleKeys = new Set(resolveReadyLod(
      this.#root.id,
      selection.selected.map((node) => node.id),
      (node) => this.#rendered.has(formatNodeId(node)),
      {
        minimumRefinementCoverage: this.minimumRefinementCoverage,
        weight: (node) => this.#projectedAreaWeight(node, frameState.camera),
      },
    ).map(formatNodeId));
    let visibleNodes = 0;
    let visiblePoints = 0;
    for (const [key, rendered] of this.#rendered) {
      const visible = visibleKeys.has(key);
      rendered.collection.show = visible;
      if (visible) {
        visibleNodes += 1;
        visiblePoints += rendered.pointCount;
      }
    }
    this.#visibleNodes = visibleNodes;
    this.#visiblePoints = visiblePoints;
    this.#primitives.update(frameState);
    for (const collection of this.#pointSizePending) {
      if (installGlobalPointSize(collection, frameState.context, this.#pointSize)) {
        this.#pointSizePending.delete(collection);
      }
    }
  }

  get statistics(): CopcPointCloudStatistics {
    const network = this.#source.statistics;
    const decoder = this.#decoder?.statistics;
    return {
      visibleNodes: this.#visibleNodes,
      visiblePoints: this.#visiblePoints,
      loadedNodes: this.#rendered.size,
      decodedNodes: this.#decodedCache.size,
      decodedBytes: this.#decodedCache.byteLength,
      gpuBytes: this.#gpuCache.byteLength,
      loadingNodes: this.#nodeLoading.size + this.#collectionBuilds.size + this.#filterLoading.size,
      buildingNodes: this.#collectionBuilds.size,
      activeRequests: this.#requests.activeCount,
      pendingRequests: this.#requests.pendingCount,
      workerDecodedNodes: decoder?.decodedNodes ?? 0,
      workerDecodeMilliseconds: decoder?.decodeMilliseconds ?? 0,
      mainThreadBuildMilliseconds: this.#mainThreadBuildMilliseconds,
      networkRequests: network.requests,
      networkBytes: network.bytesReceived,
      networkMilliseconds: network.networkMilliseconds,
      logicalRangeRequests: network.logicalRequests,
      coalescedRangeRequests: network.coalescedRequests,
      rangeCacheHits: network.cacheHits,
      persistentRangeCacheHits: network.persistentCacheHits,
      compressedCacheBytes: network.cachedBytes,
    };
  }

  get boundingSphere(): BoundingSphere { return this.#sphere(this.#root.bounds); }

  get lastError(): unknown { return this.#lastError; }

  /**
   * Temporarily prioritizes nodes along a viewport ray. Clear it to return to
   * the camera-center default. This affects request order, not LOD selection.
   */
  setDetailFocus(direction?: Cartesian3): void {
    this.#assertAlive();
    if (direction === undefined) {
      this.#detailDirection = undefined;
      return;
    }
    if (!Number.isFinite(direction.x)
      || !Number.isFinite(direction.y)
      || !Number.isFinite(direction.z)
      || Cartesian3.magnitudeSquared(direction) <= Number.EPSILON) {
      throw new RangeError("Detail focus direction must be finite and non-zero");
    }
    this.#detailDirection = Cartesian3.normalize(direction, new Cartesian3());
  }

  pick(scene: Scene, windowPosition: Cartesian2): CopcPickedPoint | undefined {
    this.#assertAlive();
    const picked = scene.pick(windowPosition) as { collection?: unknown; index?: unknown } | undefined;
    if (!picked || typeof picked.index !== "number") return undefined;
    for (const [key, rendered] of this.#rendered) {
      if (picked.collection !== rendered.collection) continue;
      const index = picked.index;
      if (!Number.isInteger(index) || index < 0 || index >= rendered.pointCount) return undefined;
      const data = rendered.data;
      const position = this.#toCartesian(
        data.positions[index * 3]!,
        data.positions[index * 3 + 1]!,
        data.positions[index * 3 + 2]!,
      );
      const cartographic = Cartographic.fromCartesian(position);
      const attributes: Record<string, number> = {};
      for (const [name, values] of Object.entries(data.attributes)) {
        attributes[name] = values[index]!;
      }
      return {
        position,
        longitude: CesiumMath.toDegrees(cartographic.longitude),
        latitude: CesiumMath.toDegrees(cartographic.latitude),
        height: cartographic.height,
        node: key,
        index,
        attributes,
      };
    }
    return undefined;
  }

  bindClock(clock: Clock, options: CopcClockBindingOptions): () => void {
    this.#assertAlive();
    const duration = JulianDate.secondsDifference(options.stop, options.start);
    if (duration <= 0 || options.gpsStop <= options.gpsStart) {
      throw new RangeError("Clock and GPS ranges must have increasing start and stop values");
    }
    if (options.window !== undefined && options.window <= 0) {
      throw new RangeError("GPS time window must be positive");
    }
    const steps = options.steps ?? 120;
    if (!Number.isInteger(steps) || steps <= 0) throw new RangeError("Clock steps must be positive");
    this.#clockUnsubscribe?.();
    let previousStep = -1;
    const update = (): void => {
      const fraction = Math.min(1, Math.max(
        0,
        JulianDate.secondsDifference(clock.currentTime, options.start) / duration,
      ));
      const step = Math.floor(fraction * steps);
      if (step === previousStep) return;
      previousStep = step;
      const gpsTime = options.gpsStart + fraction * (options.gpsStop - options.gpsStart);
      this.filter = {
        ...this.#filter,
        gpsTime: [
          options.window === undefined ? options.gpsStart : Math.max(options.gpsStart, gpsTime - options.window),
          gpsTime,
        ],
      };
    };
    const remove = clock.onTick.addEventListener(update);
    const unsubscribe = (): void => {
      remove();
      if (this.#clockUnsubscribe === unsubscribe) this.#clockUnsubscribe = undefined;
    };
    this.#clockUnsubscribe = unsubscribe;
    update();
    return unsubscribe;
  }

  isDestroyed(): boolean { return this.#destroyed; }

  destroy(): undefined {
    if (this.#destroyed) return undefined;
    this.#destroyed = true;
    this.#clockUnsubscribe?.();
    this.#requests.destroy();
    this.#decoder?.destroy();
    this.#source.destroy();
    this.#primitives.destroy();
    this.#rendered.clear();
    this.#pointSizePending.clear();
    this.#filterPending.clear();
    for (const controller of this.#filterLoading.values()) controller.abort();
    this.#filterLoading.clear();
    for (const build of this.#collectionBuilds.values()) build.collection.destroy();
    this.#collectionBuilds.clear();
    this.#gpuCache.clear();
    this.#decodedCache.clear();
    return undefined;
  }

  #requestHierarchy(node: HierarchyEntry): void {
    const key = formatNodeId(node.id);
    if (this.#children.has(key) || this.#hierarchyLoading.has(key)) return;
    this.#hierarchyLoading.add(key);
    void this.#source.getHierarchy(node.id).then((children) => {
      if (!this.#destroyed) this.#children.set(key, children);
    }).catch((error: unknown) => {
      this.#lastError = error;
    }).finally(() => this.#hierarchyLoading.delete(key));
  }

  #requestNode(node: HierarchyEntry, priority: number): void {
    const key = formatNodeId(node.id);
    if (this.#rendered.has(key)) return;
    if (this.#collectionBuilds.has(key)) return;
    if (this.#nodeLoading.has(key)) {
      this.#requests.reprioritize(key, priority);
      return;
    }
    const decoded = this.#decodedCache.get(key);
    // Preserve the zero-copy cache-hit path when no compact filter variant is
    // needed. This was the original fast path for revisiting nearby regions.
    if (decoded && this.#filter === undefined) {
      this.#scheduleCollectionBuild(
        key,
        decoded.data,
        decoded.data,
        this.#filterGeneration,
      );
      return;
    }
    this.#nodeLoading.add(key);
    const controller = new AbortController();
    this.#nodeControllers.set(key, controller);
    void this.#requests.add(
      async (signal) => {
        let sourceData = decoded?.data;
        if (!sourceData) {
          if (!this.#decoder) {
            sourceData = await this.#source.loadNode(node.id, this.#dimensions, signal);
          } else {
            const compressed = await this.#source.loadCompressedNode(node.id, signal);
            sourceData = await this.#decoder.decodeNode(compressed, this.#dimensions, signal);
          }
        }
        const filterGeneration = this.#filterGeneration;
        const renderData = await this.#prepareRenderData(sourceData, this.#filter, signal);
        return { sourceData, renderData, filterGeneration } satisfies PreparedNode;
      },
      { key, priority, signal: controller.signal },
    ).then(({ sourceData, renderData, filterGeneration }) => {
      if (this.#destroyed) return;
      const decodedEvictions = this.#decodedCache.set(key, {
        data: sourceData,
        byteLength: pointNodeByteLength(sourceData),
      });
      for (const [evictedKey] of decodedEvictions) this.#evictRendered(evictedKey);
      this.#scheduleCollectionBuild(key, sourceData, renderData, filterGeneration);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.#lastError = error;
    }).finally(() => {
      this.#nodeLoading.delete(key);
      this.#nodeControllers.delete(key);
    });
  }

  #evictRendered(key: string, removeFromGpuCache = true): void {
    const rendered = this.#rendered.get(key);
    if (!rendered) return;
    this.#rendered.delete(key);
    this.#filterPending.delete(key);
    this.#filterLoading.get(key)?.abort(new DOMException("Node evicted", "AbortError"));
    this.#filterLoading.delete(key);
    this.#cancelCollectionBuild(key);
    if (removeFromGpuCache) this.#gpuCache.delete(key);
    this.#pointSizePending.delete(rendered.collection);
    this.#primitives.remove(rendered.collection);
  }

  #createCollectionBuild(
    key: string,
    sourceData: PointCloudNode,
    renderData: PointCloudNode,
    filterGeneration: number,
    replaced?: RenderedNode,
  ): CollectionBuild {
    const bounds = boundsForNode(this.#root.bounds, renderData.id);
    const origin = this.#toCartesian(
      (bounds[0] + bounds[3]) / 2,
      (bounds[1] + bounds[4]) / 2,
      (bounds[2] + bounds[5]) / 2,
    );
    const collection = new BufferPointCollection({
      primitiveCountMax: Math.max(1, renderData.pointCount),
      positionDatatype: ComponentDatatype.FLOAT,
      modelMatrix: Matrix4.fromTranslation(origin),
      boundingVolume: this.#sphere(bounds),
      allowPicking: this.#allowPicking,
    });
    return {
      key,
      sourceData,
      renderData,
      filterGeneration,
      ...(replaced === undefined ? {} : { replaced }),
      collection,
      origin,
      worldPosition: new Cartesian3(),
      localPosition: new Cartesian3(),
      point: new BufferPoint(),
      material: new BufferPointMaterial({
        size: this.#pointSize.value,
        outlineWidth: this.#outlineWidth,
        outlineColor: this.#outlineColor,
      }),
      index: 0,
    };
  }

  #processCollectionBuilds(
    view: ViewState,
    camera: CesiumFrameState["camera"],
  ): void {
    if (this.#collectionBuilds.size === 0) return;
    const started = performance.now();
    const deadline = started + this.uploadTimeBudgetMilliseconds;
    try {
      while (this.#collectionBuilds.size > 0) {
        const build = this.#highestPriorityCollectionBuild(view, camera);
        if (!build) return;
        const node = build.renderData;
        while (build.index < node.pointCount) {
          const i = build.index;
          this.#toCartesian(
            node.positions[i * 3]!,
            node.positions[i * 3 + 1]!,
            node.positions[i * 3 + 2]!,
            build.worldPosition,
          );
          Cartesian3.subtract(build.worldPosition, build.origin, build.localPosition);
          build.material.color = this.#colorForPoint(node, i);
          build.collection.add({
            position: build.localPosition,
            material: build.material,
            show: true,
          }, build.point);
          build.index += 1;
          if ((build.index & 255) === 0 && performance.now() >= deadline) return;
        }
        this.#finishCollectionBuild(build);
        if (performance.now() >= deadline) return;
      }
    } finally {
      this.#mainThreadBuildMilliseconds += performance.now() - started;
    }
  }

  #highestPriorityCollectionBuild(
    view: ViewState,
    camera: CesiumFrameState["camera"],
  ): CollectionBuild | undefined {
    let selected: CollectionBuild | undefined;
    let selectedPriority = Number.NEGATIVE_INFINITY;
    for (const build of this.#collectionBuilds.values()) {
      const priority = this.#viewPriority(
        build.renderData,
        build.replaced?.collection.show ?? false,
        view,
        camera,
      );
      if (priority > selectedPriority) {
        selected = build;
        selectedPriority = priority;
      }
    }
    return selected;
  }

  #finishCollectionBuild(build: CollectionBuild): void {
    this.#collectionBuilds.delete(build.key);
    const current = build.replaced ?? this.#rendered.get(build.key);
    if (build.replaced === undefined && current) {
      build.collection.destroy();
      return;
    }
    if (build.replaced && current !== build.replaced) {
      build.collection.destroy();
      return;
    }
    if (build.replaced) build.collection.show = build.replaced.collection.show;
    this.#primitives.add(build.collection);
    this.#pointSizePending.add(build.collection);
    const rendered = {
      collection: build.collection,
      pointCount: build.renderData.pointCount,
      data: build.renderData,
      sourceData: build.sourceData,
    };
    this.#rendered.set(build.key, rendered);
    const evicted = this.#gpuCache.set(build.key, {
      rendered,
      byteLength: build.collection.byteLength,
    });
    if (build.replaced) {
      this.#pointSizePending.delete(build.replaced.collection);
      this.#primitives.remove(build.replaced.collection);
    }
    if (build.filterGeneration !== this.#filterGeneration) {
      this.#filterPending.add(build.key);
    }
    for (const [evictedKey] of evicted) this.#evictRendered(evictedKey, false);
  }

  #cancelCollectionBuild(key: string): void {
    const build = this.#collectionBuilds.get(key);
    if (!build) return;
    this.#collectionBuilds.delete(key);
    build.collection.destroy();
  }

  #scheduleCollectionBuild(
    key: string,
    sourceData: PointCloudNode,
    renderData: PointCloudNode,
    filterGeneration: number,
    replaced?: RenderedNode,
  ): void {
    this.#cancelCollectionBuild(key);
    this.#collectionBuilds.set(key, this.#createCollectionBuild(
      key,
      sourceData,
      renderData,
      filterGeneration,
      replaced,
    ));
  }

  #applyColors(rendered: RenderedNode): void {
    const point = new BufferPoint();
    const material = new BufferPointMaterial();
    for (let i = 0; i < rendered.pointCount; i += 1) {
      rendered.collection.get(i, point);
      point.getMaterial(material);
      material.color = this.#colorForPoint(rendered.data, i);
      point.setMaterial(material);
    }
  }

  #applyNextPendingFilter(
    view: ViewState,
    camera: CesiumFrameState["camera"],
  ): void {
    if (this.#filterLoading.size >= 2) return;
    let key: string | undefined;
    let selectedPriority = Number.NEGATIVE_INFINITY;
    for (const candidateKey of this.#filterPending) {
      const candidate = this.#rendered.get(candidateKey);
      if (!candidate) continue;
      const priority = this.#viewPriority(
        candidate.sourceData,
        candidate.collection.show,
        view,
        camera,
      );
      if (priority > selectedPriority) {
        key = candidateKey;
        selectedPriority = priority;
      }
    }
    if (key === undefined) return;
    this.#filterPending.delete(key);
    const rendered = this.#rendered.get(key);
    if (!rendered) return;
    const sourceData = rendered.sourceData;
    const generation = this.#filterGeneration;
    const controller = new AbortController();
    this.#filterLoading.set(key, controller);
    void this.#prepareRenderData(sourceData, this.#filter, controller.signal).then((renderData) => {
      if (this.#destroyed || generation !== this.#filterGeneration) return;
      const current = this.#rendered.get(key);
      if (!current || current.sourceData !== sourceData) return;
      this.#scheduleCollectionBuild(key, sourceData, renderData, generation, current);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.#lastError = error;
    }).finally(() => {
      if (this.#filterLoading.get(key) === controller) this.#filterLoading.delete(key);
    });
  }

  async #prepareRenderData(
    sourceData: PointCloudNode,
    filter: CopcPointFilter | undefined,
    signal?: AbortSignal,
  ): Promise<PointCloudNode> {
    if (!filter) return sourceData;
    if (this.#decoder) return this.#decoder.filterNode(sourceData, filter, signal);
    if (signal?.aborted) throw signal.reason;
    return filterPointCloudNode(sourceData, filter);
  }

  #viewPriority(
    node: PointCloudNode,
    currentlyShown: boolean,
    view: ViewState,
    camera: CesiumFrameState["camera"],
  ): number {
    const bounds = boundsForNode(this.#root.bounds, node.id);
    const visibilityRank = currentlyShown ? 2 : (view.isVisible(bounds) ? 1 : 0);
    const hierarchyNode: HierarchyEntry = {
      id: node.id,
      bounds,
      pointCount: node.pointCount,
      spacing: this.#root.spacing / 2 ** node.id.depth,
    };
    // The rank keeps current-view work ahead of cache maintenance. The normal
    // request priority then orders that group front-to-back around the focus ray.
    return visibilityRank * 1_000_000 + this.#priority(hierarchyNode, view, camera);
  }

  #applyOutlineToAll(): void {
    const point = new BufferPoint();
    const material = new BufferPointMaterial();
    for (const rendered of this.#rendered.values()) {
      for (let i = 0; i < rendered.pointCount; i += 1) {
        rendered.collection.get(i, point);
        point.getMaterial(material);
        material.outlineWidth = this.#outlineWidth;
        material.outlineColor = this.#outlineColor;
        point.setMaterial(material);
      }
    }
  }

  #colorForPoint(node: PointCloudNode, index: number): Color {
    switch (this.#colorBy) {
      case "classification": {
        const classification = node.attributes.Classification?.[index] ?? 0;
        return this.#withOpacity(classificationColor(classification));
      }
      case "intensity": {
        const intensity = node.attributes.Intensity?.[index] ?? 0;
        const value = Math.min(1, Math.max(0, intensity / 65_535));
        return this.#withOpacity(Color.fromHsl((1 - value) * 0.7, 1, 0.5));
      }
      case "elevation": {
        const height = node.positions[index * 3 + 2]!;
        const minimum = this.#root.bounds[2];
        const range = Math.max(this.#root.bounds[5] - minimum, Number.EPSILON);
        return this.#withOpacity(Color.fromHsl(
          (1 - Math.min(1, Math.max(0, (height - minimum) / range))) * 0.7,
          1,
          0.5,
        ));
      }
      case "rgb":
        return this.#withOpacity(node.colors
          ? Color.fromBytes(node.colors[index * 3]!, node.colors[index * 3 + 1]!, node.colors[index * 3 + 2]!)
          : Color.WHITE);
    }
  }

  #withOpacity(color: Color): Color {
    return Color.fromAlpha(color, color.alpha * this.#opacity);
  }

  #createViewState(frameState: CesiumFrameState): ViewState {
    const camera = frameState.camera;
    return {
      viewportHeight: frameState.context.drawingBufferHeight,
      verticalFieldOfView: camera.frustum.fovy ?? Math.PI / 3,
      isVisible: (bounds) => frameState.cullingVolume.computeVisibility(this.#sphere(bounds)) !== Intersect.OUTSIDE,
      distanceTo: (bounds) => Math.sqrt(this.#box(bounds).distanceSquaredTo(camera.positionWC)),
      screenWeight: (bounds) => this.#projectedBoundsWeight(bounds, camera),
      refinementWeight: (bounds) => this.#refinementWeight(bounds, camera),
    };
  }

  #sphere(bounds: Bounds3): BoundingSphere {
    const key = bounds.join(":");
    const cached = this.#spheres.get(key);
    if (cached) return cached;
    const points: Cartesian3[] = [];
    for (const x of [bounds[0], bounds[3]]) {
      for (const y of [bounds[1], bounds[4]]) {
        for (const z of [bounds[2], bounds[5]]) points.push(this.#toCartesian(x, y, z));
      }
    }
    const sphere = BoundingSphere.fromPoints(points);
    this.#spheres.set(key, sphere);
    return sphere;
  }

  #box(bounds: Bounds3): OrientedBoundingBox {
    const key = bounds.join(":");
    const cached = this.#boxes.get(key);
    if (cached) return cached;
    const points: Cartesian3[] = [];
    for (const x of [bounds[0], bounds[3]]) {
      for (const y of [bounds[1], bounds[4]]) {
        for (const z of [bounds[2], bounds[5]]) points.push(this.#toCartesian(x, y, z));
      }
    }
    const box = OrientedBoundingBox.fromPoints(points);
    this.#boxes.set(key, box);
    return box;
  }

  #ancestorKeys(nodes: readonly NodeId[]): Set<string> {
    const result = new Set<string>();
    for (const node of nodes) {
      for (let depth = this.#root.id.depth; depth <= node.depth; depth += 1) {
        result.add(formatNodeId(ancestorNodeId(node, depth)));
      }
    }
    return result;
  }

  #projectedAreaWeight(node: NodeId, camera: CesiumFrameState["camera"]): number {
    return this.#projectedBoundsWeight(boundsForNode(this.#root.bounds, node), camera);
  }

  #projectedBoundsWeight(bounds: Bounds3, camera: CesiumFrameState["camera"]): number {
    const sphere = this.#sphere(bounds);
    const centerDistance = Cartesian3.distance(camera.positionWC, sphere.center);
    const projectedRadius = sphere.radius / Math.max(centerDistance, sphere.radius, 1);
    const halfVerticalFov = Math.max((camera.frustum.fovy ?? Math.PI / 3) * 0.5, Number.EPSILON);
    const viewportRadius = projectedRadius / Math.tan(halfVerticalFov);
    return Math.min(1, Math.max(viewportRadius * viewportRadius, Number.EPSILON));
  }

  #refinementWeight(bounds: Bounds3, camera: CesiumFrameState["camera"]): number {
    const sphere = this.#sphere(bounds);
    const direction = this.#detailDirection ?? camera.directionWC;
    const towardNode = Cartesian3.subtract(
      sphere.center,
      camera.positionWC,
      refinementDirection,
    );
    const alongRay = Cartesian3.dot(towardNode, direction);
    if (alongRay <= 0) return 1;
    const perpendicularSquared = Math.max(
      0,
      Cartesian3.magnitudeSquared(towardNode) - alongRay * alongRay,
    );
    const normalizedSquared = perpendicularSquared
      / Math.max(sphere.radius * sphere.radius, Number.EPSILON);
    // A narrow boost follows the center/detail ray across fine octree cells.
    return 1 + 1.5 * Math.exp(-2 * normalizedSquared);
  }

  #priority(
    node: HierarchyEntry,
    view: ViewState,
    camera: CesiumFrameState["camera"],
  ): number {
    const sphere = this.#sphere(node.bounds);
    const towardNode = Cartesian3.subtract(sphere.center, camera.positionWC, priorityDirection);
    const magnitudeSquared = Cartesian3.magnitudeSquared(towardNode);
    const alignment = magnitudeSquared <= Number.EPSILON
      ? 1
      : Math.max(0, Cartesian3.dot(
          Cartesian3.normalize(towardNode, towardNode),
          camera.directionWC,
        ));
    const focusDirection = this.#detailDirection ?? camera.directionWC;
    const focusAlignment = magnitudeSquared <= Number.EPSILON
      ? 1
      : Math.max(0, Cartesian3.dot(
          Cartesian3.normalize(towardNode, towardNode),
          focusDirection,
        ));
    // Distance/SSE stays dominant in side views. Center bias only breaks ties
    // between similarly important nodes instead of pulling refinement forward.
    const centerWeight = 1 + 0.75 * alignment ** 8;
    const focusWeight = this.#detailDirection === undefined ? 1 : 1 + focusAlignment ** 24;
    return (node.spacing / Math.max(view.distanceTo(node.bounds), 1)) * centerWeight * focusWeight;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("CopcPointCloud has been destroyed");
  }
}

const priorityDirection = new Cartesian3();
const refinementDirection = new Cartesian3();

function pointNodeByteLength(node: PointCloudNode): number {
  let bytes = node.positions.byteLength + (node.colors?.byteLength ?? 0);
  for (const attribute of Object.values(node.attributes)) bytes += attribute.byteLength;
  return bytes;
}

const CLASSIFICATION_COLORS = new Map<number, Color>([
  [2, Color.fromCssColorString("#795548")],
  [3, Color.fromCssColorString("#8BC34A")],
  [4, Color.fromCssColorString("#4CAF50")],
  [5, Color.fromCssColorString("#1B5E20")],
  [6, Color.fromCssColorString("#F44336")],
  [9, Color.fromCssColorString("#2196F3")],
  [17, Color.fromCssColorString("#00BCD4")],
]);

function classificationColor(classification: number): Color {
  return CLASSIFICATION_COLORS.get(classification) ?? Color.LIGHTGRAY;
}

function normalized(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}
