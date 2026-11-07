import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const envPath = path.resolve(rootDir, ".env");
const requiredKeys = [
  "DB_HOST",
  "DB_NAME",
  "DB_USER",
  "APP_BASE_URL",
  "HEALTH_CHECK_USERNAME",
  "HEALTH_CHECK_PASSWORD"
];

function parseEnvFile(text = "") {
  const values = {};
  const invalidLines = [];
  for (const [index, rawLine] of String(text || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      invalidLines.push(index + 1);
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalidLines.push(index + 1);
      continue;
    }
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { values, invalidLines };
}

let envText = "";
try {
  envText = await fs.readFile(envPath, "utf8");
} catch (error) {
  console.error(`[deploy-preflight] Missing .env at ${envPath}`);
  process.exit(1);
}

const { values: envValues, invalidLines } = parseEnvFile(envText);
const failures = requiredKeys.filter((key) => !String(envValues[key] || "").trim());

if (invalidLines.length) {
  console.error(`[deploy-preflight] Invalid .env syntax at line(s): ${invalidLines.join(", ")}. Expected KEY=VALUE.`);
}

if (failures.length || invalidLines.length) {
  for (const key of failures) {
    console.error(`[deploy-preflight] Missing or empty required key: ${key}`);
  }
  process.exit(1);
}

console.log(`[deploy-preflight] Environment checks passed for ${envPath}`);
