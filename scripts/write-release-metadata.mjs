import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const publicDir = path.resolve(rootDir, "public");
const version = process.env.OZON_RELEASE_VERSION || process.env.APP_RELEASE_VERSION || "local";
const channel = process.env.OZON_RELEASE_CHANNEL || "local";
const buildStamp = process.env.OZON_BUILD_STAMP || "";

const release = {
  app: "ozon-erp",
  version,
  channel,
  build_stamp: buildStamp,
  built_at: new Date().toISOString()
};

await fs.mkdir(publicDir, { recursive: true });
await writeReleaseMetadata(`${JSON.stringify(release, null, 2)}\n`);

console.log(`Wrote frontend release metadata: ${version}`);

async function runPowerShell(command) {
  await new Promise((resolve, reject) => {
    const child = spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `${command}; exit 0`
    ], {
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell command failed with code ${code}`));
    });
  });
}

async function writeReleaseMetadata(content) {
  const targetPath = path.resolve(publicDir, "release.json");
  try {
    await fs.writeFile(targetPath, content, "utf8");
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error;
    const tempPath = path.join(os.tmpdir(), `ozon-release-${Date.now()}.json`);
    await fs.writeFile(tempPath, content, "utf8");
    const escapedSourcePath = tempPath.replaceAll("'", "''");
    const escapedTargetPath = targetPath.replaceAll("'", "''");
    await runPowerShell(`Copy-Item -LiteralPath '${escapedSourcePath}' -Destination '${escapedTargetPath}' -Force`);
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
