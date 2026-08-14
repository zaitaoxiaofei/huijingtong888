import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = process.cwd();
const sourceRoot = path.join(rootDir, "src");
const sourceExtensions = new Set([".js", ".mjs", ".cjs"]);

function findClosingParen(source, openIndex) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelList(source) {
  const items = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      items.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(source.slice(start).trim());
  return items.filter(Boolean);
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function auditSqlSource(source, file = "<source>") {
  const findings = [];
  const insertPattern = /\bINSERT\s+INTO\s+([`\w.]+)\s*\(/gi;
  for (const match of source.matchAll(insertPattern)) {
    const table = match[1].replaceAll("`", "");
    const columnsOpen = match.index + match[0].lastIndexOf("(");
    const columnsClose = findClosingParen(source, columnsOpen);
    if (columnsClose < 0) continue;
    const valuesMatch = /^\s*VALUES\s*\(/i.exec(source.slice(columnsClose + 1));
    if (!valuesMatch) continue;
    const valuesOpen = columnsClose + 1 + valuesMatch[0].lastIndexOf("(");
    const valuesClose = findClosingParen(source, valuesOpen);
    if (valuesClose < 0) continue;
    const columns = splitTopLevelList(source.slice(columnsOpen + 1, columnsClose));
    const values = splitTopLevelList(source.slice(valuesOpen + 1, valuesClose));
    if (columns.length !== values.length) {
      findings.push({
        file,
        line: lineNumber(source, match.index),
        table,
        columns: columns.length,
        values: values.length
      });
    }
  }
  return findings;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

export async function auditProjectSqlBindings() {
  const findings = [];
  for (const filePath of await sourceFiles(sourceRoot)) {
    const relativePath = path.relative(rootDir, filePath).replaceAll(path.sep, "/");
    findings.push(...auditSqlSource(await readFile(filePath, "utf8"), relativePath));
  }
  return findings;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const findings = await auditProjectSqlBindings();
  if (findings.length) {
    console.error("SQL INSERT column/value mismatches found:");
    for (const finding of findings) {
      console.error(`- ${finding.file}:${finding.line} ${finding.table}: ${finding.columns} columns, ${finding.values} values`);
    }
    process.exit(1);
  }
  console.log("SQL binding check passed.");
}
