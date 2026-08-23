import { describe, expect, it } from "vitest";
import { PostProcessStage, type Scene } from "cesium";
import { CopcEyeDomeLighting } from "./eye-dome-lighting.js";

function sceneStub() {
  let stage: PostProcessStage | undefined;
  let renderRequests = 0;
  const scene = {
    postProcessStages: {
      add(value: PostProcessStage) {
        stage = value;
        return value;
      },
      contains(value: PostProcessStage) {
        return stage === value;
      },
      remove(value: PostProcessStage) {
        if (stage !== value) return false;
        stage = undefined;
        value.destroy();
        return true;
      },
    },
    requestRender() { renderRequests += 1; },
  } as unknown as Scene;
  return {
    scene,
    stage: () => stage,
    renderRequests: () => renderRequests,
  };
}

describe("CopcEyeDomeLighting", () => {
  it("registers a configurable scene-depth post-process stage", () => {
    const stub = sceneStub();
    const edl = new CopcEyeDomeLighting(stub.scene, {
      enabled: false,
      radius: 1.5,
      strength: 2,
    });

    expect(stub.stage()).toBeInstanceOf(PostProcessStage);
    expect(edl.enabled).toBe(false);
    expect(edl.radius).toBe(1.5);
    expect(edl.strength).toBe(2);

    edl.enabled = true;
    edl.radius = 2;
    edl.strength = 0.75;
    expect(stub.renderRequests()).toBe(3);
    expect(edl.enabled).toBe(true);
    expect(edl.radius).toBe(2);
    expect(edl.strength).toBe(0.75);

    edl.destroy();
    expect(edl.isDestroyed()).toBe(true);
    expect(stub.stage()).toBeUndefined();
  });

  it("rejects invalid sampling parameters", () => {
    const stub = sceneStub();
    expect(() => new CopcEyeDomeLighting(stub.scene, { radius: 0 })).toThrow(RangeError);
    expect(() => new CopcEyeDomeLighting(stub.scene, { strength: Number.NaN })).toThrow(RangeError);
  });
});
