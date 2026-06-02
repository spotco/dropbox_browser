const { test, expect } = require("@playwright/test");

process.env.PLAYWRIGHT_PORT = "8010";
test.use({ baseURL: "http://127.0.0.1:8010" });

const { startServer, stopServer } = require("./support/server");

let server = null;

test.beforeAll(async () => {
  server = await startServer({ clientRender: false });
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

test("server-rendered sort links still navigate normally", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Date" }).click();

  await expect(page).toHaveURL(/[\?&]sort=date(&|$)/);
  await expect(page.getByText("remote-only.txt")).toBeVisible();
});
