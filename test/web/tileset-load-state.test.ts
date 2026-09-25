import { describe, expect, it } from "vitest";
import {
  createInitialTilesetLoadState,
  transitionInitialTilesetLoad,
} from "../../web/src/tileset-load-state.ts";

describe("initial primary tileset loading", () => {
  it("does not count a zero-feature wrapper as primary success", () => {
    const transition = transitionInitialTilesetLoad(
      createInitialTilesetLoadState(),
      { type: "tile-content-loaded", featuresLength: 0 },
    );

    expect(transition.shouldStartFallback).toBe(false);
    expect(transition.state.primaryContentLoaded).toBe(false);
  });

  it("keeps a wrapper eligible for timeout fallback", () => {
    const wrapper = transitionInitialTilesetLoad(
      createInitialTilesetLoadState(),
      { type: "tile-content-loaded", featuresLength: 0 },
    );
    const timeout = transitionInitialTilesetLoad(wrapper.state, { type: "timeout" });

    expect(timeout.shouldStartFallback).toBe(true);
    expect(timeout.state.fallbackStarted).toBe(true);
  });

  it("marks content with features as primary success", () => {
    const transition = transitionInitialTilesetLoad(
      createInitialTilesetLoadState(),
      { type: "tile-content-loaded", featuresLength: 1 },
    );

    expect(transition.shouldStartFallback).toBe(false);
    expect(transition.state.primaryContentLoaded).toBe(true);
  });

  it("waits for three failures before starting fallback", () => {
    const first = transitionInitialTilesetLoad(
      createInitialTilesetLoadState(),
      { type: "tile-failed" },
    );
    const second = transitionInitialTilesetLoad(first.state, { type: "tile-failed" });
    const third = transitionInitialTilesetLoad(second.state, { type: "tile-failed" });

    expect(first.shouldStartFallback).toBe(false);
    expect(second.shouldStartFallback).toBe(false);
    expect(third.shouldStartFallback).toBe(true);
    expect(third.state.failureCount).toBe(3);
  });

  it("never starts fallback after primary content succeeds", () => {
    const success = transitionInitialTilesetLoad(
      createInitialTilesetLoadState(),
      { type: "tile-content-loaded", featuresLength: 12 },
    );
    const failed = transitionInitialTilesetLoad(success.state, { type: "tile-failed" });
    const timedOut = transitionInitialTilesetLoad(failed.state, { type: "timeout" });

    expect(failed.shouldStartFallback).toBe(false);
    expect(timedOut.shouldStartFallback).toBe(false);
  });

  it("starts fallback only once when failure and timeout signals race", () => {
    let state = createInitialTilesetLoadState();
    state = transitionInitialTilesetLoad(state, { type: "tile-failed" }).state;
    state = transitionInitialTilesetLoad(state, { type: "tile-failed" }).state;
    const threshold = transitionInitialTilesetLoad(state, { type: "tile-failed" });
    const timeout = transitionInitialTilesetLoad(threshold.state, { type: "timeout" });
    const laterFailure = transitionInitialTilesetLoad(timeout.state, { type: "tile-failed" });

    expect(threshold.shouldStartFallback).toBe(true);
    expect(timeout.shouldStartFallback).toBe(false);
    expect(laterFailure.shouldStartFallback).toBe(false);
  });
});
