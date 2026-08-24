const path = require("path");
const { spawn } = require("node:child_process");
const { resolvePython } = require("./resolve_python");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const INTEGRATION_SERVER_STARTUP_TIMEOUT_MS = 120000;

function resolvePort() {
  return String(process.env.PLAYWRIGHT_PORT || "8011");
}

function resolveBaseURL() {
  return `http://127.0.0.1:${resolvePort()}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError ? lastError.message : "unknown error"}`);
}

function mirrorOutput(stream, prefix) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      process.stdout.write(`${prefix}${line}\n`);
    }
  });
}

async function startIntegrationServer({ port: requestedPort, fixturePath: requestedFixturePath } = {}) {
  const port = String(requestedPort || resolvePort());
  const baseURL = `http://127.0.0.1:${port}`;
  const fixturePath = requestedFixturePath || process.env.DROPBOX_BROWSER_E2E_FIXTURE ||
    path.join(repoRoot, "tests", "e2e", "fixtures", "basic-library.json");
  const pythonExe = resolvePython(repoRoot);
  const child = spawn(
    pythonExe,
    [path.join(repoRoot, "tests", "e2e", "support", "run_integration_server.py")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PLAYWRIGHT_PORT: port,
        DROPBOX_BROWSER_E2E_FIXTURE: fixturePath,
        DROPBOX_BROWSER_PYTHON: pythonExe,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  mirrorOutput(child.stdout, "[integration-server] ");
  mirrorOutput(child.stderr, "[integration-server] ");

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await Promise.race([
    waitForServer(
      `${baseURL}/__integration/status`,
      INTEGRATION_SERVER_STARTUP_TIMEOUT_MS,
    ),
    exitPromise.then(({ code, signal }) => {
      throw new Error(`Integration server exited before becoming ready (code=${code}, signal=${signal})`);
    }),
  ]);

  return { child, exitPromise };
}

async function stopIntegrationServer(server) {
  if (!server) return;
  const { child, exitPromise } = server;
  if (child.exitCode !== null) {
    await exitPromise;
    return;
  }

  child.kill();
  try {
    await Promise.race([
      exitPromise,
      wait(750).then(() => {
        throw new Error("still-running");
      }),
    ]);
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "still-running") {
      throw error;
    }
  }

  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      killer.once("exit", (code) => {
        if (code === 0 || code === 1 || code === 128 || code === 255) {
          resolve();
          return;
        }
        reject(new Error(`taskkill exited with code ${code}`));
      });
      killer.once("error", reject);
    });
  } else {
    child.kill("SIGTERM");
  }

  await Promise.race([
    exitPromise,
    wait(3000).then(() => {
      throw new Error("Timed out waiting for the integration test server to exit");
    }),
  ]);
}

module.exports = {
  resolveBaseURL,
  startIntegrationServer,
  stopIntegrationServer,
};
