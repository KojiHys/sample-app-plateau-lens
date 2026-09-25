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
