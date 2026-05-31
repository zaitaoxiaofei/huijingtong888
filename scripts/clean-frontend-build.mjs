import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const frontendOutputDir = path.resolve(rootDir, "public", "vue-apps");
const adminHtmlPath = path.resolve(rootDir, "public", "admin.html");
const adminCompressedPaths = [
  path.resolve(rootDir, "public", "admin.html.br"),
  path.resolve(rootDir, "public", "admin.html.gz")
];
const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 250 };
const removeFileOptions = { force: true, maxRetries: 10, retryDelay: 250 };

await fs.rm(frontendOutputDir, removeOptions);
await fs.rm(adminHtmlPath, removeFileOptions);
for (const compressedPath of adminCompressedPaths) {
  await fs.rm(compressedPath, removeFileOptions);
}
await fs.mkdir(frontendOutputDir, { recursive: true });

console.log(`Cleaned frontend build output: ${frontendOutputDir}`);
