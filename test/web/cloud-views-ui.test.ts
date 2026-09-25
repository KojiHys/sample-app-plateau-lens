import { describe, expect, it } from "vitest";
import {
  createOptimisticSavedView,
  reconcileSavedViews,
} from "../../web/src/cloud-views-ui.ts";
import type { SavedViewSummary } from "../../web/src/views-api.ts";

const existingView: SavedViewSummary = {
  createdAt: "2024-01-01T00:00:00.000Z",
  title: "既存ビュー",
  viewId: "existing-view",
};

const optimisticView: SavedViewSummary = {
  createdAt: "2024-01-02T00:00:00.000Z",
  title: "新規ビュー",
  viewId: "new-view",
};

describe("cloud view list reconciliation", () => {
  it("creates an optimistic summary with an injected timestamp", () => {
    const item = createOptimisticSavedView(
      "入力したタイトル",
      "created-view",
      () => new Date("2024-02-03T04:05:06.789Z"),
    );

    expect(item).toEqual({
      createdAt: "2024-02-03T04:05:06.789Z",
      title: "入力したタイトル",
      viewId: "created-view",
    });
  });

  it("keeps a newly created view first while the server list is stale", () => {
    const result = reconcileSavedViews(
      [existingView],
      [optimisticView],
      new Set(),
    );

    expect(result.items).toEqual([optimisticView, existingView]);
    expect(result.pendingCreates).toEqual([optimisticView]);
  });

  it("uses the server item once a created view appears without duplicating it", () => {
    const serverVersion = {
      ...optimisticView,
      createdAt: "2024-01-02T00:00:01.000Z",
    };

    const result = reconcileSavedViews(
      [serverVersion, existingView],
      [optimisticView],
      new Set(),
    );

    expect(result.items).toEqual([serverVersion, existingView]);
    expect(result.pendingCreates).toEqual([]);
  });

  it("keeps successfully deleted views hidden from repeated stale server lists", () => {
    const deletedViewIds = new Set([existingView.viewId, optimisticView.viewId]);

    const firstResult = reconcileSavedViews(
      [existingView],
      [optimisticView],
      deletedViewIds,
    );
    const repeatedResult = reconcileSavedViews(
      [existingView],
      firstResult.pendingCreates,
      deletedViewIds,
    );

    expect(firstResult.items).toEqual([]);
    expect(firstResult.pendingCreates).toEqual([]);
    expect(repeatedResult.items).toEqual([]);
  });
});
