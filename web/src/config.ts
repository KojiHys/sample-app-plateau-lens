export interface RuntimeConfig {
  apiBaseUrl: string;
  awsRegion: string;
  cognitoDomain: string;
  fallbackTilesetUrl: string;
  redirectUri: string;
  tilesetUrl: string;
  userPoolClientId: string;
}

const DEFAULT_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-notexture-latest/tileset.json";

const defaults: RuntimeConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
  awsRegion: import.meta.env.VITE_AWS_REGION ?? "ap-northeast-1",
  cognitoDomain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
  fallbackTilesetUrl: import.meta.env.VITE_FALLBACK_TILESET_URL ?? "",
  redirectUri: import.meta.env.VITE_REDIRECT_URI ?? window.location.origin + "/",
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
