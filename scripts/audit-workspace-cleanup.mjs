import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const outputDir = path.resolve(rootDir, "tmp");
const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(/\.\d{3}Z$/, "Z");

const targets = [
  { relativePath: "dist", category: "generated", action: "review" },
  { relativePath: "public/uploads", category: "business-assets", action: "protect" },
  { relativePath: "uploads", category: "business-assets", action: "protect" },
  { relativePath: "runtime", category: "runtime", action: "protect" },
  { relativePath: "backups", category: "legacy-backups", action: "review" },
  { relativePath: "logs", category: "logs", action: "review" },
  { relativePath: ".codex-chrome-8788-profile", category: "temporary", action: "review" },
  { relativePath: ".work-backups", category: "temporary", action: "review" },
  { relativePath: ".work-logs", category: "temporary", action: "review" },
  { relativePath: ".codex-logs", category: "temporary", action: "review" },
  { relativePath: ".server-logs", category: "temporary", action: "review" },
  { relativePath: "tmp", category: "temporary", action: "review" }
];

const distChildren = [
  "dist/deploy/backups",
  "dist/deploy-prev",
  "dist/releases",
  "dist/preview",
  "dist/deploy-next",
  "dist/deploy-next-latest",
  "dist/desktop"
];

async function inspectTree(absolutePath) {
  const result = { bytes: 0, files: 0, directories: 0, errors: [] };
  const pending = [absolutePath];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      result.errors.push({ path: path.relative(rootDir, current), code: error?.code || "UNKNOWN" });
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result.directories += 1;
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      result.files += 1;
      try {
        const stat = await fs.stat(entryPath);
        result.bytes += stat.size;
      } catch (error) {
        result.errors.push({ path: path.relative(rootDir, entryPath), code: error?.code || "UNKNOWN" });
      }
    }
  }
  return result;
}

async function inspectTarget(target) {
  const absolutePath = path.resolve(rootDir, target.relativePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat) return { ...target, exists: false, bytes: 0, files: 0, directories: 0, errors: [] };
  if (stat.isFile()) {
    return { ...target, exists: true, bytes: stat.size, files: 1, directories: 0, errors: [] };
  }
  return { ...target, exists: true, ...(await inspectTree(absolutePath)) };
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

async function inspectRootTemporaryFiles() {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const matches = entries.filter((entry) => (
    entry.isFile()
    && (
      /^tmp[-.]/i.test(entry.name)
      || /\.(?:log|out|err)(?:\.log)?$/i.test(entry.name)
      || /^server.*\.log$/i.test(entry.name)
      || /^app-.*\.log$/i.test(entry.name)
    )
  ));
  const files = [];
  for (const entry of matches) {
    const stat = await fs.stat(path.join(rootDir, entry.name));
    files.push({ relativePath: entry.name, bytes: stat.size });
  }
  return files.sort((a, b) => b.bytes - a.bytes);
}

const inspectedTargets = [];
for (const target of targets) {
  inspectedTargets.push(await inspectTarget(target));
}

const inspectedDistChildren = [];
for (const relativePath of distChildren) {
  inspectedDistChildren.push(await inspectTarget({
    relativePath,
    category: "generated",
    action: "review"
  }));
}

const rootTemporaryFiles = await inspectRootTemporaryFiles();
const report = {
  generatedAt: new Date().toISOString(),
  rootDir,
  policy: {
    protect: "Do not delete without database and source-reference verification.",
    review: "Candidate only. Requires explicit approval before deletion."
  },
  targets: inspectedTargets,
  distChildren: inspectedDistChildren,
  rootTemporaryFiles,
  totals: {
    reviewBytes: inspectedTargets
      .filter((item) => item.action === "review")
      .reduce((sum, item) => sum + item.bytes, 0),
    protectedBytes: inspectedTargets
      .filter((item) => item.action === "protect")
      .reduce((sum, item) => sum + item.bytes, 0),
    rootTemporaryBytes: rootTemporaryFiles.reduce((sum, item) => sum + item.bytes, 0)
  }
};

const markdown = [
  "# Workspace cleanup audit",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  "This report is read-only. No files were deleted.",
  "",
  "## Top-level targets",
  "",
  "| Path | Category | Action | Size | Files |",
  "| --- | --- | --- | ---: | ---: |",
  ...report.targets.map((item) => (
    `| ${item.relativePath} | ${item.category} | ${item.action} | ${formatBytes(item.bytes)} | ${item.files} |`
  )),
  "",
  "## Generated deployment candidates",
  "",
  "| Path | Size | Files |",
  "| --- | ---: | ---: |",
  ...report.distChildren.map((item) => (
    `| ${item.relativePath} | ${formatBytes(item.bytes)} | ${item.files} |`
  )),
  "",
  "## Root temporary files",
  "",
  "| Path | Size |",
  "| --- | ---: |",
  ...report.rootTemporaryFiles.map((item) => `| ${item.relativePath} | ${formatBytes(item.bytes)} |`),
  "",
  "## Totals",
  "",
  `- Review candidates: ${formatBytes(report.totals.reviewBytes)}`,
  `- Protected business/runtime data: ${formatBytes(report.totals.protectedBytes)}`,
  `- Root temporary files: ${formatBytes(report.totals.rootTemporaryBytes)}`,
  ""
].join("\n");

await fs.mkdir(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, `cleanup-audit-${timestamp}.json`);
const markdownPath = path.join(outputDir, `cleanup-audit-${timestamp}.md`);
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(markdownPath, markdown, "utf8");

console.log(`Cleanup audit JSON: ${jsonPath}`);
console.log(`Cleanup audit Markdown: ${markdownPath}`);
