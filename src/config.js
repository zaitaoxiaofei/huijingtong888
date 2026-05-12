import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

export const config = {
  port: Number(process.env.PORT || 8787),
  databasePath: process.env.DATABASE_PATH || "./data/ozon-profit-hub.sqlite",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:8787"
};
