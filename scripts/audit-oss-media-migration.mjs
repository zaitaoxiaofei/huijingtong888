import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".3gp", ".avi", ".flv", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ts", ".webm", ".wmv"]);
const TEMP_EXTENSIONS = new Set([".bak", ".crdownload", ".download", ".part", ".temp", ".tmp"]);
const TEXTUAL_MYSQL_TYPES = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "json"]);
const URL_PATTERN = /(?:data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+|(?:https?:)?\/\/[^\s"'<>\\]+|\/uploads\/[^\s"'<>\\]+)/gi;

function emptyKinds() {
  return { image: { files: 0, bytes: 0 }, video: { files: 0, bytes: 0 }, temporary: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } };
}

export function classifyFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const extension = path.extname(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (TEMP_EXTENSIONS.has(extension) || /(?:^|[._-])(?:temp|tmp)(?:[._-]|$)/i.test(name)) return "temporary";
  return "other";
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function scanMediaDirectories({ rootDir, mediaDirectories = ["uploads", "public/uploads"] }) {
  const directories = [];
  const files = [];
  const errors = [];
  for (const relativeDirectory of mediaDirectories) {
    const absoluteDirectory = path.resolve(rootDir, relativeDirectory);
    const directory = { path: relativeDirectory.replaceAll("\\", "/"), exists: false, files: 0, bytes: 0, kinds: emptyKinds() };
    directories.push(directory);
    const stat = await fsp.stat(absoluteDirectory).catch(() => null);
    if (!stat?.isDirectory()) continue;
    directory.exists = true;
    const pending = [absoluteDirectory];
    while (pending.length) {
      const current = pending.pop();
      let entries;
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch (error) {
        errors.push({ path: path.relative(rootDir, current).replaceAll("\\", "/"), code: error?.code || "UNKNOWN" });
        continue;
      }
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const fileStat = await fsp.stat(absolutePath);
          const kind = classifyFile(entry.name);
          const extension = path.extname(entry.name).toLowerCase() || "[none]";
          const item = {
            path: path.relative(rootDir, absolutePath).replaceAll("\\", "/"),
            bytes: fileStat.size,
            extension,
            kind,
            sha256: await sha256(absolutePath)
          };
          files.push(item);
          directory.files += 1;
          directory.bytes += item.bytes;
          directory.kinds[kind].files += 1;
          directory.kinds[kind].bytes += item.bytes;
        } catch (error) {
          errors.push({ path: path.relative(rootDir, absolutePath).replaceAll("\\", "/"), code: error?.code || "UNKNOWN" });
        }
      }
    }
  }
  const extensions = {};
  const hashes = new Map();
  for (const file of files) {
    extensions[file.extension] ||= { files: 0, bytes: 0 };
    extensions[file.extension].files += 1;
    extensions[file.extension].bytes += file.bytes;
    const group = hashes.get(file.sha256) || [];
    group.push(file);
    hashes.set(file.sha256, group);
  }
  const duplicateGroups = [...hashes.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({ sha256: hash, files: group.map((item) => item.path), fileCount: group.length, bytesEach: group[0].bytes, reclaimableBytes: group[0].bytes * (group.length - 1) }))
    .sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  return {
    directories,
    totals: { files: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0) },
    extensions: Object.fromEntries(Object.entries(extensions).sort(([a], [b]) => a.localeCompare(b))),
    duplicateGroups,
    errors
  };
}

function redactReference(value) {
  if (/^data:image\//i.test(value)) return `[data:image;base64 redacted, ${value.length} chars]`;
  try {
    const parsed = new URL(value.startsWith("//") ? `https:${value}` : value, "http://local.invalid");
    parsed.search = "";
    parsed.hash = "";
    return value.startsWith("/") ? `${parsed.pathname}` : parsed.toString().slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function isOssUrl(value, ossHosts) {
  if (!/^(?:https?:)?\/\//i.test(value)) return false;
  const host = new URL(value.startsWith("//") ? `https:${value}` : value).hostname.toLowerCase();
  return host.endsWith(".aliyuncs.com") || ossHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function localCandidates(rootDir, reference) {
  const clean = decodeURIComponent(String(reference).split(/[?#]/, 1)[0]).replaceAll("\\", "/");
  if (!clean.startsWith("/uploads/")) return [];
  const suffix = clean.slice("/uploads/".length);
  if (!suffix || suffix.split("/").includes("..")) return [];
  return [path.resolve(rootDir, "uploads", suffix), path.resolve(rootDir, "public", "uploads", suffix)];
}

function extractReferences(value) {
  if (value === null || value === undefined) return [];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.match(URL_PATTERN) || [];
}

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replaceAll("`", "``")}\``;
}

export async function auditMysqlReferences({ connection, database, rootDir, ossHosts = [], batchSize = 500, sampleLimit = 100 }) {
  const [columnRows] = await connection.query(
    "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
    [database]
  );
  const columns = columnRows.filter((row) => TEXTUAL_MYSQL_TYPES.has(String(row.DATA_TYPE).toLowerCase()));
  const result = {
    scannedColumns: columns.length,
    scannedRows: 0,
    categories: { dataImageBase64: 0, localUploads: 0, oss: 0, external: 0 },
    missingLocalFiles: 0,
    samples: [],
    errors: []
  };
  for (const column of columns) {
    let offset = 0;
    for (;;) {
      let rows;
      try {
        [rows] = await connection.query(
          `SELECT ${quoteIdentifier(column.COLUMN_NAME)} AS audit_value FROM ${quoteIdentifier(column.TABLE_NAME)} WHERE ${quoteIdentifier(column.COLUMN_NAME)} IS NOT NULL LIMIT ? OFFSET ?`,
          [batchSize, offset]
        );
      } catch (error) {
        result.errors.push({ table: column.TABLE_NAME, column: column.COLUMN_NAME, code: error?.code || "QUERY_FAILED" });
        break;
      }
      result.scannedRows += rows.length;
      for (const row of rows) {
        for (const reference of extractReferences(row.audit_value)) {
          let category;
          let missing = false;
          if (/^data:image\//i.test(reference)) category = "dataImageBase64";
          else if (reference.startsWith("/uploads/")) {
            category = "localUploads";
            const candidates = localCandidates(rootDir, reference);
            missing = candidates.length === 0 || !candidates.some((candidate) => fs.existsSync(candidate));
            if (missing) result.missingLocalFiles += 1;
          } else if (isOssUrl(reference, ossHosts)) category = "oss";
          else category = "external";
          result.categories[category] += 1;
          if (result.samples.length < sampleLimit) {
            result.samples.push({ table: column.TABLE_NAME, column: column.COLUMN_NAME, category, missingLocalFile: missing, reference: redactReference(reference) });
          }
        }
      }
      if (rows.length < batchSize) break;
      offset += rows.length;
    }
  }
  return result;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

export function renderMarkdown(report) {
  const lines = [
    "# OSS 历史媒体迁移审计报告",
    "",
    `生成时间（北京时间）：${report.generatedAtBeijing}`,
    "",
    "> 本报告由只读审计生成：未上传、移动、删除文件，未更新数据库。报告不包含数据库密码或 OSS AccessKey。",
    "",
    "## 文件扫描汇总",
    "",
    "| 目录 | 是否存在 | 文件数 | 大小 | 图片 | 视频 | 临时文件 | 其他 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.files.directories.map((item) => `| ${item.path} | ${item.exists ? "是" : "否"} | ${item.files} | ${formatBytes(item.bytes)} | ${item.kinds.image.files} | ${item.kinds.video.files} | ${item.kinds.temporary.files} | ${item.kinds.other.files} |`),
    "",
    `总计：${report.files.totals.files} 个文件，${formatBytes(report.files.totals.bytes)}。重复哈希组：${report.files.duplicateGroups.length}。`,
    "",
    "## 扩展名统计",
    "",
    "| 扩展名 | 文件数 | 大小 |",
    "| --- | ---: | ---: |",
    ...Object.entries(report.files.extensions).map(([extension, value]) => `| ${extension} | ${value.files} | ${formatBytes(value.bytes)} |`),
    "",
    "## 重复哈希",
    "",
    ...(report.files.duplicateGroups.length ? report.files.duplicateGroups.flatMap((group) => [`- \`${group.sha256}\`：${group.fileCount} 个文件，可重复占用 ${formatBytes(group.reclaimableBytes)}`, ...group.files.map((file) => `  - ${file}`)]) : ["无重复哈希组。"]),
    "",
    "## MySQL 媒体地址审计",
    ""
  ];
  if (report.mysql.skipped) lines.push(`MySQL 扫描已跳过：${report.mysql.reason}`);
  else lines.push(
    `扫描文本/JSON 列：${report.mysql.scannedColumns}；扫描非空行值：${report.mysql.scannedRows}。`,
    "",
    `- data:image Base64：${report.mysql.categories.dataImageBase64}`,
    `- /uploads 本地地址：${report.mysql.categories.localUploads}`,
    `- 已有 OSS 地址：${report.mysql.categories.oss}`,
    `- 外部地址：${report.mysql.categories.external}`,
    `- 地址存在但本地文件缺失：${report.mysql.missingLocalFiles}`,
    "",
    "### 脱敏样本",
    "",
    "| 表 | 列 | 分类 | 本地缺失 | 地址（已移除查询参数/Base64 内容） |",
    "| --- | --- | --- | --- | --- |",
    ...report.mysql.samples.map((item) => `| ${item.table} | ${item.column} | ${item.category} | ${item.missingLocalFile ? "是" : "否"} | ${item.reference.replaceAll("|", "\\|")} |`)
  );
  lines.push("", "## 扫描错误", "", `文件扫描错误：${report.files.errors.length}；MySQL 扫描错误：${report.mysql.errors?.length || 0}。`, "");
  return lines.join("\n");
}

function beijingTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date).replaceAll("/", "-");
}

function parseArgs(argv) {
  const options = { noDb: false, outputDir: "tmp", mediaDirectories: ["uploads", "public/uploads"] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-db") options.noDb = true;
    else if (argument === "--output-dir") options.outputDir = argv[++index];
    else if (argument === "--media-dir") options.mediaDirectories.push(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function runAudit({ rootDir = process.cwd(), outputDir = "tmp", mediaDirectories = ["uploads", "public/uploads"], connection = null, database = process.env.DB_NAME, noDb = false, now = new Date() } = {}) {
  const files = await scanMediaDirectories({ rootDir, mediaDirectories });
  let ownedConnection = null;
  let mysql;
  if (noDb) mysql = { skipped: true, reason: "--no-db", errors: [] };
  else {
    if (!connection) {
      const { createMysqlConnection } = await import("./mysql-runtime.mjs");
      const { config } = await import("../src/config.js");
      database ||= config.dbName;
      ownedConnection = await createMysqlConnection({ multipleStatements: false });
      connection = ownedConnection;
    }
    const hosts = [process.env.OSS_ENDPOINT, process.env.OSS_CDN_DOMAIN, process.env.LISTING_MEDIA_PUBLIC_BASE_URL]
      .filter(Boolean)
      .map((value) => {
        try { return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase(); } catch { return ""; }
      })
      .filter(Boolean);
    try {
      mysql = await auditMysqlReferences({ connection, database, rootDir, ossHosts: hosts });
    } finally {
      if (ownedConnection) await ownedConnection.end();
    }
  }
  const report = { schemaVersion: 1, generatedAt: now.toISOString(), generatedAtBeijing: beijingTimestamp(now), mode: "read-only", rootDir, files, mysql };
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const absoluteOutput = path.resolve(rootDir, outputDir);
  await fsp.mkdir(absoluteOutput, { recursive: true });
  const jsonPath = path.join(absoluteOutput, `oss-media-migration-audit-${stamp}.json`);
  const markdownPath = path.join(absoluteOutput, `oss-media-migration-audit-${stamp}.md`);
  await fsp.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fsp.writeFile(markdownPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, markdownPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/audit-oss-media-migration.mjs [--no-db] [--output-dir DIR]");
    return;
  }
  const result = await runAudit(options);
  console.log(`JSON report: ${result.jsonPath}`);
  console.log(`Markdown report: ${result.markdownPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
