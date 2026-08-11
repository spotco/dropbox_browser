const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve the Python used for e2e servers on this machine.
 * Prefer the windows tool-pack portable interpreter.
 */
function resolvePython(repoRoot) {
  const toolPackPython = path.join(repoRoot, ".tools", "windows-x64", "python", "python.exe");
  if (process.platform === "win32") {
    if (fs.existsSync(toolPackPython) && fs.statSync(toolPackPython).isFile()) {
      return toolPackPython;
    }
    throw new Error("Windows tool-pack Python is missing. Run run\\win\\setup_exe.bat first.");
  }

  const envPath = String(process.env.DROPBOX_BROWSER_PYTHON || "").trim();
  const candidates = [
    envPath,
    path.join(repoRoot, "python", "python.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return "python3";
}

module.exports = {
  resolvePython,
};
