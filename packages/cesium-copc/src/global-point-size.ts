import {
  BufferPointCollection,
  ComponentDatatype,
  // These renderer types are exported at runtime but omitted from Cesium's
  // public TypeScript declarations because they are internal APIs.
  // @ts-expect-error Cesium renderer API has no public declaration.
  ShaderProgram,
  // @ts-expect-error Cesium renderer API has no public declaration.
  ShaderSource,
} from "cesium";

export interface GlobalPointSize {
  value: number;
}

interface DestroyableShaderProgram {
  destroy(): void;
}

interface PointDrawCommand {
  shaderProgram: unknown;
  uniformMap: Record<string, () => number> | undefined;
}

interface PointRenderContext {
  shaderProgram?: DestroyableShaderProgram;
  command?: PointDrawCommand;
  globalPointSize?: GlobalPointSize;
}

interface BufferPointCollectionInternals extends BufferPointCollection {
  _renderContext: PointRenderContext | null;
}

const attributeLocationsFloat64 = {
  positionHigh: 0,
  positionLow: 1,
  pickColor: 2,
  showSizeColorAlpha: 3,
  outlineWidthColorAlpha: 4,
};

const attributeLocationsFloat32 = {
  position: 0,
  pickColor: 1,
  showSizeColorAlpha: 2,
  outlineWidthColorAlpha: 3,
};

const vertexShader = `
#ifdef USE_FLOAT64
in vec3 positionHigh;
in vec3 positionLow;
#else
in vec3 position;
#endif
in vec4 pickColor;
in vec4 showPixelSizeColorAlpha;
in vec3 outlineWidthColorAlpha;

uniform float u_pointSize;

out vec4 v_pickColor;
out vec4 v_color;
out vec4 v_outlineColor;
out float v_innerRadiusFrac;

void main()
{
    float show = showPixelSizeColorAlpha.x;
    vec4 color = czm_decodeRGB8(showPixelSizeColorAlpha.z);
    float alpha = showPixelSizeColorAlpha.w;
    float outlineWidth = outlineWidthColorAlpha.x;
    vec4 outlineColor = czm_decodeRGB8(outlineWidthColorAlpha.y);
    float outlineAlpha = outlineWidthColorAlpha.z;

    float innerRadius = 0.5 * u_pointSize * czm_pixelRatio;
    float outerRadius = (0.5 * u_pointSize + outlineWidth) * czm_pixelRatio;

#ifdef USE_FLOAT64
    vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
    vec4 positionEC = czm_modelViewRelativeToEye * p;
#else
    vec4 positionEC = czm_modelView * vec4(position, 1.0);
#endif

    gl_Position = czm_projection * positionEC;
    czm_vertexLogDepth();

    v_pickColor = pickColor / 255.0;
    v_color = color;
    v_color.a *= alpha * show;
    v_outlineColor = outlineColor;
    v_outlineColor.a *= outlineAlpha * show;
    v_innerRadiusFrac = innerRadius / outerRadius;

    gl_PointSize = 2.0 * outerRadius * show;
    gl_Position *= show;
}
`;

const fragmentShader = `
in vec4 v_pickColor;
in vec4 v_color;
in vec4 v_outlineColor;
in float v_innerRadiusFrac;

void main()
{
    float distanceToCenter = length(gl_PointCoord - vec2(0.5));
    float delta = fwidth(distanceToCenter);
    float outerLimit = 0.5;
    float innerLimit = 0.5 * v_innerRadiusFrac;
    float outerAlpha = 1.0 - smoothstep(max(0.0, outerLimit - delta), outerLimit, distanceToCenter);
    float innerAlpha = 1.0 - smoothstep(innerLimit - delta, innerLimit, distanceToCenter);

    vec4 color = vec4(mix(v_outlineColor.rgb, v_color.rgb, innerAlpha), outerAlpha);
    color.a *= mix(v_outlineColor.a, v_color.a, innerAlpha);
    if (color.a < 0.005) {
        discard;
    }

    out_FragColor = czm_gammaCorrect(color);
    czm_writeLogDepth();
}
`;

/** Replaces Cesium's per-point size attribute with one shared shader uniform. */
export function installGlobalPointSize(
  collection: BufferPointCollection,
  context: unknown,
  pointSize: GlobalPointSize,
): boolean {
  const internals = collection as BufferPointCollectionInternals;
  const renderContext = internals._renderContext;
  if (!renderContext?.command) return false;
  if (renderContext.globalPointSize === pointSize) return true;

  const useFloat64 = collection.positionDatatype === ComponentDatatype.DOUBLE;
  const shaderProgram = ShaderProgram.fromCache({
    context,
    vertexShaderSource: new ShaderSource({
      sources: [vertexShader],
      defines: useFloat64 ? ["USE_FLOAT64"] : [],
    }),
    fragmentShaderSource: new ShaderSource({ sources: [fragmentShader] }),
    attributeLocations: useFloat64 ? attributeLocationsFloat64 : attributeLocationsFloat32,
  }) as DestroyableShaderProgram;

  const previousShaderProgram = renderContext.shaderProgram;
  renderContext.shaderProgram = shaderProgram;
  renderContext.command.shaderProgram = shaderProgram;
  renderContext.command.uniformMap = {
    u_pointSize: () => pointSize.value,
  };
  renderContext.globalPointSize = pointSize;
  previousShaderProgram?.destroy();
  return true;
}
