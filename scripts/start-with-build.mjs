import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { openStartupPage } from "./open-startup-page.mjs";

const rootDir = process.cwd();
const port = Number(process.env.PORT || 8788);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;

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

function startManaged(command, args, label) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env
  });

  child.on("error", (error) => {
    console.error(`[start] ${label} failed: ${error.message}`);
  });
  return child;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: rootDir }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function isPortOpen(targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function findPortPids(targetPort) {
  if (process.platform === "win32") {
    try {
      const stdout = await execFileText("powershell", [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
      ]);
      return stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }
  try {
    const stdout = await execFileText("lsof", ["-ti", `tcp:${targetPort}`]);
    return stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function freePort(targetPort) {
  if (!(await isPortOpen(targetPort))) return;
  const pids = await findPortPids(targetPort);
  if (!pids.length) {
    throw new Error(`Port ${targetPort} is already in use, but no owner process could be found.`);
  }
  console.log(`[start] Port ${targetPort} is in use. Stopping process(es): ${pids.join(", ")}`);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    if (process.platform === "win32") {
      await execFileText("taskkill", ["/PID", String(pid), "/F"]).catch(() => {});
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The port owner may have exited between detection and kill.
      }
    }
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (!(await isPortOpen(targetPort))) return;
    await delay(300);
  }
  throw new Error(`Port ${targetPort} is still in use after stopping ${pids.join(", ")}.`);
}

async function waitForPort(targetPort, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(targetPort)) return;
    await delay(300);
  }
  throw new Error(`Server did not listen on port ${targetPort} within ${timeoutMs}ms.`);
}

await runNpmScript("build:frontend", "Frontend build");
await runNpmScript("package:plugin", "Plugin packaging");
await freePort(port);
const server = startManaged(process.execPath, ["src/server.js"], "Server startup");
const serverExit = waitForExit(server);
await Promise.race([
  waitForPort(port),
  serverExit.then(({ code, signal }) => {
    throw new Error(`Server startup failed${signal ? ` (${signal})` : ` with code ${code}`}`);
  })
]);
console.log(`[start] ERP server is ready: ${appBaseUrl}`);
const openedPageUrl = openStartupPage(appBaseUrl);
if (openedPageUrl) console.log(`[start] Opened startup page: ${openedPageUrl}`);

const { code, signal } = await serverExit;
if (code !== 0) {
  throw new Error(`Server exited${signal ? ` (${signal})` : ` with code ${code}`}`);
}
