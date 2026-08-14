import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const scanRoots = ["frontend", "src", "scripts", "tools", "electron"];
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".vue"]);
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(/\.\d{3}Z$/, "Z");

async function listSourceFiles(relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  const rows = [];
  const pending = [absoluteRoot];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "public") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        rows.push(absolutePath);
      }
    }
  }
  return rows;
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return "";
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function importSpecifiers(source) {
  const rows = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) rows.push(match[1]);
  }
  return rows;
}

async function resolveLocalImport(importer, specifier) {
  if (!specifier.startsWith(".")) return "";
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...[...sourceExtensions].map((extension) => `${base}${extension}`),
    ...[...sourceExtensions].map((extension) => path.join(base, `index${extension}`))
  ];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

const files = (await Promise.all(scanRoots.map(listSourceFiles))).flat();
files.push(path.join(rootDir, "vite.config.js"));
const productionFiles = new Set(files.map((item) => path.normalize(item)));
const referenceFiles = [...files, ...(await listSourceFiles("test"))];

const sourceRows = [];
const referencedFiles = new Set();
const importedPackages = new Map();
for (const absolutePath of referenceFiles) {
  const source = await fs.readFile(absolutePath, "utf8");
  const specifiers = importSpecifiers(source);
  for (const specifier of specifiers) {
    const dependency = packageName(specifier);
    if (dependency) {
      if (!importedPackages.has(dependency)) importedPackages.set(dependency, new Set());
      importedPackages.get(dependency).add(path.relative(rootDir, absolutePath));
      continue;
    }
    const resolved = await resolveLocalImport(absolutePath, specifier);
    if (resolved) referencedFiles.add(path.normalize(resolved));
  }
  if (productionFiles.has(path.normalize(absolutePath))) {
    sourceRows.push({
      relativePath: path.relative(rootDir, absolutePath).replaceAll("\\", "/"),
      absolutePath: path.normalize(absolutePath),
      bytes: Buffer.byteLength(source),
      lines: source.split(/\r?\n/).length,
      imports: specifiers.length
    });
  }
}

const packageScriptText = Object.values(packageJson.scripts || {}).join("\n");
const declaredDependencies = {
  ...(packageJson.dependencies || {}),
  ...(packageJson.devDependencies || {})
};
const dependencyRows = Object.entries(declaredDependencies).map(([name, version]) => ({
  name,
  version,
  importedBy: [...(importedPackages.get(name) || [])].sort(),
  referencedByPackageScripts: packageScriptText.includes(name)
}));

const entryPoints = new Set([
  "frontend/admin/main.js",
  "frontend/config/main.js",
  "src/server.js",
  "electron/main.cjs",
  "electron/preload.cjs"
].map((item) => path.normalize(path.join(rootDir, item))));

const orphanCandidates = sourceRows
  .filter((item) => item.relativePath.startsWith("frontend/") || item.relativePath.startsWith("src/"))
  .filter((item) => !entryPoints.has(item.absolutePath))
  .filter((item) => !referencedFiles.has(item.absolutePath))
  .map(({ relativePath, lines, bytes }) => ({ relativePath, lines, bytes }))
  .sort((a, b) => b.bytes - a.bytes);

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    sourceFiles: sourceRows.length,
    sourceLines: sourceRows.reduce((sum, item) => sum + item.lines, 0),
    declaredDependencies: dependencyRows.length,
    dependencyCandidates: dependencyRows.filter((item) => !item.importedBy.length && !item.referencedByPackageScripts).length,
    orphanCandidates: orphanCandidates.length
  },
  dependencyCandidates: dependencyRows.filter((item) => !item.importedBy.length && !item.referencedByPackageScripts),
  dependencies: dependencyRows,
  orphanCandidates,
  largestFiles: sourceRows.sort((a, b) => b.lines - a.lines).slice(0, 30)
    .map(({ relativePath, lines, bytes, imports }) => ({ relativePath, lines, bytes, imports }))
};

const markdown = [
  "# Code health audit",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  "Candidates require manual review. This audit does not delete files.",
  "",
  "## Summary",
  "",
  `- Source files: ${report.summary.sourceFiles}`,
  `- Approximate lines: ${report.summary.sourceLines}`,
  `- Declared dependencies: ${report.summary.declaredDependencies}`,
  `- Dependency candidates: ${report.summary.dependencyCandidates}`,
  `- Orphan file candidates: ${report.summary.orphanCandidates}`,
  "",
  "## Dependency candidates",
  "",
  "| Package | Version |",
  "| --- | --- |",
  ...report.dependencyCandidates.map((item) => `| ${item.name} | ${item.version} |`),
  "",
  "## Orphan file candidates",
  "",
  "| File | Lines |",
  "| --- | ---: |",
  ...report.orphanCandidates.map((item) => `| ${item.relativePath} | ${item.lines} |`),
  "",
  "## Largest files",
  "",
  "| File | Lines | Imports |",
  "| --- | ---: | ---: |",
  ...report.largestFiles.map((item) => `| ${item.relativePath} | ${item.lines} | ${item.imports} |`),
  ""
].join("\n");

const outputDir = path.join(rootDir, "tmp");
await fs.mkdir(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, `code-health-audit-${timestamp}.json`);
const markdownPath = path.join(outputDir, `code-health-audit-${timestamp}.md`);
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(markdownPath, markdown, "utf8");
console.log(`Code health audit JSON: ${jsonPath}`);
console.log(`Code health audit Markdown: ${markdownPath}`);
