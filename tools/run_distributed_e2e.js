"use strict";

const {spawnSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

const pythonModuleLauncher = [
  "import runpy, sys;",
  `sys.path.insert(0, ${JSON.stringify(repoRoot)});`,
  "module = sys.argv[1];",
  "sys.argv = sys.argv[1:];",
  "runpy.run_module(module, run_name='__main__')",
].join(" ");

function pythonCandidates() {
  if (process.platform === "win32") {
    return [path.join(repoRoot, ".tools", "windows-x64", "python", "python.exe")];
  }
  if (process.env.PYTHON) return [process.env.PYTHON];
  return ["python3", "python"];
}

for (const python of pythonCandidates()) {
  if (path.isAbsolute(python) && !fs.existsSync(python)) continue;
  const result = spawnSync(python, [
    "-c",
    pythonModuleLauncher,
    "tools.run_distributed_e2e",
    ...process.argv.slice(2),
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (!result.error) {
    process.exit(result.status === null ? 1 : result.status);
  }
  if (result.error.code !== "ENOENT") {
    console.error(result.error.message);
    process.exit(1);
  }
}

if (process.platform === "win32") {
  console.error("error: Windows tool-pack Python is missing. Run run\\win\\setup_exe.bat first.");
} else {
  console.error("error: Python 3 was not found; install it or set PYTHON to its executable.");
}
process.exit(1);
