import { describe, expect, it } from "vitest";
import { TILESET_RANGES } from "../../web/src/cesium/attributes.ts";
import {
  applyVerticalEvacuationPreset,
  cloneFilterState,
  createDefaultFilterState,
  decodeViewState,
  encodeViewState,
  isValidCameraState,
  type CameraState,
} from "../../web/src/view-state.ts";

const camera: CameraState = {
  destination: {
    height: 1_250.5,
    latitudeDegrees: 35.681,
    longitudeDegrees: 139.767,
  },
  orientation: {
    heading: 1.2,
    pitch: -0.7,
    roll: 0,
  },
};

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("filter state", () => {
  it("starts with all four measured ranges and no exclusions", () => {
    expect(createDefaultFilterState()).toEqual({
      categoryExclusions: { districtsAndZones: [], usage: [] },
      colorMode: "none",
      numeric: {
        floodDepth: { min: TILESET_RANGES.floodDepth.min, max: TILESET_RANGES.floodDepth.max },
        height: { min: TILESET_RANGES.height.min, max: TILESET_RANGES.height.max },
        roofArea: { min: TILESET_RANGES.roofArea.min, max: TILESET_RANGES.roofArea.max },
        storeysAboveGround: {
          min: TILESET_RANGES.storeysAboveGround.min,
          max: TILESET_RANGES.storeysAboveGround.max,
        },
      },
    });
  });

  it("applies the vertical-evacuation preset without mutating other filters", () => {
    const initial = createDefaultFilterState();
    initial.numeric.height = { min: 20, max: 80 };
    initial.categoryExclusions.usage = ["住宅"];
    const before = cloneFilterState(initial);

    const preset = applyVerticalEvacuationPreset(initial);

    expect(initial).toEqual(before);
    expect(preset.numeric.floodDepth).toEqual({ min: 0.5, max: 3.42 });
    expect(preset.numeric.storeysAboveGround).toEqual({ min: 4, max: 44 });
    expect(preset.numeric.roofArea).toEqual({ min: 1_000, max: 22_322.6 });
    expect(preset.numeric.height).toEqual({ min: 20, max: 80 });
    expect(preset.categoryExclusions.usage).toEqual(["住宅"]);
    expect(preset.colorMode).toBe("floodDepth");
  });
});

describe("view-state URL codec", () => {
  it("round-trips Japanese typed categories, filters, and camera as base64url", () => {
    const filter = createDefaultFilterState();
    filter.numeric.height = { min: 10.5, max: 120.2 };
    filter.categoryExclusions.usage = ["業務施設", 401, true];
    filter.categoryExclusions.districtsAndZones = ["商業地域"];
    filter.colorMode = "usage";

    const encoded = encodeViewState({ camera, filter });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeViewState(encoded)).toEqual({ camera, filter });
  });

  it("round-trips a state before the camera is available", () => {
    const filter = createDefaultFilterState();
    expect(decodeViewState(encodeViewState({ camera: null, filter }))).toEqual({
      camera: null,
      filter,
    });
  });

  it("rejects malformed, unknown-version, and invalid-range payloads", () => {
    expect(decodeViewState("not+base64")) .toBeNull();
    expect(decodeViewState(encodeRaw({ v: 2, camera: null, filter: {} }))).toBeNull();

    const filter = createDefaultFilterState();
    filter.numeric.height = { min: 100, max: 10 };
    expect(decodeViewState(encodeRaw({ v: 1, camera: null, filter }))).toBeNull();
  });

  it("rejects invalid camera coordinates instead of partially restoring them", () => {
    const invalidCamera = {
      ...camera,
      destination: { ...camera.destination, latitudeDegrees: 120 },
    };
    expect(isValidCameraState(invalidCamera)).toBe(false);
    expect(
      decodeViewState(
        encodeRaw({
          v: 1,
          camera: invalidCamera,
          filter: createDefaultFilterState(),
        }),
      ),
    ).toBeNull();
  });

  it("never emits a URL state that its own camera validator rejects", () => {
    const filter = createDefaultFilterState();
    const unreachableCamera = {
      ...camera,
      destination: { ...camera.destination, height: 10_000_001 },
    };

    expect(decodeViewState(encodeViewState({ camera: unreachableCamera, filter }))).toEqual({
      camera: null,
      filter,
    });
  });
});
