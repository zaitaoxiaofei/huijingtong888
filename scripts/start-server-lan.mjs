import os from "node:os";

function privateIpv4Score(address) {
  if (/^192\.168\./.test(address)) return 30;
  if (/^10\./.test(address)) return 20;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 10;
  return 0;
}

function localLanIpv4() {
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address)
    .filter(Boolean)
    .sort((left, right) => privateIpv4Score(right) - privateIpv4Score(left));
  return candidates[0] || "127.0.0.1";
}

process.env.PORT ||= "8788";
process.env.HOST ||= "0.0.0.0";

const lanIp = process.env.LAN_IP || localLanIpv4();
process.env.APP_BASE_URL ||= `http://${lanIp}:${process.env.PORT}`;

console.log(`[lan] ERP login node: ${process.env.APP_BASE_URL}`);
console.log("[lan] Share this URL with coworkers on the same LAN.");
console.log("[lan] Ozon listing media still needs LISTING_MEDIA_PUBLIC_BASE_URL with a public HTTPS domain.");

await import("../src/server.js");
