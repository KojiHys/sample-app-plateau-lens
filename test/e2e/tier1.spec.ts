import { expect, test } from "@playwright/test";

test("Tier 1 loads PLATEAU without ion and restores the preset URL state", async ({
  page,
}) => {
  const ionRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    try {
      const hostname = new URL(request.url()).hostname;
      if (hostname === "cesium.com" || hostname.endsWith(".cesium.com")) {
        ionRequests.push(request.url());
      }
    } catch {
      // Ignore browser-internal URLs.
    }
  });

  await page.goto("/?diagnostics=1");
  await page.waitForFunction(
    () => document.documentElement.dataset.preflight === "pass",
  );

  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(page.locator("#usage-options input").first()).toBeAttached();
  await expect(page.getByText("Project PLATEAU「千代田区3D都市モデル」")).toBeVisible();
  await expect(page.getByText("実際の避難施設指定や安全性を示しません").first()).toBeVisible();
  expect(ionRequests).toEqual([]);
  expect(browserErrors.filter((message) => message.includes("Rendering has stopped"))).toEqual([]);

  await page.getByRole("button", { name: "垂直避難の受け入れ先候補" }).click();
  await expect(page.locator("#floodDepth-min")).toHaveValue("0.5");
  await expect(page.locator("#storeysAboveGround-min")).toHaveValue("4");
  await expect(page.locator("#roofArea-min")).toHaveValue("1000");
  await expect(page.locator('input[name="color-mode"][value="floodDepth"]')).toBeChecked();

  const state = new URL(page.url()).searchParams.get("state");
  expect(state).toMatch(/^[A-Za-z0-9_-]+$/u);

  await page.reload();
  await expect(page.locator("#floodDepth-min")).toHaveValue("0.5");
  await expect(page.locator("#storeysAboveGround-min")).toHaveValue("4");
  await expect(page.locator("#roofArea-min")).toHaveValue("1000");
  await expect(page.locator('input[name="color-mode"][value="floodDepth"]')).toBeChecked();
});

interface DecodedCamera {
  latitudeDegrees: number;
  longitudeDegrees: number;
  pitch: number;
}

function decodeCamera(url: string): DecodedCamera {
  const state = new URL(url).searchParams.get("state");
  if (!state) {
    throw new Error("state parameter is missing");
  }
  const payload = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
    camera: {
      destination: { latitudeDegrees: number; longitudeDegrees: number };
      orientation: { pitch: number };
    };
  };
  return { ...payload.camera.destination, pitch: payload.camera.orientation.pitch };
}

test("3D display settings load imagery, terrain, textures, 2D mode, and reset the view", async ({
  page,
}) => {
  const hosts = new Set<string>();
  const texturedTilesetRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    hosts.add(url.hostname);
    if (url.pathname.includes("13101-bldg-lod2-texture-latest")) {
      texturedTilesetRequests.push(url.pathname);
    }
  });

  await page.goto("/?diagnostics=1");
  await page.waitForFunction(
    () => document.documentElement.dataset.preflight === "pass",
  );
  await expect(page.locator('input[name="scene-mode"][value="3d"]')).toBeChecked();
  await expect(page.locator("#toggle-ortho")).toBeChecked();
  await expect(page.locator("#toggle-terrain")).toBeChecked();
  await expect(page.locator("#toggle-textures")).not.toBeChecked();
  await expect(page.locator("#toggle-lighting")).not.toBeChecked();
  await expect(page.getByText("国土地理院の標高タイル")).toBeVisible();

  // The initial 3D camera is the fixed oblique view above Otemachi.
  const initialCamera = decodeCamera(page.url());
  expect(initialCamera.pitch).toBeCloseTo(-0.4568, 3);
  expect(initialCamera.longitudeDegrees).toBeCloseTo(139.7608, 4);
  expect(initialCamera.latitudeDegrees).toBeCloseTo(35.6855, 4);

  await expect.poll(() => hosts.has("cyberjapandata.gsi.go.jp")).toBe(true);
  await expect
    .poll(() => hosts.has("api.plateauview.mlit.go.jp") && hosts.has("tile.plateauview.mlit.go.jp"))
    .toBe(true);

  await page.locator("#toggle-textures").check();
  await expect.poll(() => texturedTilesetRequests.length).toBeGreaterThan(0);
  await expect(page.locator("#load-status")).toHaveText("表示準備完了", { timeout: 60_000 });

  await page.locator("#toggle-lighting").check();
  await page.locator('input[name="scene-mode"][value="2d"]').check();
  await expect(page.locator("#toggle-terrain")).toBeDisabled();
  await expect(page.locator("#toggle-lighting")).toBeDisabled();

  const beforeReset = decodeCamera(page.url());
  expect(beforeReset.longitudeDegrees).toBeCloseTo(139.762, 2);

  await page.getByRole("button", { name: "視点をリセット" }).click();
  await expect
    .poll(() => {
      const camera = decodeCamera(page.url());
      return (
        Math.abs(camera.longitudeDegrees - 139.7629) < 0.001 &&
        Math.abs(camera.latitudeDegrees - 35.6908) < 0.001
      );
    })
    .toBe(true);

  await page.locator('input[name="scene-mode"][value="3d"]').check();
  await expect(page.locator("#toggle-terrain")).toBeEnabled();
  await expect(page.locator('input[name="color-mode"][value="none"]')).toBeChecked();
  expect(hosts.has("cesium.com") || [...hosts].some((host) => host.endsWith(".cesium.com"))).toBe(
    false,
  );
  expect(browserErrors.filter((message) => message.includes("Rendering has stopped"))).toEqual([]);
});
