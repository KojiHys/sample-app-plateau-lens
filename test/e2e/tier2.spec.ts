import { expect, test, type Page, type Route } from "@playwright/test";
import { createDefaultFilterState, type CameraState } from "../../web/src/view-state.ts";

const VIEW_ID = "123e4567-e89b-42d3-a456-426614174000";
const NEW_VIEW_ID = "223e4567-e89b-42d3-a456-426614174001";
const TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13101-bldg-lod2-notexture-latest/tileset.json";
const cameraState: CameraState = {
  destination: {
    height: 1_500,
    latitudeDegrees: 35.697,
    longitudeDegrees: 139.762,
  },
  orientation: { heading: 0.2, pitch: -0.8, roll: 0 },
};

function idToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: 4_102_444_800,
    sub: "11111111-2222-4333-8444-555555555555",
  })}.signature`;
}

function runtimeConfig() {
  return {
    apiBaseUrl: "http://127.0.0.1:5173/mock-api",
    awsRegion: "ap-northeast-1",
    cognitoDomain: "https://auth.example.test",
    fallbackTilesetUrl: "",
    redirectUri: "http://127.0.0.1:5173/",
    tilesetUrl: TILESET_URL,
    userPoolClientId: "test-client-id",
  };
}

async function mockRuntimeConfig(page: Page): Promise<void> {
  await page.route("**/runtime-config.json", async (route) => {
    await route.fulfill({
      body: JSON.stringify(runtimeConfig()),
      contentType: "application/json",
      status: 200,
    });
  });
}

function savedView(viewId = VIEW_ID, title = "保存済みビュー") {
  const filterState = createDefaultFilterState();
  filterState.numeric.floodDepth.min = 0.5;
  filterState.numeric.storeysAboveGround.min = 4;
  filterState.numeric.roofArea.min = 1_000;
  filterState.colorMode = "floodDepth";
  return {
    cameraState,
    createdAt: "2026-09-24T01:02:03.000Z",
    filterState,
    title,
    viewId,
  };
}

async function fulfillJson(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(value),
    contentType: "application/json",
    status,
  });
}

test("authenticated user can restore, save, list, and delete views", async ({ page }) => {
  await mockRuntimeConfig(page);
  await page.addInitScript((token) => {
    window.sessionStorage.setItem("plateau-lens.auth.id-token", token);
  }, idToken());

  const authorizationHeaders: Array<string | null> = [];
  const postBodies: unknown[] = [];
  let summaries = [savedView()];

  await page.route("**/mock-api/views**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    authorizationHeaders.push(request.headers()["authorization"] ?? null);

    if (url.pathname === "/mock-api/views" && method === "GET") {
      await fulfillJson(route, {
        items: summaries.map(({ createdAt, title, viewId }) => ({
          createdAt,
          title,
          viewId,
        })),
      });
      return;
    }
    if (url.pathname === "/mock-api/views" && method === "POST") {
      postBodies.push(request.postDataJSON());
      summaries = [savedView(NEW_VIEW_ID, "新しいビュー"), ...summaries];
      await fulfillJson(
        route,
        {
          shareUrl: `http://127.0.0.1:5173/?viewId=${NEW_VIEW_ID}`,
          viewId: NEW_VIEW_ID,
        },
        201,
      );
      return;
    }
    if (url.pathname === `/mock-api/views/${VIEW_ID}` && method === "GET") {
      await fulfillJson(route, savedView());
      return;
    }
    if (url.pathname === `/mock-api/views/${NEW_VIEW_ID}` && method === "GET") {
      await fulfillJson(route, savedView(NEW_VIEW_ID, "新しいビュー"));
      return;
    }
    if (url.pathname === `/mock-api/views/${NEW_VIEW_ID}` && method === "DELETE") {
      summaries = summaries.filter((item) => item.viewId !== NEW_VIEW_ID);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await expect(page.getByText("ログイン中。保存とマイビューを利用できます。")).toBeVisible();
  const savedViewButton = page.locator(".saved-view-open", { hasText: "保存済みビュー" });
  await expect(savedViewButton).toBeVisible();

  await savedViewButton.click();
  await expect(page.locator("#floodDepth-min")).toHaveValue("0.5");
  await expect(page.locator("#storeysAboveGround-min")).toHaveValue("4");
  await expect(page.locator("#roofArea-min")).toHaveValue("1000");

  await page.getByLabel("ビュー名").fill("新しいビュー");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("link", { name: "保存したビューの共有リンク" })).toBeVisible();
  const newViewButton = page.locator(".saved-view-open", { hasText: "新しいビュー" });
  await expect(newViewButton).toBeVisible();

  expect(postBodies).toHaveLength(1);
  expect(Object.keys(postBodies[0] as Record<string, unknown>)).toEqual([
    "title",
    "filterState",
    "cameraState",
  ]);
  expect(authorizationHeaders.filter(Boolean).every((value) => value === `Bearer ${idToken()}`)).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "「新しいビュー」を削除" }).click();
  await expect(newViewButton).toHaveCount(0);
});

test("public capability URL restores without an ID token", async ({ page }) => {
  await mockRuntimeConfig(page);
  let publicAuthorization: string | null | undefined;
  await page.route(`**/mock-api/views/${VIEW_ID}`, async (route) => {
    publicAuthorization = route.request().headers()["authorization"];
    await fulfillJson(route, savedView());
  });

  await page.goto(`/?viewId=${VIEW_ID}`);
  await expect(page.locator("#floodDepth-min")).toHaveValue("0.5");
  await expect(page.locator("#storeysAboveGround-min")).toHaveValue("4");
  await expect(page.getByText("共有ビュー「保存済みビュー」を読み込みました。")).toBeVisible();
  expect(publicAuthorization).toBeUndefined();
  expect(new URL(page.url()).searchParams.has("viewId")).toBe(false);
  expect(new URL(page.url()).searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/u);
});

test("cloud view controls remain available when both map sources fail", async ({ page }) => {
  const primaryTilesetUrl = "http://127.0.0.1:5173/broken-primary/tileset.json";
  const fallbackTilesetUrl = "http://127.0.0.1:5173/broken-fallback/tileset.json";
  await page.route("**/runtime-config.json", async (route) => {
    await fulfillJson(route, {
      ...runtimeConfig(),
      fallbackTilesetUrl,
      tilesetUrl: primaryTilesetUrl,
    });
  });
  await page.addInitScript((token) => {
    window.sessionStorage.setItem("plateau-lens.auth.id-token", token);
  }, idToken());

  let summaries = [savedView()];
  await page.route("**/mock-api/views**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/mock-api/views" && request.method() === "GET") {
      await fulfillJson(route, {
        items: summaries.map(({ createdAt, title, viewId }) => ({
          createdAt,
          title,
          viewId,
        })),
      });
      return;
    }
    if (url.pathname === `/mock-api/views/${VIEW_ID}` && request.method() === "DELETE") {
      summaries = [];
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 404 });
  });
  await page.route(primaryTilesetUrl, async (route) => {
    await route.fulfill({ status: 503 });
  });
  await page.route(fallbackTilesetUrl, async (route) => {
    await route.fulfill({ status: 503 });
  });

  await page.goto("/");
  await expect(page.getByText("ログイン中。保存とマイビューを利用できます。")).toBeVisible();
  const savedViewButton = page.locator(".saved-view-open", { hasText: "保存済みビュー" });
  await expect(savedViewButton).toBeVisible();
  await expect(page.locator("#load-status")).toHaveAttribute("data-result", "fail");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "「保存済みビュー」を削除" }).click();
  await expect(savedViewButton).toHaveCount(0);
});


test("switches from failed primary content to the fallback tileset once", async ({ page }) => {
  const primaryTilesetUrl = "http://127.0.0.1:5173/broken-primary/tileset.json";
  let failedPrimaryTileRequests = 0;
  let fallbackRootRequests = 0;
  const toRadians = Math.PI / 180;
  const region = [
    139.759 * toRadians,
    35.696 * toRadians,
    139.765 * toRadians,
    35.701 * toRadians,
    -50,
    500,
  ];

  await page.route("**/runtime-config.json", async (route) => {
    await fulfillJson(route, {
      ...runtimeConfig(),
      fallbackTilesetUrl: TILESET_URL,
      tilesetUrl: primaryTilesetUrl,
    });
  });
  await page.route("**/broken-primary/tile-*.b3dm", async (route) => {
    failedPrimaryTileRequests += 1;
    await route.fulfill({ status: 503 });
  });
  await page.route(primaryTilesetUrl, async (route) => {
    await fulfillJson(route, {
      asset: { version: "1.0" },
      geometricError: 1_000,
      root: {
        boundingVolume: { region },
        children: [0, 1, 2].map((index) => ({
          boundingVolume: { region },
          content: { uri: `tile-${index}.b3dm` },
          geometricError: 0,
        })),
        geometricError: 1_000,
        refine: "ADD",
      },
    });
  });
  await page.route(TILESET_URL, async (route) => {
    fallbackRootRequests += 1;
    await route.continue();
  });

  await page.goto("/?diagnostics=1");
  await expect(page.locator("#usage-options input").first()).toBeAttached();
  await page.waitForFunction(
    () => document.documentElement.dataset.preflight === "pass",
  );

  expect(failedPrimaryTileRequests).toBe(3);
  expect(fallbackRootRequests).toBe(1);
  await expect(page.locator("#load-status")).toHaveText("表示準備完了");
});