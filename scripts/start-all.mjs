import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { openStartupPage } from "./open-startup-page.mjs";

const rootDir = process.cwd();
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const port = Number(process.env.PORT || 8788);
const printHelperPort = Number(process.env.OZON_PRINT_HELPER_PORT || 17878);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const electronRemoteUrl = process.env.ELECTRON_REMOTE_URL || appBaseUrl;
const shouldStartPrintHelper = process.env.OZON_START_PRINT_HELPER !== "0";
const shouldStartElectron = process.env.OZON_START_ELECTRON === "1";
const managedChildren = [];
const protectedPorts = new Set([8787, 8087]);

if (protectedPorts.has(port) && process.env.ALLOW_PROTECTED_PORT_OPERATION !== "1") {
  throw new Error(`Refusing to start or restart protected port ${port}. Use PORT=8788 for local verification.`);
}

function run(command, args, label, env = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[start-all] ${label}...`);
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, ...env }
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

function startManaged(command, args, label, env = {}) {
  console.log(`[start-all] ${label}...`);
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
  managedChildren.push({ child, label });
  child.on("error", (error) => {
    console.error(`[start-all] ${label} failed: ${error.message}`);
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

async function waitForPort(targetPort, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(targetPort)) return;
    await delay(300);
  }
  throw new Error(`Server did not listen on port ${targetPort} within ${timeoutMs}ms.`);
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

async function restartPort(targetPort) {
  if (!(await isPortOpen(targetPort))) return;

  const pids = await findPortPids(targetPort);
  if (!pids.length) {
    throw new Error(`Port ${targetPort} is already in use, but no owner process could be found.`);
  }

  console.log(`[start-all] Port ${targetPort} is in use. Stopping process(es): ${pids.join(", ")}`);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    if (process.platform === "win32") {
      try {
        await execFileText("taskkill", ["/PID", String(pid), "/F"]);
      } catch {
        // The port owner may have exited between detection and taskkill.
      }
    } else {
      process.kill(pid, "SIGTERM");
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (!(await isPortOpen(targetPort))) return;
    await delay(300);
  }
  throw new Error(`Port ${targetPort} is still in use after stopping ${pids.join(", ")}.`);
}

function stopManagedChildren() {
  for (const { child, label } of managedChildren.toReversed()) {
    if (child.exitCode !== null || child.killed) continue;
    console.log(`[start-all] Stopping ${label}...`);
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  stopManagedChildren();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopManagedChildren();
  process.exit(143);
});

try {
  await run(npmBin, ["run", "build:frontend"], "Building frontend");
  await restartPort(port);

  const server = startManaged(process.execPath, ["src/server.js"], "Starting ERP server", {
    APP_BASE_URL: appBaseUrl,
    PORT: String(port)
  });
  const serverExit = waitForExit(server);
  await Promise.race([
    waitForPort(port),
    serverExit.then(({ code, signal }) => {
      throw new Error(`ERP server exited before startup${signal ? ` (${signal})` : ` with code ${code}`}.`);
    })
  ]);
  console.log(`[start-all] ERP server is ready: ${appBaseUrl}`);
  const openedPageUrl = openStartupPage(appBaseUrl);
  if (openedPageUrl) console.log(`[start-all] Opened startup page: ${openedPageUrl}`);

  if (shouldStartPrintHelper) {
    await restartPort(printHelperPort);
    startManaged(process.execPath, ["scripts/local-print-helper.mjs"], "Starting print helper");
  }

  if (!shouldStartElectron) {
    console.log("[start-all] Electron startup skipped. Set OZON_START_ELECTRON=1 to launch it.");
    const { code, signal } = await serverExit;
    process.exitCode = code ?? (signal ? 1 : 0);
  } else {
    const electron = startManaged(npmBin, ["exec", "electron", "--", "."], "Starting Electron", {
      ELECTRON_REMOTE_URL: electronRemoteUrl
    });
    const result = await Promise.race([
      waitForExit(electron).then((exit) => ({ kind: "electron", ...exit })),
      serverExit.then((exit) => ({ kind: "server", ...exit }))
    ]);
    if (result.kind === "server") {
      throw new Error(`ERP server exited while Electron was running${result.signal ? ` (${result.signal})` : ` with code ${result.code}`}.`);
    }
    process.exitCode = result.code ?? (result.signal ? 1 : 0);
  }
} catch (error) {
  console.error(`[start-all] ${error.message || error}`);
  process.exitCode = 1;
} finally {
  stopManagedChildren();
}
