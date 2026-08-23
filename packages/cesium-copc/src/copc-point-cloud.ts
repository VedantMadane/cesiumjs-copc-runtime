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
  JulianDate,
  PrimitiveCollection,
  type Scene,
} from "cesium";
import {
  ancestorNodeId,
  CopcSource,
  boundsForNode,
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
import { createCoordinateTransformer, type ToCartesian } from "./coordinates.js";
import { matchesPointFilter, type CopcPointFilter } from "./filter.js";
import { installGlobalPointSize, type GlobalPointSize } from "./global-point-size.js";

export interface CopcPointCloudOptions {
  readonly pointBudget?: number;
  readonly maximumScreenSpaceError?: number;
  readonly workerCount?: number;
  /** Set to false for environments where Web Workers are unavailable. */
  readonly useWorkers?: boolean;
  readonly pointSize?: number;
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
  /** Geoid correction for orthometric source heights. Defaults to EGM96. */
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
  readonly loadingNodes: number;
  readonly networkRequests: number;
  readonly networkBytes: number;
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
  readonly data: PointCloudNode;
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
  readonly #gpuCache: LruCache<string, CachedRenderedNode>;
  readonly #decodedCache: LruCache<string, CachedDecodedNode>;
  readonly #spheres = new Map<string, BoundingSphere>();
  #visibleNodes = 0;
  #visiblePoints = 0;
  #lastError: unknown;
  readonly #pointSize: GlobalPointSize;
  #opacity: number;
  #outlineWidth: number;
  #outlineColor: Color;
  #colorBy: CopcColorMode;
  #filter: CopcPointFilter | undefined;
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
    this.#requests = new RequestQueue(options.workerCount ?? 4);
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
    for (const rendered of this.#rendered.values()) this.#applyFilter(rendered);
  }

  update(frameState: CesiumFrameState): void {
    this.#assertAlive();
    this.#primitives.show = this.show;
    if (!this.show) {
      this.#primitives.update(frameState);
      return;
    }
    const view = this.#createViewState(frameState);
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
      loadingNodes: this.#nodeLoading.size,
      workerDecodedNodes: decoder?.decodedNodes ?? 0,
      workerDecodeMilliseconds: decoder?.decodeMilliseconds ?? 0,
      networkRequests: network.requests,
      networkBytes: network.bytesReceived,
      logicalRangeRequests: network.logicalRequests,
      coalescedRangeRequests: network.coalescedRequests,
      rangeCacheHits: network.cacheHits,
      persistentRangeCacheHits: network.persistentCacheHits,
      compressedCacheBytes: network.cachedBytes,
    };
  }

  get boundingSphere(): BoundingSphere { return this.#sphere(this.#root.bounds); }

  get lastError(): unknown { return this.#lastError; }

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
    if (this.#nodeLoading.has(key)) {
      this.#requests.reprioritize(key, priority);
      return;
    }
    const decoded = this.#decodedCache.get(key);
    if (decoded) {
      this.#uploadNode(key, decoded.data);
      return;
    }
    this.#nodeLoading.add(key);
    const controller = new AbortController();
    this.#nodeControllers.set(key, controller);
    void this.#requests.add(
      async (signal) => {
        if (!this.#decoder) return this.#source.loadNode(node.id, this.#dimensions, signal);
        const compressed = await this.#source.loadCompressedNode(node.id, signal);
        return this.#decoder.decodeNode(compressed, this.#dimensions, signal);
      },
      { key, priority, signal: controller.signal },
    ).then((data) => {
      if (this.#destroyed) return;
      const decodedEvictions = this.#decodedCache.set(key, {
        data,
        byteLength: pointNodeByteLength(data),
      });
      for (const [evictedKey] of decodedEvictions) this.#evictRendered(evictedKey);
      this.#uploadNode(key, data);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.#lastError = error;
    }).finally(() => {
      this.#nodeLoading.delete(key);
      this.#nodeControllers.delete(key);
    });
  }

  #uploadNode(key: string, data: PointCloudNode): void {
    if (this.#rendered.has(key)) return;
    const collection = this.#createCollection(data);
    this.#primitives.add(collection);
    const rendered = { collection, pointCount: data.pointCount, data };
    this.#rendered.set(key, rendered);
    const evicted = this.#gpuCache.set(key, {
      rendered,
      byteLength: collection.byteLength,
    });
    for (const [evictedKey] of evicted) this.#evictRendered(evictedKey, false);
  }

  #evictRendered(key: string, removeFromGpuCache = true): void {
    const rendered = this.#rendered.get(key);
    if (!rendered) return;
    this.#rendered.delete(key);
    if (removeFromGpuCache) this.#gpuCache.delete(key);
    this.#pointSizePending.delete(rendered.collection);
    this.#primitives.remove(rendered.collection);
  }

  #createCollection(node: PointCloudNode): BufferPointCollection {
    const bounds = boundsForNode(this.#root.bounds, node.id);
    const origin = this.#toCartesian(
      (bounds[0] + bounds[3]) / 2,
      (bounds[1] + bounds[4]) / 2,
      (bounds[2] + bounds[5]) / 2,
    );
    const collection = new BufferPointCollection({
      primitiveCountMax: node.pointCount,
      positionDatatype: ComponentDatatype.FLOAT,
      modelMatrix: Matrix4.fromTranslation(origin),
      boundingVolume: this.#sphere(bounds),
      allowPicking: this.#allowPicking,
    });
    const worldPosition = new Cartesian3();
    const localPosition = new Cartesian3();
    const point = new BufferPoint();
    const material = new BufferPointMaterial({
      size: this.#pointSize.value,
      outlineWidth: this.#outlineWidth,
      outlineColor: this.#outlineColor,
    });
    for (let i = 0; i < node.pointCount; i += 1) {
      this.#toCartesian(
        node.positions[i * 3]!,
        node.positions[i * 3 + 1]!,
        node.positions[i * 3 + 2]!,
        worldPosition,
      );
      Cartesian3.subtract(worldPosition, origin, localPosition);
      material.color = this.#colorForPoint(node, i);
      collection.add({
        position: localPosition,
        material,
        show: matchesPointFilter(node, i, this.#filter),
      }, point);
    }
    this.#pointSizePending.add(collection);
    return collection;
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

  #applyFilter(rendered: RenderedNode): void {
    const point = new BufferPoint();
    for (let i = 0; i < rendered.pointCount; i += 1) {
      rendered.collection.get(i, point);
      point.show = matchesPointFilter(rendered.data, i, this.#filter);
    }
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
      distanceTo: (bounds) => Math.max(0, Cartesian3.distance(camera.positionWC, this.#sphere(bounds).center) - this.#sphere(bounds).radius),
      screenWeight: (bounds) => this.#projectedBoundsWeight(bounds, camera),
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
    const centerWeight = 1 + 4 * alignment ** 8;
    return (node.spacing / Math.max(view.distanceTo(node.bounds), 1)) * centerWeight;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("CopcPointCloud has been destroyed");
  }
}

const priorityDirection = new Cartesian3();

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
