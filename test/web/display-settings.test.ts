import { describe, expect, it } from "vitest";
import {
  createDefaultDisplaySettings,
  effectiveLighting,
  effectiveTerrain,
  isSceneModeSetting,
  shouldShowTextures,
} from "../../web/src/display-settings.ts";

const allCapabilities = { orthoImagery: true, terrain: true, textures: true };

describe("3D display settings", () => {
  it("starts in 3D with imagery and terrain, and without heavy textures or shadows", () => {
    expect(createDefaultDisplaySettings(allCapabilities)).toEqual({
      lighting: false,
      orthoImagery: true,
      sceneMode: "3d",
      terrain: true,
      textures: false,
    });
  });

  it("turns off features whose data source is not configured", () => {
    const settings = createDefaultDisplaySettings({
      orthoImagery: false,
      terrain: false,
      textures: false,
    });
    expect(settings.orthoImagery).toBe(false);
    expect(settings.terrain).toBe(false);
  });

  it("applies terrain and lighting only in 3D", () => {
    const settings = {
      ...createDefaultDisplaySettings(allCapabilities),
      lighting: true,
    };
    expect(effectiveTerrain(settings)).toBe(true);
    expect(effectiveLighting(settings)).toBe(true);

    settings.sceneMode = "2d";
    expect(effectiveTerrain(settings)).toBe(false);
    expect(effectiveLighting(settings)).toBe(false);
  });

  it("shows textures only for a textured tileset without an attribute colour mode", () => {
    expect(shouldShowTextures(true, "none")).toBe(true);
    expect(shouldShowTextures(true, "usage")).toBe(false);
    expect(shouldShowTextures(true, "floodDepth")).toBe(false);
    expect(shouldShowTextures(false, "none")).toBe(false);
  });

  it("accepts only supported scene modes", () => {
    expect(isSceneModeSetting("3d")).toBe(true);
    expect(isSceneModeSetting("2d")).toBe(true);
    expect(isSceneModeSetting("columbus")).toBe(false);
  });
});
