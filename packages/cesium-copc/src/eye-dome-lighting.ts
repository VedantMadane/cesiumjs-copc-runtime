import { PostProcessStage, type Scene } from "cesium";

export interface CopcEyeDomeLightingOptions {
  /** Whether the stage runs. */
  readonly enabled?: boolean;
  /** Shading strength. A useful range is 0.5–3.0. */
  readonly strength?: number;
  /** Neighbor sampling distance in physical pixels. */
  readonly radius?: number;
}

const EYE_DOME_LIGHTING_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float strength;
uniform float radius;

in vec2 v_textureCoordinates;

float eyeDepth(vec2 uv) {
  float depth = czm_readDepth(depthTexture, uv);
  if (depth <= 0.0 || depth >= 1.0) {
    return 0.0;
  }
  vec2 windowPosition = czm_viewport.xy + uv * czm_viewport.zw;
  vec4 eye = czm_windowToEyeCoordinates(windowPosition, depth);
  return max(0.0, -eye.z / eye.w);
}

vec2 neighborContribution(float centerLogDepth, vec2 uv) {
  float neighbor = eyeDepth(uv);
  if (neighbor <= 0.0) {
    return vec2(0.0);
  }
  return vec2(max(0.0, centerLogDepth - log2(neighbor)), 1.0);
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  float center = eyeDepth(v_textureCoordinates);
  if (center <= 0.0) {
    out_FragColor = color;
    return;
  }

  vec2 offset = radius / czm_viewport.zw;
  float centerLogDepth = log2(center);
  vec2 responseAndCount = vec2(0.0);
  responseAndCount += neighborContribution(centerLogDepth, v_textureCoordinates + vec2(-offset.x, 0.0));
  responseAndCount += neighborContribution(centerLogDepth, v_textureCoordinates + vec2( offset.x, 0.0));
  responseAndCount += neighborContribution(centerLogDepth, v_textureCoordinates + vec2(0.0, -offset.y));
  responseAndCount += neighborContribution(centerLogDepth, v_textureCoordinates + vec2(0.0,  offset.y));

  float response = responseAndCount.y > 0.0
    ? responseAndCount.x / responseAndCount.y
    : 0.0;
  float shade = exp(-response * 300.0 * strength);
  out_FragColor = vec4(color.rgb * shade, color.a);
}
`;

/**
 * Cesium scene-depth EDL suitable for native BufferPointCollection point clouds.
 *
 * The post-process uses the complete scene depth texture, so terrain and other
 * opaque geometry are shaded at depth discontinuities as well as COPC points.
 */
export class CopcEyeDomeLighting {
  readonly #scene: Scene;
  readonly #stage: PostProcessStage;
  #strength: number;
  #radius: number;
  #destroyed = false;

  constructor(scene: Scene, options: CopcEyeDomeLightingOptions = {}) {
    this.#scene = scene;
    this.#strength = positiveFinite(options.strength ?? 1, "strength");
    this.#radius = positiveFinite(options.radius ?? 1, "radius");
    this.#stage = new PostProcessStage({
      name: "cesiumjs-copc-eye-dome-lighting",
      fragmentShader: EYE_DOME_LIGHTING_FRAGMENT_SHADER,
      uniforms: {
        strength: () => this.#strength,
        radius: () => this.#radius,
      },
    });
    this.#stage.enabled = options.enabled ?? true;
    scene.postProcessStages.add(this.#stage);
  }

  get enabled(): boolean { return this.#stage.enabled; }

  set enabled(value: boolean) {
    this.#assertAlive();
    this.#stage.enabled = value;
    this.#scene.requestRender();
  }

  get strength(): number { return this.#strength; }

  set strength(value: number) {
    this.#assertAlive();
    this.#strength = positiveFinite(value, "strength");
    this.#scene.requestRender();
  }

  get radius(): number { return this.#radius; }

  set radius(value: number) {
    this.#assertAlive();
    this.#radius = positiveFinite(value, "radius");
    this.#scene.requestRender();
  }

  isDestroyed(): boolean { return this.#destroyed; }

  destroy(): undefined {
    if (this.#destroyed) return undefined;
    this.#destroyed = true;
    if (this.#scene.postProcessStages.contains(this.#stage)) {
      this.#scene.postProcessStages.remove(this.#stage);
    } else if (!this.#stage.isDestroyed()) {
      this.#stage.destroy();
    }
    return undefined;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("CopcEyeDomeLighting has been destroyed");
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}
