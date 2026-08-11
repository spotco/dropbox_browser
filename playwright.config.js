const path = require("path");
const { defineConfig } = require("@playwright/test");

const port = Number(process.env.PLAYWRIGHT_PORT || "8010");
const repoRoot = __dirname;

module.exports = defineConfig({
  testDir: path.join(repoRoot, "tests", "e2e"),
  timeout: 10000,
  // Keep e2e servers on fixed/default ports free of cross-worker collisions.
  // Music/video integration servers pick their own ports; client-render shares 8010.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
    // Waveform e2e needs Web Audio decode without a prior user gesture.
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
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
