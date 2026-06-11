import net from "node:net";
import os from "node:os";

const port = Number(process.env.PORT || 8788);
const timeoutMs = Number(process.env.LOCAL_ACCESS_TIMEOUT_MS || 3000);

function privateIpv4Score(address) {
  if (/^192\.168\./.test(address)) return 30;
  if (/^10\./.test(address)) return 20;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 10;
  return 0;
}

function localLanIpv4() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address)
    .filter(Boolean)
    .sort((left, right) => privateIpv4Score(right) - privateIpv4Score(left))[0] || "";
}

function canConnect(host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function httpStatus(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

const lanIp = process.env.LAN_IP || localLanIpv4();
const checks = [
  { label: "localhost", host: "127.0.0.1", url: `http://localhost:${port}/admin.html` }
];
if (lanIp) checks.push({ label: "LAN IP", host: lanIp, url: `http://${lanIp}:${port}/admin.html` });

const results = [];
for (const check of checks) {
  const tcpOpen = await canConnect(check.host);
  const status = tcpOpen ? await httpStatus(check.url) : 0;
  results.push({ ...check, tcpOpen, status });
}

for (const result of results) {
  const httpText = result.status ? `HTTP ${result.status}` : "HTTP unavailable";
  console.log(`${result.label}: ${result.url} -> TCP ${result.tcpOpen ? "open" : "closed"}, ${httpText}`);
}

const localhost = results.find((item) => item.label === "localhost");
const lan = results.find((item) => item.label === "LAN IP");

if (!localhost?.tcpOpen) {
  console.error(`Local ERP is not listening on port ${port}. Start it with: npm run start:server`);
  process.exit(1);
}

if (lan && !lan.tcpOpen) {
  console.error(`localhost works, but ${lan.host}:${port} is closed. Use http://localhost:${port}/admin.html locally, or start LAN mode with: npm run start:lan`);
  process.exit(2);
}

console.log("Local ERP access check passed.");
