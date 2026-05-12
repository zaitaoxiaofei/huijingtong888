import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function maintenanceScriptPath(name) {
  const scriptPath = path.resolve("scripts", `${name}-data.ps1`);
  if (!fs.existsSync(scriptPath)) throw new Error(`缁存姢鑴氭湰涓嶅瓨鍦細${scriptPath}`);
  return scriptPath;
}

export function systemInfo() {
  const databasePath = path.resolve(config.databasePath);
  const databaseExists = fs.existsSync(databasePath);
  const stat = databaseExists ? fs.statSync(databasePath) : null;
  return {
    host: config.host || "",
    port: config.port,
    databasePath,
    databaseExists,
    databaseSizeBytes: stat?.size || 0,
    appBaseUrl: config.appBaseUrl
  };
}

export async function runDataBackup() {
  const scriptPath = maintenanceScriptPath("backup");
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 1024 * 1024 * 4
  });
  return {
    ok: true,
    message: "澶囦唤瀹屾垚锛屽浠藉寘宸蹭繚瀛樺埌 backups 鐩綍銆?",
    stdout: stdout?.slice(-4000) || "",
    stderr: stderr?.slice(-4000) || ""
  };
}

export function startDataRestore() {
  const scriptPath = maintenanceScriptPath("restore");
  const projectRoot = process.cwd();
  const nodePath = process.execPath;
  const serverLog = path.resolve("server.log");
  const serverErrLog = path.resolve("server.err.log");
  const restoreLog = path.resolve("restore-data.log");
  const restoreErrLog = path.resolve("restore-data.err.log");
  const command = [
    "$ErrorActionPreference = 'Continue'",
    "Start-Sleep -Seconds 1",
    `Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue`,
    `& ${psQuote(scriptPath)} 1>> ${psQuote(restoreLog)} 2>> ${psQuote(restoreErrLog)}`,
    `Start-Process -FilePath ${psQuote(nodePath)} -ArgumentList 'src/server.js' -WorkingDirectory ${psQuote(projectRoot)} -WindowStyle Hidden -RedirectStandardOutput ${psQuote(serverLog)} -RedirectStandardError ${psQuote(serverErrLog)}`
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return {
    ok: true,
    message: "鎭㈠浠诲姟宸插惎鍔ㄣ€傛湇鍔′細鐭殏鏂紑骞惰嚜鍔ㄩ噸鍚紝璇?5-10 绉掑悗鍒锋柊椤甸潰銆?"
  };
}
