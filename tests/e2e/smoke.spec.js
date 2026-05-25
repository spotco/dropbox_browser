const { test, expect } = require("@playwright/test");
const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async () => {
  await stopServer(server);
  server = null;
});

test("root page loads against the fake python server", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/SDB: Dropbox/);
  await expect(page.getByText("remote-only.txt")).toBeVisible();
  await expect(page.getByText("local-only.txt")).toBeVisible();
});
