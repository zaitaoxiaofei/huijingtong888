import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(rootDir, "pivot-table-master");
const outputDir = path.resolve(process.env.ANALYTICS_PLUGIN_OUTPUT_DIR || path.join(rootDir, ".."));
const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8"));
const version = String(manifest.version || "").trim();
if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error("Analytics plugin manifest version is invalid");
await fs.mkdir(outputDir, { recursive: true });

const versionedName = `ozon-seller-analytics-plugin-${version}.zip`;
const versionedPath = path.join(outputDir, versionedName);
const aliasPath = path.join(outputDir, "ozon-seller-analytics-plugin.zip");
await fs.rm(versionedPath, { force: true });
await fs.rm(aliasPath, { force: true });
if (process.platform === "win32") {
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # Keep nested ZIP entry paths portable across Chrome and Linux.
    [System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $env:ANALYTICS_PLUGIN_SOURCE_DIR,
      $env:ANALYTICS_PLUGIN_ARCHIVE_PATH,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $false
    )
    $archive = [System.IO.Compression.ZipFile]::OpenRead($env:ANALYTICS_PLUGIN_ARCHIVE_PATH)
    try {
      $entry = $archive.GetEntry('manifest.json')
      if ($null -eq $entry) { throw 'Analytics plugin package manifest is missing' }
      $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false, $true))
      try { $packagedManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      if ($packagedManifest.version -cne $env:ANALYTICS_PLUGIN_EXPECTED_VERSION) {
        throw 'Analytics plugin package version mismatch'
      }
    } finally { $archive.Dispose() }
  `], {
    env: {
      ...process.env,
      ANALYTICS_PLUGIN_SOURCE_DIR: pluginDir,
      ANALYTICS_PLUGIN_ARCHIVE_PATH: versionedPath,
      ANALYTICS_PLUGIN_EXPECTED_VERSION: version
    }
  });
} else {
  await execFileAsync("zip", ["-q", "-r", versionedPath, "."], { cwd: pluginDir });
  const contents = await execFileAsync("unzip", ["-p", versionedPath, "manifest.json"]);
  if (JSON.parse(contents.stdout).version !== version) throw new Error(`Analytics plugin package version mismatch: ${versionedName}`);
}
await fs.copyFile(versionedPath, aliasPath);

console.log(`Packaged analytics plugin ${version}`);
