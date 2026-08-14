import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const tempOutputDir = path.join(os.tmpdir(), "ozon-erp-frontend-build");
const env = {
  ...process.env,
  OZON_VITE_OUT_DIR: tempOutputDir,
  OZON_VITE_MANIFEST_PATH: path.join(tempOutputDir, ".vite", "manifest.json")
};

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed${signal ? ` (${signal})` : ` with code ${code}`}`));
    });
  });
}

function runNodeScript(scriptPath, label) {
  return run(process.execPath, [scriptPath], label);
}

async function main() {
  await runNodeScript("scripts/clean-frontend-build.mjs", "Frontend clean");
  await run(process.platform === "win32" ? "cmd.exe" : "npx", process.platform === "win32"
    ? ["/d", "/s", "/c", "vite build --configLoader runner"]
    : ["vite", "build", "--configLoader", "runner"], "Vite build");
  await runNodeScript("scripts/promote-frontend-build.mjs", "Frontend promote");
  await runNodeScript("scripts/generate-admin-shell.mjs", "Admin shell generation");
  await runNodeScript("scripts/write-release-metadata.mjs", "Release metadata");
  await runNodeScript("scripts/check-frontend-safety.mjs", "Frontend safety check");
  await runNodeScript("scripts/precompress-static-assets.mjs", "Static asset precompression");
  await fs.rm(tempOutputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
}

await main();
