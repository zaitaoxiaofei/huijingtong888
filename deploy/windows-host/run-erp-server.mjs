import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = Math.max(1, Number(process.env.ERP_LOG_MAX_MB || 20)) * 1024 * 1024;
const LOG_ARCHIVES = Math.min(30, Math.max(1, Number(process.env.ERP_LOG_ARCHIVES || 7)));
const logDir = path.resolve(process.env.ERP_LOG_DIR || "logs");

fs.mkdirSync(logDir, { recursive: true });

function rotate(logPath) {
  for (let index = LOG_ARCHIVES; index >= 1; index -= 1) {
    const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
    const target = `${logPath}.${index}`;
    if (!fs.existsSync(source)) continue;
    if (index === LOG_ARCHIVES) fs.rmSync(target, { force: true });
    fs.renameSync(source, target);
  }
}

function appendRotated(logPath, chunk) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const currentSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  if (currentSize > 0 && currentSize + data.length > MAX_LOG_BYTES) rotate(logPath);
  fs.appendFileSync(logPath, data);
}

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => appendRotated(path.join(logDir, "erp-server.out.log"), chunk));
child.stderr.on("data", (chunk) => appendRotated(path.join(logDir, "erp-server.err.log"), chunk));
child.on("error", (error) => {
  appendRotated(path.join(logDir, "erp-server.err.log"), `${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
