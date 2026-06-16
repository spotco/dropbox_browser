const path = require("path");
const { spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function resolvePort() {
  return String(process.env.PLAYWRIGHT_PORT || "8010");
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

async function startServer(options = {}) {
  const port = resolvePort();
  const baseURL = resolveBaseURL();
  const fixtureName = options.fixtureName || "basic-library.json";
  const fixturePath = path.join(repoRoot, "tests", "e2e", "fixtures", fixtureName);
  const child = spawn(
    "python",
    [path.join(repoRoot, "tests", "e2e", "support", "run_server.py")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PLAYWRIGHT_PORT: port,
        DROPBOX_BROWSER_E2E_FIXTURE: fixturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  mirrorOutput(child.stdout, "[e2e-server] ");
  mirrorOutput(child.stderr, "[e2e-server] ");

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await Promise.race([
    waitForServer(`${baseURL}/`, 30000),
    exitPromise.then(({ code, signal }) => {
      throw new Error(`Server exited before becoming ready (code=${code}, signal=${signal})`);
    }),
  ]);

  return { child, exitPromise };
}

async function stopServer(server) {
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
  startServer,
  stopServer,
};
