import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

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

// Builds do not need to copy production credentials onto the build machine.
// In explicit SSH mode, validate the active production environment in place and return only names/status.
const remoteTarget=process.env.OZON_DEPLOY_PREFLIGHT_SSH_TARGET;
if(remoteTarget){
  if(!/^[a-zA-Z0-9_@.:-]+$/.test(remoteTarget)||remoteTarget.startsWith('-'))throw new Error('Invalid preflight SSH target');
  const identity=process.env.OZON_DEPLOY_PREFLIGHT_SSH_IDENTITY;
  if(!identity)throw new Error('Remote preflight requires an explicit SSH identity');
  const python='import os,sys; keys='+JSON.stringify(requiredKeys)+'; missing=[k for k in keys if not os.environ.get(k, "").strip()]; print("[deploy-preflight] Remote missing keys: "+", ".join(missing) if missing else "[deploy-preflight] Remote environment checks passed"); sys.exit(1 if missing else 0)';
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  execFileSync('ssh',['-o','BatchMode=yes','-i',identity,remoteTarget,'set -a; . /etc/ozon-erp/ozon-erp.env; set +a; python3 -c '+quote(python)],{stdio:'inherit',timeout:30000});
  process.exit(0);
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
