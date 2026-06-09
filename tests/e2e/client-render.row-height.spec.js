const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8015";
const baseURL = "http://127.0.0.1:8015";
test.use({ baseURL, viewport: { width: 1280, height: 420 } });

const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: true, fixtureName: "audio-downloads-long.json" });
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("client-render keeps virtualized browse rows single-line for long filenames", async ({ page }) => {
  await page.goto("/?path=audio_downloads");

  await expect(page.locator("body")).toHaveAttribute("data-browse-client", "ready");
  await expect(page.locator("body")).toHaveAttribute("data-browse-virtualized", "1");

  const rows = page.locator('tr[data-browse-row-id]');
  const firstBox = await rows.nth(0).boundingBox();
  const secondBox = await rows.nth(1).boundingBox();
  const thirdBox = await rows.nth(2).boundingBox();

  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(thirdBox).not.toBeNull();
  expect(Math.round(firstBox.height)).toBe(49);
  expect(firstBox.height).toBe(secondBox.height);
  expect(secondBox.height).toBe(thirdBox.height);

  for (const selector of [".status", ".col-size", ".col-date"]) {
    await expect(rows.nth(0).locator(selector)).toHaveCSS("white-space", "nowrap");
  }

  const firstLink = rows.nth(0).locator("a.name");
  await expect(firstLink).toHaveAttribute(
    "title",
    "2015-02-04_LTHS_Speech_Team_Regional_Performance_With_Extra_Long_Descriptor_01.m4a",
  );
  await expect(firstLink.locator(".entry-name")).toHaveText(
    "2015-02-04_LTHS_Speech_Team_Regional_Performance_With_Extra_Long_Descriptor_01.m4a",
  );
});
