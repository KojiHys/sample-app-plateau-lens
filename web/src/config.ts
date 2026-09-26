export interface RuntimeConfig {
  apiBaseUrl: string;
  awsRegion: string;
  cognitoDomain: string;
  fallbackTilesetUrl: string;
  /** XYZ template for aerial imagery. Empty disables the imagery layer. */
  orthoImageryUrl: string;
  redirectUri: string;
  /** XYZ template for the 10 m GSI DEM that fills gaps in the 5 m DEM. */
  terrainCoarseUrl: string;
  /** XYZ template for the 5 m GSI DEM. Empty disables terrain. */
  terrainFineUrl: string;
  /** Textured variant of tilesetUrl. Empty disables the texture toggle. */
  texturedTilesetUrl: string;
  tilesetUrl: string;
  userPoolClientId: string;
}

const DEFAULT_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-notexture-latest/tileset.json";
const DEFAULT_TEXTURED_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-texture-latest/tileset.json";
const DEFAULT_ORTHO_IMAGERY_URL =
  "https://api.plateauview.mlit.go.jp/tiles/plateau-ortho-2023/{z}/{x}/{y}.png";
const DEFAULT_TERRAIN_FINE_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png";
const DEFAULT_TERRAIN_COARSE_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png";

const defaults: RuntimeConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
  awsRegion: import.meta.env.VITE_AWS_REGION ?? "us-east-1",
  cognitoDomain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
  fallbackTilesetUrl: import.meta.env.VITE_FALLBACK_TILESET_URL ?? "",
  orthoImageryUrl: import.meta.env.VITE_ORTHO_IMAGERY_URL ?? DEFAULT_ORTHO_IMAGERY_URL,
  redirectUri: import.meta.env.VITE_REDIRECT_URI ?? window.location.origin + "/",
  terrainCoarseUrl: import.meta.env.VITE_TERRAIN_COARSE_URL ?? DEFAULT_TERRAIN_COARSE_URL,
  terrainFineUrl: import.meta.env.VITE_TERRAIN_FINE_URL ?? DEFAULT_TERRAIN_FINE_URL,
  texturedTilesetUrl:
    import.meta.env.VITE_TEXTURED_TILESET_URL ?? DEFAULT_TEXTURED_TILESET_URL,
  tilesetUrl: import.meta.env.VITE_TILESET_URL ?? DEFAULT_TILESET_URL,
  userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID ?? "",
};

function mergeConfig(candidate: unknown): RuntimeConfig {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return defaults;
  }

  const values = candidate as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      typeof values[key] === "string" ? values[key] : fallback,
    ]),
  ) as unknown as RuntimeConfig;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch("/runtime-config.json", { cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      return defaults;
    }
    return mergeConfig(await response.json());
  } catch {
    return defaults;
  }
}
