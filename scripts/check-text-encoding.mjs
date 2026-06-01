import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skippedDirectories = new Set([
  ".git",
  ".codex-run",
  ".server-logs",
  ".work-backups",
  ".work-logs",
  ".workbuddy",
  "backups",
  "data",
  "dist",
  "logs",
  "node_modules",
  "public",
  "runtime",
  "tmp",
  "tools",
  "uploads"
]);

const textExtensions = new Set([
  ".bat",
  ".cmd",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".sql",
  ".txt",
  ".vue",
  ".yml"
]);

const suspiciousTerms = [
  "\uFFFD",
  "\u952F",
  "\u9416",
  "\u920B",
  "\u93C3",
  "\u6D60?",
  "\u6D93\u5D85",
  "\u95B0\u5DB7",
  "\u74E8\u9359"
];

const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        await walk(path.join(directory, entry.name));
      }
      continue;
    }

    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;

    const relativePath = path.relative(root, filePath).replaceAll(path.sep, "/");
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (suspiciousTerms.some((term) => line.includes(term))) {
        findings.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

await walk(root);

if (findings.length) {
  console.error("Found suspicious mojibake or replacement characters:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Text encoding check passed.");
