import { spawn } from "node:child_process";

const rootDir = process.cwd();

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

await runNpmScript("build:frontend", "Frontend build");
await run(process.execPath, ["src/server.js"], "Server startup");
