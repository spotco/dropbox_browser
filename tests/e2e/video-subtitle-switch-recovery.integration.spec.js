const { test, expect } = require("@playwright/test");
const { registerVideoSubtitleSwitchSuite } = require("./support/video-subtitle-switch-suite");

const workerPortOffset = Number(process.env.TEST_WORKER_INDEX || "0") * 100;

registerVideoSubtitleSwitchSuite({
  test,
  expect,
  shard: "recovery",
  port: 8213 + workerPortOffset,
});
