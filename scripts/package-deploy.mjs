import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const finalOutputDir = path.resolve(process.env.DEPLOY_OUTPUT_DIR || path.join(rootDir, "dist", "deploy"));
const outputDir = process.platform === "win32"
  ? path.resolve(process.env.OZON_DEPLOY_WORK_DIR || path.join(os.tmpdir(), "ozon-erp-deploy-build"))
  : finalOutputDir;
const releaseVersion = process.env.OZON_RELEASE_VERSION || process.env.APP_RELEASE_VERSION || "local";
const releaseChannel = process.env.OZON_RELEASE_CHANNEL || "production";
const includeUploads = process.env.OZON_DEPLOY_INCLUDE_UPLOADS === "1";
const includeEnv = process.env.OZON_DEPLOY_INCLUDE_ENV === "1";

const filesToCopy = [
  ".env.example",
  "package-lock.json",
  "start.bat"
];
if (includeEnv) filesToCopy.unshift(".env");

const directoriesToCopy = [
  "public",
  "ozon-erp-collector-plugin",
  "pivot-table-master",
  "src",
  "scripts",
  "deploy",
  "tools"
];

const managedDeployPaths = [
  ".env",
  "package.json",
  "package-lock.json",
  ".env.example",
  "start.bat",
  "deploy-manifest.json",
  path.join("public", "admin.html"),
  path.join("public", "admin.html.br"),
  path.join("public", "admin.html.gz"),
  path.join("public", "release.json"),
  path.join("public", "release.json.br"),
  path.join("public", "release.json.gz"),
  path.join("public", "vue-apps"),
  path.join("public", "ai-workbench-proxy"),
  path.join("public", "preview-assets"),
  path.join("public", "media"),
  path.join("public", "uploads"),
  "uploads",
  "backups",
  "logs",
  "src",
  "scripts",
  "deploy",
  "tools"
];

const pluginPackageRules = [
  {
    aliasPattern: /^ozon-baodan-erp-plugin\.rar$/,
    versionPattern: /^ozon-baodan-erp-plugin-([0-9][0-9A-Za-z.-]*)\.rar$/
  },
  {
    aliasPattern: /^ozon-erp-collector-plugin\.rar$/
  },
  {
    aliasPattern: /^ozon-seller-analytics-plugin\.rar$/,
    versionPattern: /^ozon-seller-analytics-plugin-([0-9][0-9A-Za-z.-]*)\.rar$/
  }
];

async function mkdirWithRetry(target, attempts = 6) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.mkdir(target, { recursive: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'ENOENT'].includes(error?.code) || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

function isPluginPackageName(name) {
  return /^(ozon-baodan-erp-plugin|ozon-erp-collector-plugin|ozon-seller-analytics-plugin)(-[0-9][0-9A-Za-z.-]*)?\.rar$/.test(String(name || ""));
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env
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

function runNpmScript(scriptName, label) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", `npm run ${scriptName}`], label);
  }
  return run("npm", ["run", scriptName], label);
}

async function copyEntry(relativePath) {
  const source = path.resolve(rootDir, relativePath);
  const target = path.resolve(outputDir, relativePath);
  try {
    await fs.access(source);
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, {
    recursive: true,
    filter: relativePath === "public" && !includeUploads
      ? (sourcePath) => {
          const relativeSource = path.relative(source, sourcePath);
          return relativeSource !== "uploads" && !relativeSource.startsWith(`uploads${path.sep}`);
        }
      : undefined
  });
}

async function copyPluginPackages() {
  const packageSourceDir = path.resolve(rootDir, "..");
  const packageTargetDir = path.dirname(outputDir);
  let entries = [];
  try {
    entries = await fs.readdir(packageSourceDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const selectedNames = new Set();
  for (const rule of pluginPackageRules) {
    const versioned = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (rule.aliasPattern?.test(entry.name)) selectedNames.add(entry.name);
      const match = rule.versionPattern ? entry.name.match(rule.versionPattern) : null;
      if (match) versioned.push({ name: entry.name, version: match[1] });
    }
    versioned.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: "base" }));
    if (versioned[0]) selectedNames.add(versioned[0].name);
  }

  const copied = [];
  for (const entry of entries) {
    if (!entry.isFile() || !selectedNames.has(entry.name)) continue;
    const source = path.join(packageSourceDir, entry.name);
    const target = path.join(packageTargetDir, entry.name);
    const deployTarget = path.join(outputDir, entry.name);
    await fs.mkdir(packageTargetDir, { recursive: true });
    await fs.copyFile(source, target);
    await fs.copyFile(source, deployTarget);
    copied.push(entry.name);
  }
  return copied;
}

async function writeDeployPackageJson() {
  const packageJsonPath = path.resolve(rootDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  packageJson.scripts = {
    ...packageJson.scripts,
    start: "node src/server.js",
    "start:server": "node src/server.js"
  };
  await fs.writeFile(
    path.resolve(outputDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf8"
  );
}

async function cleanManagedDeployOutput() {
  await mkdirWithRetry(finalOutputDir);
  const relative = path.relative(rootDir, finalOutputDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean deploy output outside project root: ${finalOutputDir}`);
  }

  for (const relativePath of managedDeployPaths) {
    const target = path.join(finalOutputDir, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) continue;
    await fs.rm(target, {
      recursive: stat.isDirectory(),
      force: true,
      maxRetries: 10,
      retryDelay: 250
    });
  }

  const entries = await fs.readdir(finalOutputDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !isPluginPackageName(entry.name)) continue;
    await fs.rm(path.join(finalOutputDir, entry.name), {
      force: true,
      maxRetries: 10,
      retryDelay: 250
    });
  }
}

async function promoteDeployOutput() {
  if (outputDir === finalOutputDir) return;
  await mkdirWithRetry(path.dirname(finalOutputDir));
  await cleanManagedDeployOutput();
  const sourceManifestPath = path.join(outputDir, "deploy-manifest.json");
  const targetManifestPath = path.join(finalOutputDir, "deploy-manifest.json");
  if (process.platform === "win32") {
    const escapedSourceDir = outputDir.replaceAll("'", "''");
    const escapedTargetDir = finalOutputDir.replaceAll("'", "''");
    const escapedSourceManifestPath = sourceManifestPath.replaceAll("'", "''");
    const escapedTargetManifestPath = targetManifestPath.replaceAll("'", "''");
    await run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference='SilentlyContinue'; New-Item -ItemType Directory -Path '${escapedTargetDir}' -Force | Out-Null; Get-ChildItem -LiteralPath '${escapedSourceDir}' -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination '${escapedTargetDir}' -Recurse -Force }; Copy-Item -LiteralPath '${escapedSourceManifestPath}' -Destination '${escapedTargetManifestPath}' -Force; exit 0`
    ], "Deploy artifact promote");
  } else {
    await mkdirWithRetry(finalOutputDir);
    await fs.cp(outputDir, finalOutputDir, { recursive: true, force: true });
  }
}

async function rewriteDeployEnv() {
  const deployEnvPath = path.resolve(outputDir, ".env");
  try {
    await fs.access(deployEnvPath);
  } catch {
    return;
  }
  const source = await fs.readFile(deployEnvPath, "utf8");
  const lines = source.split(/\r?\n/);
  let sawHost = false;
  const rewritten = lines.map((line) => {
    if (!line.startsWith("HOST=")) return line;
    sawHost = true;
    return "HOST=127.0.0.1";
  });
  if (!sawHost) rewritten.push("HOST=127.0.0.1");
  await fs.writeFile(deployEnvPath, rewritten.join("\n"), "utf8");
}

async function rewriteDeployStartBat() {
  const startBatPath = path.resolve(outputDir, "start.bat");
  const content = [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0\"",
    "echo Starting Ozon Profit Hub deployment...",
    "echo.",
    "set NODE_NO_WARNINGS=1",
    "node --version >nul 2>&1",
    "if errorlevel 1 (",
    "  echo Node.js was not found. Please install Node.js 22 or newer.",
    "  echo Download: https://nodejs.org/",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "for /f \"tokens=1 delims=.\" %%a in ('node -p \"process.versions.node\"') do set NODE_MAJOR=%%a",
    "for /f \"tokens=2 delims=.\" %%b in ('node -p \"process.versions.node\"') do set NODE_MINOR=%%b",
    "",
    "if %NODE_MAJOR% LSS 22 (",
    "  echo Current Node.js version is too old:",
    "  node --version",
    "  echo This project requires Node.js 22.5.0 or newer.",
    "  echo Download: https://nodejs.org/",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 5 (",
    "  echo Current Node.js version is too old:",
    "  node --version",
    "  echo This project requires Node.js 22.5.0 or newer.",
    "  echo Download: https://nodejs.org/",
    "  pause",
    "  exit /b 1",
    ")",
    "echo Node.js version:",
    "node --version",
    "echo.",
    "echo Starting server from deployment artifact...",
    "echo.",
    "node src/server.js",
    "pause",
    ""
  ].join("\r\n");
  await fs.writeFile(startBatPath, content, "utf8");
}

await runNpmScript("check:deploy-preflight", "Deploy preflight");
await runNpmScript("check:encoding", "Encoding check");
await runNpmScript("check:sql-bindings", "SQL binding check");
await runNpmScript("build:frontend", "Frontend build");
await runNpmScript("package:plugin", "Plugin packaging");

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

for (const file of filesToCopy) {
  await copyEntry(file);
}

for (const directory of directoriesToCopy) {
  await copyEntry(directory);
}

const includedPluginPackages = await copyPluginPackages();

await writeDeployPackageJson();
await rewriteDeployEnv();
await rewriteDeployStartBat();

const manifest = {
  builtAt: new Date().toISOString(),
  version: releaseVersion,
  channel: releaseChannel,
  frontendOutput: "public/vue-apps",
  startupCommand: "npm start",
  includedFiles: filesToCopy,
  includedDirectories: directoriesToCopy,
  includedUploads: includeUploads,
  includedEnv: includeEnv,
  includedPluginPackages
};

await fs.writeFile(
  path.resolve(outputDir, "deploy-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

await promoteDeployOutput();

console.log(`Deployment artifact generated at ${finalOutputDir}`);
