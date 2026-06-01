import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const outputDir = path.resolve(process.env.DEPLOY_OUTPUT_DIR || path.join(rootDir, "dist", "deploy"));

const filesToCopy = [
  ".env",
  ".env.example",
  "package-lock.json",
  "start.bat"
];

const directoriesToCopy = [
  "public",
  "src",
  "deploy",
  "tools"
];

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
  await fs.cp(source, target, { recursive: true });
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

await runNpmScript("build:frontend", "Frontend build");

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

for (const file of filesToCopy) {
  await copyEntry(file);
}

for (const directory of directoriesToCopy) {
  await copyEntry(directory);
}

await writeDeployPackageJson();
await rewriteDeployEnv();
await rewriteDeployStartBat();

const manifest = {
  builtAt: new Date().toISOString(),
  frontendOutput: "public/vue-apps",
  startupCommand: "npm start",
  includedFiles: filesToCopy,
  includedDirectories: directoriesToCopy
};

await fs.writeFile(
  path.resolve(outputDir, "deploy-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

console.log(`Deployment artifact generated at ${outputDir}`);
