export const INITIAL_TILE_FAILURE_THRESHOLD = 3;

export interface InitialTilesetLoadState {
  readonly fallbackStarted: boolean;
  readonly failureCount: number;
  readonly primaryContentLoaded: boolean;
}

export type InitialTilesetLoadEvent =
  | { readonly type: "tile-content-loaded"; readonly featuresLength: number }
  | { readonly type: "tile-failed" }
  | { readonly type: "timeout" };

export interface InitialTilesetLoadTransition {
  readonly shouldStartFallback: boolean;
  readonly state: InitialTilesetLoadState;
}

export function createInitialTilesetLoadState(): InitialTilesetLoadState {
  return {
    fallbackStarted: false,
    failureCount: 0,
    primaryContentLoaded: false,
  };
}

export function transitionInitialTilesetLoad(
  current: InitialTilesetLoadState,
  event: InitialTilesetLoadEvent,
): InitialTilesetLoadTransition {
  if (current.fallbackStarted || current.primaryContentLoaded) {
    return { shouldStartFallback: false, state: current };
  }

  if (event.type === "tile-content-loaded") {
    if (event.featuresLength <= 0) {
      return { shouldStartFallback: false, state: current };
    }
    return {
      shouldStartFallback: false,
      state: { ...current, primaryContentLoaded: true },
    };
  }

  if (event.type === "timeout") {
    return {
      shouldStartFallback: true,
      state: { ...current, fallbackStarted: true },
    };
  }

  const failureCount = current.failureCount + 1;
  const shouldStartFallback = failureCount >= INITIAL_TILE_FAILURE_THRESHOLD;
  return {
    shouldStartFallback,
    state: {
      ...current,
      failureCount,
      fallbackStarted: shouldStartFallback,
    },
  };
}
