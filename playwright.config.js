const path = require("path");
const { defineConfig } = require("@playwright/test");

const port = Number(process.env.PLAYWRIGHT_PORT || "8010");
const repoRoot = __dirname;

module.exports = defineConfig({
  testDir: path.join(repoRoot, "tests", "e2e"),
  timeout: 10000,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  // Named groups so suites can be run in isolation:
  //   npx playwright test --project=music
  //   npm run test:e2e:music
  projects: [
    {
      name: "music",
      testMatch: /music-.*\.spec\.js$/,
    },
    {
      name: "video",
      testMatch: /video-.*\.spec\.js$/,
    },
    {
      name: "client-render",
      testMatch: /client-render\..*\.spec\.js$/,
    },
  ],
});
