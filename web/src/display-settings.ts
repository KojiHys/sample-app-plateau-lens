import type { ColorMode } from "./view-state.ts";

export type SceneModeSetting = "3d" | "2d";

/**
 * Viewer presentation settings. These are intentionally not part of the
 * shared URL state or saved views, so existing links and stored views keep
 * their v1 schema.
 */
export interface DisplaySettings {
  lighting: boolean;
  orthoImagery: boolean;
  sceneMode: SceneModeSetting;
  terrain: boolean;
  textures: boolean;
}

export interface DisplayCapabilities {
  orthoImagery: boolean;
  terrain: boolean;
  textures: boolean;
}

/** Shadows and textures start off to keep the initial load light on participant PCs. */
export function createDefaultDisplaySettings(
  capabilities: DisplayCapabilities,
): DisplaySettings {
  return {
    lighting: false,
    orthoImagery: capabilities.orthoImagery,
    sceneMode: "3d",
    terrain: capabilities.terrain,
    textures: false,
  };
}

export function isSceneModeSetting(value: string): value is SceneModeSetting {
  return value === "3d" || value === "2d";
}

/**
 * Textures are visible only when the active tileset is textured and the user
 * has not chosen an attribute colour mode; colour modes replace textures.
 */
export function shouldShowTextures(texturedTilesetActive: boolean, colorMode: ColorMode): boolean {
  return texturedTilesetActive && colorMode === "none";
}

/** Terrain and lighting have no visible effect in 2D, so they are applied only in 3D. */
export function effectiveTerrain(settings: DisplaySettings): boolean {
  return settings.sceneMode === "3d" && settings.terrain;
}

export function effectiveLighting(settings: DisplaySettings): boolean {
  return settings.sceneMode === "3d" && settings.lighting;
}
