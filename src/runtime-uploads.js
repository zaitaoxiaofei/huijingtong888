import fs from "node:fs";
import path from "node:path";

loadRuntimeEnvFile();

export function resolveRuntimeProjectRoot(cwd = process.cwd()) {
  const root = path.resolve(cwd || ".");
  const name = path.basename(root).toLowerCase();
  const parentName = path.basename(path.dirname(root)).toLowerCase();
  if (parentName === "dist" && ["deploy", "live", "preview"].includes(name)) {
    return path.resolve(root, "..", "..");
  }
  return root;
}

export function resolvePersistentUploadsRoot({ cwd = process.cwd(), env = process.env } = {}) {
  const root = path.resolve(cwd || ".");
  const configured = String(env.UPLOADS_ROOT || env.PERSISTENT_UPLOADS_DIR || "").trim();
  if (configured) return path.resolve(root, configured);
  return path.resolve(resolveRuntimeProjectRoot(root), "uploads");
}

export function resolveUploadSubdir(subdir = "", options = {}) {
  return path.resolve(resolvePersistentUploadsRoot(options), subdir);
}

export function resolveUploadSubdirRoots(subdir = "", { cwd = process.cwd(), env = process.env } = {}) {
  const root = path.resolve(cwd || ".");
  const projectRoot = resolveRuntimeProjectRoot(root);
  return uniquePaths([
    resolveUploadSubdir(subdir, { cwd: root, env }),
    path.resolve(root, "uploads", subdir),
    path.resolve(projectRoot, "uploads", subdir)
  ]);
}

function loadRuntimeEnvFile() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

function uniquePaths(paths = []) {
  const normalized = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    if (!normalized.includes(resolved)) normalized.push(resolved);
  }
  return normalized;
}
