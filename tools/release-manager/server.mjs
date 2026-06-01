import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(toolDir, "release.config.json");

function resolveFromTool(value) {
  return path.resolve(toolDir, value || "");
}

async function readConfig() {
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    ...raw,
    projectDir: resolveFromTool(raw.projectDir || "../.."),
    deployOutputDir: resolveFromTool(raw.deployOutputDir || "../../dist/deploy"),
    releasesDir: resolveFromTool(raw.releasesDir || "../../dist/releases"),
    liveDir: resolveFromTool(raw.liveDir || "../../dist/live"),
    currentFile: resolveFromTool(raw.currentFile || "../../dist/releases/current.json"),
    publishedFile: resolveFromTool(raw.publishedFile || "../../dist/releases/published-releases.json"),
    port: Number(process.env.RELEASE_TOOL_PORT || raw.port || 8791),
    channel: process.env.OZON_RELEASE_CHANNEL || raw.channel || "production"
  };
}

function json(res, payload, status = 200) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function shanghaiReleaseVersion(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const pick = (type) => parts.find((item) => item.type === type)?.value || "00";
  return `${pick("year")}.${pick("month")}.${pick("day")}.${pick("hour")}${pick("minute")}${pick("second")}`;
}

function cleanVersion(input) {
  return String(input || "").trim().replace(/[^0-9A-Za-z._-]/g, "-").replace(/-+/g, "-");
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(target, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return fallback;
  }
}

async function readPublishedRecords(config) {
  const payload = await readJsonFile(config.publishedFile, []);
  if (!Array.isArray(payload)) return [];
  const seen = new Set();
  const records = [];
  for (const item of payload) {
    const version = String(item?.version || "").trim();
    if (!version || seen.has(version)) continue;
    seen.add(version);
    records.push({
      version,
      channel: item.channel || config.channel,
      publishedAt: item.publishedAt || item.published_at || "",
      releaseDir: item.releaseDir || "",
      liveDir: item.liveDir || config.liveDir
    });
  }
  records.sort((a, b) => String(b.publishedAt || b.version).localeCompare(String(a.publishedAt || a.version)));
  return records;
}

async function savePublishedRecords(config, records) {
  await fs.mkdir(path.dirname(config.publishedFile), { recursive: true });
  await fs.writeFile(config.publishedFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

async function statIfExists(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function latestMtime(target, options = {}) {
  const stat = await statIfExists(target);
  if (!stat) return 0;
  const name = path.basename(target);
  if (options.skipNames?.has(name)) return 0;
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;
  let latest = stat.mtimeMs;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (options.skipNames?.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    latest = Math.max(latest, await latestMtime(child, options));
  }
  return latest;
}

async function workspaceStatus(config) {
  const scanTargets = [
    "frontend",
    "src",
    "scripts",
    "electron",
    "deploy",
    "package.json",
    "package-lock.json",
    "vite.config.js"
  ];
  const skipNames = new Set([".git", "node_modules", "dist", "data", "runtime", "public"]);
  let latest = 0;
  for (const item of scanTargets) {
    latest = Math.max(latest, await latestMtime(path.join(config.projectDir, item), { skipNames }));
  }
  return {
    projectDir: config.projectDir,
    sourceChangedAt: latest ? new Date(latest).toISOString() : "",
    nextVersion: shanghaiReleaseVersion()
  };
}

async function copyDir(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await fs.cp(source, target, { recursive: true });
}

async function replaceDirFromRelease(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stamp = Date.now().toString(36);
  const staging = `${target}.next-${stamp}`;
  const previous = `${target}.previous-${stamp}`;
  await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await fs.rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await fs.cp(source, staging, { recursive: true });
  if (await pathExists(target)) {
    await fs.rename(target, previous);
  }
  await fs.rename(staging, target);
  await fs.rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

function runCommand(command, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else {
        const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const tail = lines.slice(-8).join("\n");
        const error = new Error(`${command} 执行失败，退出码 ${code}`);
        error.detail = tail;
        reject(error);
      }
    });
  });
}

async function listReleases(config) {
  await fs.mkdir(config.releasesDir, { recursive: true });
  const entries = await fs.readdir(config.releasesDir, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const releaseDir = path.join(config.releasesDir, entry.name);
    const manifest = await readJsonFile(path.join(releaseDir, "deploy-manifest.json"), {});
    const release = await readJsonFile(path.join(releaseDir, "public", "release.json"), {});
    rows.push({
      version: entry.name,
      channel: manifest.channel || release.channel || config.channel,
      builtAt: manifest.builtAt || release.built_at || "",
      notes: manifest.notes || "",
      path: releaseDir
    });
  }
  rows.sort((a, b) => String(b.builtAt || b.version).localeCompare(String(a.builtAt || a.version)));
  return rows;
}

async function state() {
  const config = await readConfig();
  const current = await readJsonFile(config.currentFile, {});
  const releases = await listReleases(config);
  const storedPublishedRecords = await readPublishedRecords(config);
  const publishedRecords = current.version && !storedPublishedRecords.some((record) => record.version === current.version)
    ? [{
        version: current.version,
        channel: current.channel || config.channel,
        publishedAt: current.publishedAt || "",
        releaseDir: current.releaseDir || "",
        liveDir: current.liveDir || config.liveDir
      }, ...storedPublishedRecords]
    : storedPublishedRecords;
  const publishedMap = new Map(publishedRecords.map((record) => [record.version, record]));
  const liveManifest = await readJsonFile(path.join(config.liveDir, "deploy-manifest.json"), {});
  const workspace = await workspaceStatus(config);
  const latestRelease = releases[0] || null;
  const onlineVersion = current.version || "";
  const latestBuiltAt = latestRelease?.builtAt || "";
  const hasUnbuiltChanges = !latestRelease || (
    workspace.sourceChangedAt
    && latestBuiltAt
    && new Date(workspace.sourceChangedAt).getTime() > new Date(latestBuiltAt).getTime()
  );
  return {
    config: {
      port: config.port,
      projectDir: config.projectDir,
      releasesDir: config.releasesDir,
      liveDir: config.liveDir,
      currentFile: config.currentFile,
      publishedFile: config.publishedFile,
      buildCommand: config.buildCommand,
      channel: config.channel
    },
    workspace,
    pending: latestRelease,
    online: {
      version: onlineVersion,
      publishedAt: current.publishedAt || "",
      liveDir: config.liveDir,
      releaseDir: current.releaseDir || ""
    },
    hasUnbuiltChanges,
    nextVersion: workspace.nextVersion,
    current,
    live: liveManifest,
    releases: releases.map((release, index) => ({
      ...release,
      isLatest: index === 0,
      isPublished: publishedMap.has(release.version),
      publishedAt: publishedMap.get(release.version)?.publishedAt || "",
      isOnline: Boolean(onlineVersion && release.version === onlineVersion)
    })),
    publishedReleases: publishedRecords.map((record) => ({
      ...record,
      ...(releases.find((release) => release.version === record.version) || {}),
      isOnline: Boolean(onlineVersion && record.version === onlineVersion)
    }))
  };
}

async function buildRelease(body = {}) {
  const config = await readConfig();
  const version = cleanVersion(body.version) || shanghaiReleaseVersion();
  const releaseDir = path.join(config.releasesDir, version);
  if (await pathExists(releaseDir) && !body.overwrite) {
    const error = new Error(`Release ${version} already exists.`);
    error.status = 409;
    throw error;
  }
  const builtAt = new Date().toISOString();
  const env = {
    ...process.env,
    DEPLOY_OUTPUT_DIR: config.deployOutputDir,
    OZON_RELEASE_VERSION: version,
    APP_RELEASE_VERSION: version,
    VITE_APP_RELEASE_VERSION: version,
    OZON_RELEASE_CHANNEL: config.channel,
    VITE_APP_RELEASE_CHANNEL: config.channel,
    OZON_BUILD_STAMP: version.replace(/[^0-9A-Za-z]/g, "")
  };
  let buildLog = "";
  try {
    buildLog = await runCommand(config.buildCommand || "npm run package:deploy", config.projectDir, env);
  } catch (error) {
    error.status = 500;
    error.validation = {
      detail: error.detail || ""
    };
    throw error;
  }
  await copyDir(config.deployOutputDir, releaseDir);

  const deployManifestPath = path.join(releaseDir, "deploy-manifest.json");
  const manifest = await readJsonFile(deployManifestPath, {});
  await fs.writeFile(
    deployManifestPath,
    `${JSON.stringify({
      ...manifest,
      version,
      channel: config.channel,
      notes: String(body.notes || "").trim(),
      builtAt
    }, null, 2)}\n`,
    "utf8"
  );
  return {
    version,
    releaseDir,
    log: buildLog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12)
  };
}

async function publishRelease(body = {}) {
  const config = await readConfig();
  const version = cleanVersion(body.version);
  if (!version) {
    const error = new Error("version is required");
    error.status = 400;
    throw error;
  }
  const releaseDir = path.join(config.releasesDir, version);
  if (!await pathExists(releaseDir)) {
    const error = new Error(`Release ${version} does not exist.`);
    error.status = 404;
    throw error;
  }
  await replaceDirFromRelease(releaseDir, config.liveDir);
  const publishedAt = new Date().toISOString();
  const manifest = await readJsonFile(path.join(releaseDir, "deploy-manifest.json"), {});
  const releaseStatus = {
    app: {
      version,
      title: "系统有新版本",
      message: String(body.message || manifest.notes || "ERP 已发布新版本，空闲时点击更新即可加载最新功能。").trim(),
      action: "reload",
      mandatory: Boolean(body.mandatory),
      published_at: publishedAt,
      channel: config.channel
    }
  };
  await fs.mkdir(path.dirname(config.currentFile), { recursive: true });
  await fs.writeFile(
    config.currentFile,
    `${JSON.stringify({ version, channel: config.channel, publishedAt, releaseDir, liveDir: config.liveDir }, null, 2)}\n`,
    "utf8"
  );
  const records = await readPublishedRecords(config);
  const nextRecords = [
    {
      version,
      channel: config.channel,
      publishedAt,
      releaseDir,
      liveDir: config.liveDir
    },
    ...records.filter((record) => record.version !== version)
  ];
  await savePublishedRecords(config, nextRecords);
  await fs.mkdir(path.join(config.liveDir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(config.liveDir, "data", "global-update-status.json"),
    `${JSON.stringify(releaseStatus, null, 2)}\n`,
    "utf8"
  );
  return { version, liveDir: config.liveDir };
}

async function buildAndPublishRelease(body = {}) {
  const built = await buildRelease(body);
  const published = await publishRelease({
    ...body,
    version: built.version
  });
  return {
    ...published,
    releaseDir: built.releaseDir
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") return json(res, await state());
  if (req.method === "POST" && pathname === "/api/build") return json(res, await buildRelease(await readBody(req)));
  if (req.method === "POST" && pathname === "/api/publish") return json(res, await publishRelease(await readBody(req)));
  if (req.method === "POST" && pathname === "/api/build-and-publish") return json(res, await buildAndPublishRelease(await readBody(req)));
  return json(res, { error: "Not found" }, 404);
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ERP 发布控制台</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        --bg: #eef3f8;
        --surface: #ffffff;
        --surface-soft: #f8fafc;
        --line: #d9e2ee;
        --line-strong: #c2cde0;
        --text: #162033;
        --muted: #66758a;
        --primary: #3f5f89;
        --primary-dark: #304d73;
        --success: #0f9f6e;
        --warning: #d97706;
        --shadow: 0 18px 45px rgba(20, 38, 68, 0.08);
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Arial, "Microsoft YaHei", sans-serif;
      }
      button, input, textarea { font: inherit; }
      .shell {
        width: min(1280px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 28px 0 36px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      .title-block { min-width: 0; }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        height: 24px;
        padding: 0 9px;
        border: 1px solid rgba(63, 95, 137, 0.18);
        border-radius: 6px;
        background: #f7faff;
        color: var(--primary);
        font-size: 12px;
        font-weight: 700;
      }
      h1 { margin: 8px 0 4px; font-size: 26px; letter-spacing: 0; }
      p { margin: 0; color: var(--muted); }
      .top-actions { display: flex; gap: 8px; align-items: center; }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }
      .status-card {
        min-width: 0;
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: 0 10px 24px rgba(20, 38, 68, 0.045);
      }
      .status-card span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      .status-card strong {
        display: block;
        margin-top: 7px;
        overflow: hidden;
        color: var(--text);
        font-size: 16px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status-card.path strong {
        font-size: 12px;
        line-height: 1.35;
        white-space: normal;
        word-break: break-all;
      }
      .grid {
        display: grid;
        grid-template-columns: 420px minmax(0, 1fr);
        gap: 14px;
        align-items: start;
      }
      section {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .panel-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 18px 12px;
        border-bottom: 1px solid #edf1f7;
      }
      h2 { margin: 0; font-size: 17px; }
      .panel-head small {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .panel-body { padding: 16px 18px 18px; }
      label {
        display: grid;
        gap: 7px;
        margin: 0 0 12px;
        color: #344054;
        font-size: 13px;
        font-weight: 700;
      }
      input, textarea {
        width: 100%;
        border: 1px solid var(--line-strong);
        border-radius: 7px;
        padding: 10px 11px;
        background: #fff;
        color: var(--text);
        outline: none;
        transition: border-color 0.16s ease, box-shadow 0.16s ease;
      }
      input:focus, textarea:focus {
        border-color: rgba(63, 95, 137, 0.76);
        box-shadow: 0 0 0 3px rgba(63, 95, 137, 0.12);
      }
      textarea { min-height: 104px; resize: vertical; }
      button {
        height: 34px;
        border: 1px solid var(--line-strong);
        border-radius: 7px;
        padding: 0 13px;
        background: #fff;
        color: #263852;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
      }
      button:hover { border-color: rgba(63, 95, 137, 0.55); background: #f7faff; }
      button.primary {
        border-color: var(--primary);
        background: var(--primary);
        color: #fff;
      }
      button.primary:hover { border-color: var(--primary-dark); background: var(--primary-dark); }
      button.danger { border-color: #dc2626; color: #b42318; }
      button:disabled { opacity: 0.55; cursor: wait; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .hint-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 2px 0 12px;
        padding: 10px;
        border: 1px solid #e5ebf4;
        border-radius: 7px;
        background: var(--surface-soft);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .hint-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--success);
        flex: none;
      }
      .release-list { display: grid; gap: 10px; padding: 16px 18px 18px; }
      .release {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 13px;
        border: 1px solid #e3eaf4;
        border-radius: 8px;
        background: #fbfcfe;
      }
      .release b { display: block; font-size: 15px; }
      .release span {
        display: block;
        margin-top: 4px;
        overflow: hidden;
        color: var(--muted);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .empty {
        display: grid;
        place-items: center;
        min-height: 210px;
        border: 1px dashed #cfd8e6;
        border-radius: 8px;
        background: #fbfcfe;
        color: var(--muted);
        text-align: center;
      }
      .empty strong { display: block; margin-bottom: 6px; color: var(--text); }
      .log {
        margin-top: 14px;
        padding: 13px;
        min-height: 58px;
        border-radius: 8px;
        background: #101828;
        color: #d0d5dd;
        white-space: pre-wrap;
        font-size: 12px;
        line-height: 1.5;
      }
      @media (max-width: 980px) {
        .grid, .status-grid { grid-template-columns: 1fr; }
        header { align-items: flex-start; flex-direction: column; }
        .top-actions { width: 100%; justify-content: flex-end; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="title-block">
          <span class="eyebrow">本地发布工具</span>
          <h1>ERP 发布控制台</h1>
          <p>本地构建新版本，保留历史包，一键切换线上版本；同事点击更新后才刷新到新版。</p>
        </div>
        <div class="top-actions">
          <button id="refreshBtn">刷新状态</button>
        </div>
      </header>
      <div class="status-grid" id="stateBox"></div>
      <div class="grid">
        <section>
          <div class="panel-head">
            <div>
              <h2>创建发布版本</h2>
              <small>生成独立版本目录，不直接覆盖正在使用的线上文件。</small>
            </div>
          </div>
          <div class="panel-body">
            <div class="hint-row"><span class="hint-dot"></span><span>建议先构建版本，确认无误后再点击发布；需要回滚时可在右侧选择旧版本重新发布。</span></div>
            <label>版本号 <input id="versionInput" /></label>
            <label>更新说明 <textarea id="notesInput" placeholder="例如：修复订单同步问题，优化库存页面"></textarea></label>
            <div class="actions">
              <button class="primary" id="buildBtn">构建新版本</button>
              <button id="publishLatestBtn">发布最新版本</button>
            </div>
            <div class="log" id="logBox">准备就绪。</div>
          </div>
        </section>
        <section>
          <div class="panel-head">
            <div>
              <h2>版本历史</h2>
              <small>每个版本都是独立目录，可随时发布或回滚。</small>
            </div>
          </div>
          <div class="release-list" id="releaseList"></div>
        </section>
      </div>
    </div>
    <script>
      const stateBox = document.getElementById("stateBox");
      const releaseList = document.getElementById("releaseList");
      const versionInput = document.getElementById("versionInput");
      const notesInput = document.getElementById("notesInput");
      const logBox = document.getElementById("logBox");
      const buttons = Array.from(document.querySelectorAll("button"));
      let state = null;

      function setBusy(busy) {
        buttons.forEach((button) => button.disabled = busy);
      }

      function log(message) {
        logBox.textContent = message;
      }

      async function api(path, options = {}) {
        const response = await fetch(path, {
          ...options,
          headers: { "Content-Type": "application/json", ...(options.headers || {}) }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "请求失败");
        return data;
      }

      function render(next) {
        state = next;
        versionInput.value = versionInput.value || next.nextVersion;
        stateBox.innerHTML = [
          ["当前指针", next.current?.version || "-"],
          ["线上目录", next.live?.version || "-"],
          ["发布通道", next.config.channel],
          ["线上路径", next.config.liveDir, "path"]
        ].map(([k, v, cls]) => \`<div class="status-card \${cls || ""}"><span>\${k}</span><strong title="\${v}">\${v}</strong></div>\`).join("");
        releaseList.innerHTML = next.releases.length
          ? next.releases.map((release) => \`
            <div class="release">
              <div><b>\${release.version}</b><span>\${release.builtAt || ""}</span><span>\${release.path}</span></div>
              <button data-version="\${release.version}">发布此版本</button>
            </div>
          \`).join("")
          : '<div class="empty"><div><strong>还没有发布包</strong><span>先在左侧构建一个新版本。</span></div></div>';
      }

      async function refresh() {
        render(await api("/api/state"));
      }

      async function build() {
        setBusy(true);
        try {
          log("正在构建发布包，可能需要一两分钟...");
          const result = await api("/api/build", {
            method: "POST",
            body: JSON.stringify({ version: versionInput.value, notes: notesInput.value })
          });
          log(\`构建完成：\${result.version}\\n\${result.releaseDir}\`);
          versionInput.value = "";
          notesInput.value = "";
          await refresh();
        } catch (error) {
          log(error.message);
        } finally {
          setBusy(false);
        }
      }

      async function publish(version) {
        if (!version) {
          setStatus("请先选择一个待发布版本包。");
          return;
        }
        const current = state?.online?.version || "尚未发布版本";
        if (!window.confirm("确认发布版本 " + version + "，替换当前线上版本 " + current + " 吗？")) return;
        setBusy(true);
        try {
          setStatus("正在发布版本 " + version + "...");
          const result = await api("/api/publish", { method: "POST", body: JSON.stringify({ version, message: notesInput.value }) });
          setStatus("发布成功，当前线上版本：" + result.version);
          await refresh();
        } catch (error) {
          setStatus(error.message);
        } finally {
          setBusy(false);
        }
      }
      document.getElementById("refreshBtn").addEventListener("click", refresh);
      document.getElementById("buildBtn").addEventListener("click", build);
      document.getElementById("publishLatestBtn").addEventListener("click", () => publish(state?.releases?.[0]?.version));
      releaseList.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-version]");
        if (button) publish(button.dataset.version);
      });
      refresh().catch((error) => log(error.message));
    </script>
  </body>
</html>`;
}

function pageV2() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ERP 发布控制台</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        --bg: #eef3f8;
        --surface: #ffffff;
        --soft: #f7f9fc;
        --line: #d9e2ee;
        --line-strong: #c3cede;
        --text: #142033;
        --muted: #66758a;
        --primary: #3f5f89;
        --primary-dark: #304d73;
        --success: #0f9f6e;
        --warning: #d97706;
        --danger: #dc2626;
        --shadow: 0 18px 42px rgba(20, 38, 68, 0.08);
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Arial, "Microsoft YaHei", sans-serif;
      }
      button, input, textarea { font: inherit; }
      .shell {
        width: min(1360px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 24px 0 36px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
      .subtitle { margin-top: 7px; color: var(--muted); font-size: 14px; }
      .header-actions { display: flex; gap: 8px; align-items: center; }
      button {
        height: 34px;
        border: 1px solid var(--line-strong);
        border-radius: 7px;
        padding: 0 13px;
        background: #fff;
        color: #27384f;
        font-weight: 700;
        cursor: pointer;
      }
      button:hover { border-color: rgba(63, 95, 137, 0.55); background: #f7faff; }
      button.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
      button.primary:hover { border-color: var(--primary-dark); background: var(--primary-dark); }
      button:disabled { opacity: 0.55; cursor: wait; }
      .top-flow {
        display: contents;
      }
      .stage {
        min-width: 0;
        min-height: 300px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: 0 12px 26px rgba(20, 38, 68, 0.055);
      }
      .stage-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid #edf1f7;
      }
      .stage-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .step {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border-radius: 7px;
        background: #edf3fb;
        color: var(--primary);
        font-size: 12px;
        font-weight: 900;
      }
      h2 { margin: 0; font-size: 16px; }
      .badge {
        display: inline-flex;
        align-items: center;
        height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        background: #f1f5f9;
        color: #526174;
        font-size: 12px;
        font-weight: 800;
        white-space: nowrap;
      }
      .badge.success { background: #eaf8f2; color: #067647; }
      .badge.warning { background: #fff7e6; color: #b45309; }
      .badge.online { background: #eaf1ff; color: #285b9f; }
      .stage-body {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        padding: 12px 14px 14px;
      }
      .version-text {
        display: flex;
        align-items: center;
        height: 44px;
        min-height: 44px;
        padding: 0 12px;
        border: 1px solid #e5ebf4;
        border-radius: 8px;
        background: #f8fafc;
        min-height: 32px;
        overflow: hidden;
        color: var(--text);
        font-size: 18px;
        font-weight: 900;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .version-text.empty { color: #9aa7b8; font-size: 17px; }
      .meta-grid {
        display: grid;
        gap: 7px;
        margin-top: 11px;
      }
      .meta-row {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.42;
      }
      .meta-row strong {
        min-width: 0;
        overflow: hidden;
        color: var(--text);
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .meta-row.path strong {
        display: -webkit-box;
        white-space: normal;
        word-break: break-all;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .stage-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: auto;
        padding-top: 14px;
      }
      .main-grid {
        display: grid;
        grid-template-columns: 380px repeat(3, minmax(0, 1fr));
        gap: 12px;
        align-items: stretch;
      }
      .dashboard {
        display: contents;
      }
      section {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .panel-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 15px 17px 12px;
        border-bottom: 1px solid #edf1f7;
      }
      .panel-head small {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .panel-body { padding: 16px 17px 17px; }
      .build-panel {
        min-height: 300px;
        display: flex;
        flex-direction: column;
      }
      .build-panel .panel-head { padding: 13px 15px 10px; }
      .build-panel .panel-body {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        padding: 12px 15px 14px;
      }
      label {
        display: grid;
        gap: 7px;
        margin-bottom: 12px;
        color: #344054;
        font-size: 13px;
        font-weight: 800;
      }
      input, textarea {
        width: 100%;
        border: 1px solid var(--line-strong);
        border-radius: 7px;
        padding: 10px 11px;
        background: #fff;
        color: var(--text);
        outline: none;
      }
      input:focus, textarea:focus {
        border-color: rgba(63, 95, 137, 0.76);
        box-shadow: 0 0 0 3px rgba(63, 95, 137, 0.12);
      }
      textarea { min-height: 70px; resize: vertical; }
      .hint {
        margin: 0 0 12px;
        padding: 9px;
        border: 1px solid #e5ebf4;
        border-radius: 7px;
        background: var(--soft);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.55;
      }
      .log {
        margin-top: auto;
        padding: 10px;
        min-height: 44px;
        border-radius: 8px;
        background: #101828;
        color: #d0d5dd;
        white-space: pre-wrap;
        font-size: 12px;
        line-height: 1.5;
      }
      .history-panel {
        grid-column: 1 / -1;
      }
      .history-list { display: grid; gap: 10px; padding: 15px 17px 17px; }
      .release {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 13px;
        border: 1px solid #e3eaf4;
        border-radius: 8px;
        background: #fbfcfe;
      }
      .release.is-online { border-color: rgba(15, 159, 110, 0.42); background: #f4fbf8; }
      .release-main { min-width: 0; }
      .release-title {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
      }
      .release-title b { font-size: 15px; }
      .release-meta {
        display: grid;
        gap: 3px;
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .release-meta span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .empty {
        display: grid;
        place-items: center;
        min-height: 260px;
        border: 1px dashed #cfd8e6;
        border-radius: 8px;
        background: #fbfcfe;
        color: var(--muted);
        text-align: center;
      }
      .empty strong { display: block; margin-bottom: 6px; color: var(--text); }
      @media (max-width: 1080px) {
        .main-grid { grid-template-columns: 1fr; }
        .dashboard, .top-flow { display: grid; gap: 12px; }
        .history-panel { grid-column: auto; }
        header { align-items: flex-start; flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div>
          <h1>ERP 发布控制台</h1>
          <div class="subtitle">后台代码改完后，这里会自动读取当前本地代码。先生成“待发布版本包”，再选择发布到线上。</div>
        </div>
        <div class="header-actions">
          <button id="refreshBtn">刷新状态</button>
        </div>
      </header>

      <div class="main-grid">
        <section class="build-panel">
          <div class="panel-head">
            <div>
              <h2>生成待发布版本包</h2>
              <small>使用当前本地代码构建，不会影响线上同事。</small>
            </div>
          </div>
          <div class="panel-body">
            <p class="hint">流程很简单：改完代码后点“生成待发布版本包”。右侧出现新版本后，再点“发布此版本”才会切换线上。</p>
            <label>版本号 <input id="versionInput" /></label>
            <label>更新说明 <textarea id="notesInput" placeholder="例如：修复订单同步问题，优化库存页面"></textarea></label>
            <div class="stage-actions">
              <button class="primary" id="buildBtn">用当前代码生成版本包</button>
              <button id="buildPublishBtn">一键发布当前代码</button>
              <button id="publishLatestBtn">发布最新版本包</button>
            </div>
            <div class="log" id="logBox">准备就绪。</div>
          </div>
        </section>

        <div class="dashboard">
          <div class="top-flow">
            <article class="stage" id="localStage"></article>
            <article class="stage" id="pendingStage"></article>
            <article class="stage" id="onlineStage"></article>
          </div>

          <section class="history-panel">
            <div class="panel-head">
              <div>
                <h2>线上版本追踪</h2>
                <small>这里显示所有已生成版本；带“当前线上”的就是同事正在使用的版本。</small>
              </div>
            </div>
            <div class="history-list" id="releaseList"></div>
          </section>
        </div>
      </div>
    </div>

    <script>
      const localStage = document.getElementById("localStage");
      const pendingStage = document.getElementById("pendingStage");
      const onlineStage = document.getElementById("onlineStage");
      const releaseList = document.getElementById("releaseList");
      const versionInput = document.getElementById("versionInput");
      const notesInput = document.getElementById("notesInput");
      const logBox = document.getElementById("logBox");
      const buttons = Array.from(document.querySelectorAll("button"));
      let state = null;

      function htmlEscape(value) {
        return String(value ?? "").replace(/[&<>"']/g, function (char) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
        });
      }

      function timeText(value) {
        if (!value) return "-";
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return value;
        return new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }).format(date);
      }

      function setBusy(busy) {
        buttons.forEach(function (button) { button.disabled = busy; });
      }

      function log(message) {
        logBox.textContent = message;
      }

      async function api(path, options) {
        const response = await fetch(path, {
          ...(options || {}),
          headers: { "Content-Type": "application/json", ...((options || {}).headers || {}) }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "请求失败");
        return data;
      }

      function renderStage(target, step, title, badge, badgeClass, version, rows, actions) {
        target.innerHTML =
          '<div class="stage-head">' +
            '<div class="stage-title"><span class="step">' + step + '</span><h2>' + title + '</h2></div>' +
            '<span class="badge ' + (badgeClass || "") + '">' + badge + '</span>' +
          '</div>' +
          '<div class="stage-body">' +
            '<div class="version-text ' + (version ? "" : "empty") + '">' + htmlEscape(version || "暂无版本") + '</div>' +
            '<div class="meta-grid">' + rows.map(function (row) {
              return '<div class="meta-row ' + (row.path ? "path" : "") + '"><span>' + row.label + '</span><strong title="' + htmlEscape(row.value || "-") + '">' + htmlEscape(row.value || "-") + '</strong></div>';
            }).join("") + '</div>' +
            (actions || "") +
          '</div>';
      }

      function render(next) {
        state = next;
        versionInput.value = versionInput.value || next.workspace.nextVersion;
        const localBadge = next.hasUnbuiltChanges ? "可生成版本包" : "已生成最新包";
        renderStage(localStage, "1", "本地开发代码", localBadge, next.hasUnbuiltChanges ? "warning" : "success", "当前代码", [
          { label: "代码时间", value: timeText(next.workspace.sourceChangedAt) },
          { label: "本地目录", value: next.workspace.projectDir, path: true }
        ], '<div class="stage-actions"><button class="primary" id="quickBuildBtn">生成版本包</button></div>');

        renderStage(pendingStage, "2", "待发布版本包", next.pending ? "可发布" : "还没有生成", next.pending ? "success" : "warning", next.pending?.version || "请先生成版本包", [
          { label: "构建时间", value: timeText(next.pending?.builtAt) },
          { label: "包目录", value: next.pending?.path || "-", path: true }
        ], '<div class="stage-actions"><button id="quickPublishBtn">发布待发布包</button></div>');

        renderStage(onlineStage, "3", "线上当前版本", next.online.version ? "同事正在使用" : "还没有发布", next.online.version ? "online" : "warning", next.online.version || "尚未发布版本", [
          { label: "发布时间", value: timeText(next.online.publishedAt) },
          { label: "线上目录", value: next.online.liveDir, path: true }
        ], "");

        document.getElementById("quickBuildBtn").addEventListener("click", build);
        document.getElementById("quickPublishBtn").addEventListener("click", function () {
          publish(state?.pending?.version);
        });

        releaseList.innerHTML = next.releases.length
          ? next.releases.map(function (release) {
            const badges = [
              release.isOnline ? '<span class="badge success">当前线上</span>' : "",
              release.isLatest ? '<span class="badge online">最新版本包</span>' : ""
            ].join("");
            return '<div class="release ' + (release.isOnline ? "is-online" : "") + '">' +
              '<div class="release-main">' +
                '<div class="release-title"><b>' + htmlEscape(release.version) + '</b>' + badges + '</div>' +
                '<div class="release-meta">' +
                  '<span>构建时间：' + htmlEscape(timeText(release.builtAt)) + '</span>' +
                  '<span>目录：' + htmlEscape(release.path) + '</span>' +
                  (release.notes ? '<span>说明：' + htmlEscape(release.notes) + '</span>' : "") +
                '</div>' +
              '</div>' +
              '<button data-version="' + htmlEscape(release.version) + '">' + (release.isOnline ? "重新发布" : "发布此版本") + '</button>' +
            '</div>';
          }).join("")
          : '<div class="empty"><div><strong>还没有版本包</strong><span>先用当前代码生成一个待发布版本包。</span></div></div>';
      }

      async function refresh() {
        render(await api("/api/state"));
      }

      async function build() {
        setBusy(true);
        try {
          log("正在用当前本地代码生成版本包...");
          const result = await api("/api/build", {
            method: "POST",
            body: JSON.stringify({ version: versionInput.value, notes: notesInput.value })
          });
          log("版本包生成完成：" + result.version + "\\n" + result.releaseDir);
          versionInput.value = "";
          notesInput.value = "";
          await refresh();
        } catch (error) {
          log(error.message);
        } finally {
          setBusy(false);
        }
      }

      async function buildAndPublish() {
        setBusy(true);
        try {
          log("正在用当前本地代码生成版本包，并发布到线上...");
          const result = await api("/api/build-and-publish", {
            method: "POST",
            body: JSON.stringify({ version: versionInput.value, notes: notesInput.value, message: notesInput.value })
          });
          log("一键发布完成。当前线上版本：" + result.version + "\\n版本包：" + result.releaseDir + "\\n线上目录：" + result.liveDir);
          versionInput.value = "";
          notesInput.value = "";
          await refresh();
        } catch (error) {
          log(error.message);
        } finally {
          setBusy(false);
        }
      }

      async function publish(version) {
        if (!version) {
          log("还没有可发布的版本包。请先生成版本包。");
          return;
        }
        setBusy(true);
        try {
          log("正在把版本 " + version + " 发布到线上目录...");
          const result = await api("/api/publish", {
            method: "POST",
            body: JSON.stringify({ version, message: notesInput.value })
          });
          log("发布完成。当前线上版本：" + result.version + "\\n" + result.liveDir);
          await refresh();
        } catch (error) {
          log(error.message);
        } finally {
          setBusy(false);
        }
      }

      document.getElementById("refreshBtn").addEventListener("click", refresh);
      document.getElementById("buildBtn").addEventListener("click", build);
      document.getElementById("buildPublishBtn").addEventListener("click", buildAndPublish);
      document.getElementById("publishLatestBtn").addEventListener("click", function () {
        publish(state?.pending?.version);
      });
      releaseList.addEventListener("click", function (event) {
        const button = event.target.closest("button[data-version]");
        if (button) publish(button.dataset.version);
      });
      refresh().catch(function (error) { log(error.message); });
      window.setInterval(function () {
        if (!buttons.some(function (button) { return button.disabled; })) refresh().catch(function () {});
      }, 5000);
    </script>
  </body>
</html>`;
}

function pageV3() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ERP 发布控制台</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        --bg: #eef3f8;
        --surface: #fff;
        --soft: #f7f9fc;
        --line: #d9e2ee;
        --line-strong: #c3cede;
        --text: #142033;
        --muted: #66758a;
        --primary: #3f5f89;
        --primary-dark: #304d73;
        --success: #0f9f6e;
        --warning: #d97706;
        --shadow: 0 18px 42px rgba(20, 38, 68, 0.08);
      }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Arial, "Microsoft YaHei", sans-serif; }
      button, input, textarea { font: inherit; }
      .shell { width: min(1480px, calc(100vw - 40px)); margin: 0 auto; padding: 22px 0 32px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
      h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
      .subtitle { margin-top: 6px; color: var(--muted); font-size: 14px; }
      button { height: 34px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 13px; background: #fff; color: #27384f; font-weight: 700; cursor: pointer; }
      button:hover { border-color: rgba(63, 95, 137, 0.55); background: #f7faff; }
      button.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
      button.primary:hover { border-color: var(--primary-dark); background: var(--primary-dark); }
      button:disabled { opacity: 0.55; cursor: wait; }
      .dashboard-grid { display: grid; grid-template-columns: 360px minmax(0, 1.35fr) minmax(0, 1.1fr); gap: 12px; align-items: stretch; }
      .card { min-width: 0; min-height: 520px; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
      .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 11px; border-bottom: 1px solid #edf1f7; }
      .card-head h2 { margin: 0; font-size: 17px; }
      .card-head small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.35; }
      .card-body { flex: 1; min-height: 0; padding: 14px 16px 16px; }
      .build-card .card-body { display: flex; flex-direction: column; }
      label { display: grid; gap: 7px; margin-bottom: 12px; color: #344054; font-size: 13px; font-weight: 800; }
      input, textarea { width: 100%; border: 1px solid var(--line-strong); border-radius: 7px; padding: 10px 11px; background: #fff; color: var(--text); outline: none; }
      input:focus, textarea:focus { border-color: rgba(63, 95, 137, 0.76); box-shadow: 0 0 0 3px rgba(63, 95, 137, 0.12); }
      textarea { min-height: 108px; resize: vertical; }
      .hint { margin: 0 0 12px; padding: 10px; border: 1px solid #e5ebf4; border-radius: 7px; background: var(--soft); color: var(--muted); font-size: 12px; line-height: 1.5; }
      .build-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
      .version-preview {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
        padding: 10px 11px;
        border: 1px solid #e5ebf4;
        border-radius: 7px;
        background: #fbfcfe;
      }
      .version-preview span { color: var(--muted); font-size: 12px; font-weight: 800; }
      .version-preview strong {
        min-width: 0;
        overflow: hidden;
        font-size: 14px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status-text {
        max-height: 92px;
        min-height: 44px;
        margin-top: auto;
        overflow: auto;
        padding: 10px;
        border-radius: 8px;
        background: #101828;
        color: #d0d5dd;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .summary { display: grid; gap: 7px; margin-bottom: 12px; padding: 11px; border: 1px solid #e5ebf4; border-radius: 8px; background: #fbfcfe; }
      .summary-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .summary-title strong { min-width: 0; overflow: hidden; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
      .summary-title strong.empty { color: #9aa7b8; font-size: 15px; }
      .badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; background: #f1f5f9; color: #526174; font-size: 12px; font-weight: 800; white-space: nowrap; }
      .badge.success { background: #eaf8f2; color: #067647; }
      .badge.warning { background: #fff7e6; color: #b45309; }
      .badge.online { background: #eaf1ff; color: #285b9f; }
      .meta-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; color: var(--muted); font-size: 12px; line-height: 1.38; }
      .meta-row strong { min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
      .table-wrap { max-height: 342px; overflow: auto; border: 1px solid #e3eaf4; border-radius: 8px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
      th, td { padding: 10px 9px; border-bottom: 1px solid #edf1f7; font-size: 12px; text-align: left; vertical-align: middle; }
      th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: var(--muted); font-weight: 800; }
      tr:last-child td { border-bottom: 0; }
      tr.selected { background: #f1f6ff; }
      .col-pick { width: 42px; text-align: center; }
      .col-version { width: 154px; }
      .col-time { width: 118px; }
      .mono { overflow: hidden; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
      .path-cell { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
      .table-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
      .selected-note { min-width: 0; color: var(--muted); font-size: 12px; }
      .col-status { width: 86px; }
      .empty { display: grid; place-items: center; min-height: 220px; border: 1px dashed #cfd8e6; border-radius: 8px; background: #fbfcfe; color: var(--muted); text-align: center; }
      .empty strong { display: block; margin-bottom: 6px; color: var(--text); }
      @media (max-width: 1180px) {
        .dashboard-grid { grid-template-columns: 1fr; }
        .card { min-height: auto; }
        header { align-items: flex-start; flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div>
          <h1>ERP 发布控制台</h1>
          <div class="subtitle">先生成本地待发布版本包，再从版本包列表单选一个版本发布到线上。</div>
        </div>
        <button id="refreshBtn">刷新状态</button>
      </header>

      <div class="dashboard-grid">
        <section class="card build-card">
          <div class="card-head">
            <div>
              <h2>生成版本包</h2>
              <small>这里只负责编译当前本地代码。</small>
            </div>
          </div>
          <div class="card-body">
            <p class="hint">填写更新说明，点击生成。版本号会自动生成，生成完成后会出现在右侧版本包列表。</p>
            <div class="version-preview"><span>即将生成版本号</span><strong id="versionPreview">-</strong></div>
            <label>更新说明 <textarea id="notesInput" placeholder="例如：修复订单同步问题，优化库存页面"></textarea></label>
            <div class="build-actions"><button class="primary" id="buildBtn">生成版本包</button></div>
            <div class="status-text" id="statusText">准备就绪。</div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div>
              <h2>本地待发布版本包</h2>
              <small>最新版本排在最上面，只能选择一个版本发布。</small>
            </div>
          </div>
          <div class="card-body">
            <div id="pendingSummary"></div>
            <div id="releaseTable"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div>
              <h2>线上版本</h2>
              <small>这里只显示真正发布过的线上版本。</small>
            </div>
          </div>
          <div class="card-body">
            <div id="onlineSummary"></div>
            <div id="onlineList"></div>
          </div>
        </section>
      </div>
    </div>

    <script>
      const versionPreview = document.getElementById("versionPreview");
      const notesInput = document.getElementById("notesInput");
      const statusText = document.getElementById("statusText");
      const pendingSummary = document.getElementById("pendingSummary");
      const releaseTable = document.getElementById("releaseTable");
      const onlineSummary = document.getElementById("onlineSummary");
      const onlineList = document.getElementById("onlineList");
      const buttons = Array.from(document.querySelectorAll("button"));
      let state = null;
      let selectedVersion = "";

      function htmlEscape(value) {
        return String(value ?? "").replace(/[&<>"']/g, function (char) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
        });
      }

      function timeText(value) {
        if (!value) return "-";
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return value;
        return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
      }

      function setBusy(busy) {
        buttons.forEach(function (button) { button.disabled = busy; });
      }

      function setStatus(message, detail) {
        const text = String(message || "");
        const more = Array.isArray(detail) ? detail.join("\\n") : String(detail || "");
        statusText.textContent = more ? text + "\\n" + more : text;
      }

      async function api(path, options) {
        const response = await fetch(path, { ...(options || {}), headers: { "Content-Type": "application/json", ...((options || {}).headers || {}) } });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(data.error || "请求失败");
          error.detail = data.validation?.detail || "";
          throw error;
        }
        return data;
      }

      function releaseByVersion(version) {
        return (state?.releases || []).find(function (release) { return release.version === version; }) || null;
      }

      function renderSummary() {
        const selected = releaseByVersion(selectedVersion) || state?.pending || null;
        pendingSummary.innerHTML =
          '<div class="summary">' +
            '<div class="summary-title"><strong class="' + (selected ? "" : "empty") + '">' + htmlEscape(selected?.version || "还没有生成版本包") + '</strong><span class="badge ' + (selected ? "success" : "warning") + '">' + (selected ? "已选择" : "未生成") + '</span></div>' +
            '<div class="meta-row"><span>创建时间</span><strong>' + htmlEscape(timeText(selected?.builtAt)) + '</strong></div>' +
            '<div class="meta-row"><span>包目录</span><strong title="' + htmlEscape(selected?.path || "-") + '">' + htmlEscape(selected?.path || "-") + '</strong></div>' +
          '</div>';

        onlineSummary.innerHTML =
          '<div class="summary">' +
            '<div class="summary-title"><strong class="' + (state?.online?.version ? "" : "empty") + '">' + htmlEscape(state?.online?.version || "尚未发布版本") + '</strong><span class="badge ' + (state?.online?.version ? "online" : "warning") + '">' + (state?.online?.version ? "当前线上" : "未发布") + '</span></div>' +
            '<div class="meta-row"><span>发布时间</span><strong>' + htmlEscape(timeText(state?.online?.publishedAt)) + '</strong></div>' +
            '<div class="meta-row"><span>线上目录</span><strong title="' + htmlEscape(state?.online?.liveDir || "-") + '">' + htmlEscape(state?.online?.liveDir || "-") + '</strong></div>' +
          '</div>';
      }

      function renderReleaseTable() {
        if (!state.releases.length) {
          releaseTable.innerHTML = '<div class="empty"><div><strong>暂无版本包</strong><span>请先在左侧生成版本包。</span></div></div>';
          return;
        }
        releaseTable.innerHTML = '<div class="table-wrap"><table><thead><tr><th class="col-pick">选择</th><th class="col-version">版本号</th><th class="col-time">创建时间</th><th class="col-status">状态</th><th>包目录</th><th class="col-action">操作</th></tr></thead><tbody>' +
          state.releases.map(function (release) {
            const checked = release.version === selectedVersion;
            return '<tr class="' + (checked ? "selected" : "") + '" data-version="' + htmlEscape(release.version) + '">' +
              '<td class="col-pick"><input type="radio" name="releaseVersion" value="' + htmlEscape(release.version) + '"' + (checked ? " checked" : "") + ' /></td>' +
              '<td><div class="mono" title="' + htmlEscape(release.version) + '">' + htmlEscape(release.version) + '</div></td>' +
              '<td>' + htmlEscape(timeText(release.builtAt)) + '</td>' +
              '<td><span class="badge ' + (release.isPublished ? "online" : "warning") + '">' + (release.isPublished ? "已发布" : "未发布") + '</span></td>' +
              '<td><div class="path-cell" title="' + htmlEscape(release.path) + '">' + htmlEscape(release.path) + '</div></td>' +
              '<td class="col-action"><button data-publish-version="' + htmlEscape(release.version) + '">发布</button></td>' +
            '</tr>';
          }).join("") + '</tbody></table></div>' +
          '<div class="table-actions"><div class="selected-note">选中版本：' + htmlEscape(selectedVersion || "-") + '</div><button class="primary" id="publishSelectedBtn">发布选中版本</button></div>';
        releaseTable.querySelectorAll('input[name="releaseVersion"]').forEach(function (input) {
          input.addEventListener("change", function () {
            selectedVersion = input.value;
            render(state);
          });
        });
        releaseTable.querySelectorAll('tr[data-version]').forEach(function (row) {
          row.addEventListener("click", function (event) {
            if (event.target.closest("button")) return;
            selectedVersion = row.dataset.version;
            render(state);
          });
        });
        releaseTable.querySelectorAll('button[data-publish-version]').forEach(function (button) {
          button.addEventListener("click", function () {
            selectedVersion = button.dataset.publishVersion;
            publish(selectedVersion);
          });
        });
        document.getElementById("publishSelectedBtn").addEventListener("click", function () { publish(selectedVersion); });
      }

      function renderOnlineList() {
        if (!state.releases.length) {
          onlineList.innerHTML = '<div class="empty"><div><strong>暂无历史版本</strong><span>发布后会在这里标记当前线上版本。</span></div></div>';
          return;
        }
        onlineList.innerHTML = '<div class="online-list">' + state.releases.map(function (release) {
          const isOnline = release.isOnline;
          return '<div class="online-item ' + (isOnline ? "is-online" : "") + '"><div><b>' + htmlEscape(release.version) + '</b><span>创建时间：' + htmlEscape(timeText(release.builtAt)) + '</span></div><span class="badge ' + (isOnline ? "success" : "") + '">' + (isOnline ? "当前线上" : "历史版本") + '</span></div>';
        }).join("") + '</div>';
      }

      function render(next) {
        state = next;
        const hasSelected = state.releases.some(function (release) { return release.version === selectedVersion; });
        if (!hasSelected) selectedVersion = state.pending?.version || state.releases[0]?.version || "";
        versionPreview.textContent = state.workspace.nextVersion || "-";
        renderSummary();
        renderReleaseTable();
        renderOnlineList();
      }

      async function refresh() {
        render(await api("/api/state"));
      }

      async function build() {
        setBusy(true);
        try {
          setStatus("正在生成版本包...");
          const result = await api("/api/build", { method: "POST", body: JSON.stringify({ notes: notesInput.value }) });
          selectedVersion = result.version;
          notesInput.value = "";
          setStatus("版本包生成完成：" + result.version, result.log || []);
          await refresh();
        } catch (error) {
          setStatus(error.message, error.detail);
        } finally {
          setBusy(false);
        }
      }

      async function publish(version) {
        if (!version) {
          setStatus("请先选择一个待发布版本包。");
          return;
        }
        const current = state?.online?.version || "尚未发布版本";
        if (!window.confirm("确认发布版本 " + version + "，替换当前线上版本 " + current + " 吗？")) return;
        setBusy(true);
        try {
          setStatus("正在发布版本 " + version + "...");
          const result = await api("/api/publish", { method: "POST", body: JSON.stringify({ version, message: notesInput.value }) });
          setStatus("发布成功，当前线上版本：" + result.version);
          await refresh();
        } catch (error) {
          setStatus(error.message);
        } finally {
          setBusy(false);
        }
      }

      document.getElementById("refreshBtn").addEventListener("click", refresh);
      document.getElementById("buildBtn").addEventListener("click", build);
      refresh().catch(function (error) { setStatus(error.message); });
      window.setInterval(function () {
        if (!buttons.some(function (button) { return button.disabled; })) refresh().catch(function () {});
      }, 5000);
    </script>
  </body>
</html>`;
}

function pageV4() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ERP 发布控制台</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        --bg: #eef3f8;
        --surface: #fff;
        --soft: #f7f9fc;
        --line: #d9e2ee;
        --line-strong: #c3cede;
        --text: #142033;
        --muted: #66758a;
        --primary: #3f5f89;
        --primary-dark: #304d73;
        --success: #0f9f6e;
        --warning: #d97706;
        --shadow: 0 18px 42px rgba(20, 38, 68, 0.08);
      }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Arial, "Microsoft YaHei", sans-serif; }
      button, input, textarea { font: inherit; }
      .shell { width: min(1480px, calc(100vw - 40px)); margin: 0 auto; padding: 22px 0 32px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
      h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
      .subtitle { margin-top: 6px; color: var(--muted); font-size: 14px; }
      button { height: 34px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 13px; background: #fff; color: #27384f; font-weight: 700; cursor: pointer; }
      button:hover { border-color: rgba(63, 95, 137, 0.55); background: #f7faff; }
      button.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
      button.primary:hover { border-color: var(--primary-dark); background: var(--primary-dark); }
      button:disabled { opacity: 0.55; cursor: wait; }
      .dashboard-grid { display: grid; grid-template-columns: 360px minmax(0, 1.35fr) minmax(0, 1.1fr); gap: 12px; align-items: stretch; }
      .card { min-width: 0; min-height: 520px; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
      .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 11px; border-bottom: 1px solid #edf1f7; }
      .card-head h2 { margin: 0; font-size: 17px; }
      .card-head small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.35; }
      .card-body { flex: 1; min-height: 0; padding: 14px 16px 16px; }
      .build-card .card-body { display: flex; flex-direction: column; }
      label { display: grid; gap: 7px; margin-bottom: 12px; color: #344054; font-size: 13px; font-weight: 800; }
      textarea { width: 100%; min-height: 108px; resize: vertical; border: 1px solid var(--line-strong); border-radius: 7px; padding: 10px 11px; outline: none; }
      textarea:focus { border-color: rgba(63, 95, 137, 0.76); box-shadow: 0 0 0 3px rgba(63, 95, 137, 0.12); }
      .hint { margin: 0 0 12px; padding: 10px; border: 1px solid #e5ebf4; border-radius: 7px; background: var(--soft); color: var(--muted); font-size: 12px; line-height: 1.5; }
      .version-preview { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; padding: 10px 11px; border: 1px solid #e5ebf4; border-radius: 7px; background: #fbfcfe; }
      .version-preview span { color: var(--muted); font-size: 12px; font-weight: 800; }
      .version-preview strong { min-width: 0; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
      .build-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
      .status-text { max-height: 92px; min-height: 44px; margin-top: auto; overflow: auto; padding: 10px; border-radius: 8px; background: #101828; color: #d0d5dd; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
      .summary { display: grid; gap: 7px; margin-bottom: 12px; padding: 11px; border: 1px solid #e5ebf4; border-radius: 8px; background: #fbfcfe; }
      .summary-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .summary-title strong { min-width: 0; overflow: hidden; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
      .summary-title strong.empty { color: #9aa7b8; font-size: 15px; }
      .badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; background: #f1f5f9; color: #526174; font-size: 12px; font-weight: 800; white-space: nowrap; }
      .badge.success { background: #eaf8f2; color: #067647; }
      .badge.warning { background: #fff7e6; color: #b45309; }
      .badge.online { background: #eaf1ff; color: #285b9f; }
      .meta-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; color: var(--muted); font-size: 12px; line-height: 1.38; }
      .meta-row strong { min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
      .table-wrap { max-height: 342px; overflow: auto; border: 1px solid #e3eaf4; border-radius: 8px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
      th, td { padding: 10px 9px; border-bottom: 1px solid #edf1f7; font-size: 12px; text-align: left; vertical-align: middle; }
      th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: var(--muted); font-weight: 800; }
      tr:last-child td { border-bottom: 0; }
      tr.selected { background: #f1f6ff; }
      .col-pick { width: 42px; text-align: center; }
      .col-version { width: 154px; }
      .col-time { width: 118px; }
      .col-status { width: 86px; }
      .col-action { width: 78px; text-align: right; }
      .mono { overflow: hidden; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
      .path-cell { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
      .table-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
      .selected-note { min-width: 0; color: var(--muted); font-size: 12px; }
      .empty { display: grid; place-items: center; min-height: 220px; border: 1px dashed #cfd8e6; border-radius: 8px; background: #fbfcfe; color: var(--muted); text-align: center; }
      .empty strong { display: block; margin-bottom: 6px; color: var(--text); }
      @media (max-width: 1180px) {
        .dashboard-grid { grid-template-columns: 1fr; }
        .card { min-height: auto; }
        header { align-items: flex-start; flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div>
          <h1>ERP 发布控制台</h1>
          <div class="subtitle">先生成本地待发布版本包，再从本地版本包中选择一个发布到线上；右侧只显示真正发布过的线上版本。</div>
        </div>
        <button id="refreshBtn">刷新状态</button>
      </header>
      <div class="dashboard-grid">
        <section class="card build-card">
          <div class="card-head"><div><h2>生成版本包</h2><small>这里只负责编译当前本地代码。</small></div></div>
          <div class="card-body">
            <p class="hint">填写更新说明后点击生成。版本号自动生成，生成完成后进入中间的本地待发布列表。</p>
            <div class="version-preview"><span>即将生成版本号</span><strong id="versionPreview">-</strong></div>
            <label>更新说明 <textarea id="notesInput" placeholder="例如：修复订单同步问题，优化库存页面"></textarea></label>
            <div class="build-actions"><button class="primary" id="buildBtn">生成版本包</button></div>
            <div class="status-text" id="statusText">准备就绪。</div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>本地待发布版本包</h2><small>最新版本排在最上面；状态显示已发布或未发布。</small></div></div>
          <div class="card-body"><div id="pendingSummary"></div><div id="releaseTable"></div></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>线上版本</h2><small>只有发布成功后的版本才会进入这里。</small></div></div>
          <div class="card-body"><div id="onlineSummary"></div><div id="onlineList"></div></div>
        </section>
      </div>
    </div>
    <script>
      const versionPreview = document.getElementById("versionPreview");
      const notesInput = document.getElementById("notesInput");
      const statusText = document.getElementById("statusText");
      const pendingSummary = document.getElementById("pendingSummary");
      const releaseTable = document.getElementById("releaseTable");
      const onlineSummary = document.getElementById("onlineSummary");
      const onlineList = document.getElementById("onlineList");
      const buttons = Array.from(document.querySelectorAll("button"));
      let state = null;
      let selectedVersion = "";
      function htmlEscape(value) {
        return String(value ?? "").replace(/[&<>"']/g, function (char) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
        });
      }
      function timeText(value) {
        if (!value) return "-";
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return value;
        return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
      }
      function setBusy(busy) { buttons.forEach(function (button) { button.disabled = busy; }); }
      function setStatus(message, detail) {
        const more = Array.isArray(detail) ? detail.join("\\n") : String(detail || "");
        statusText.textContent = more ? String(message || "") + "\\n" + more : String(message || "");
      }
      async function api(path, options) {
        const response = await fetch(path, { ...(options || {}), headers: { "Content-Type": "application/json", ...((options || {}).headers || {}) } });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(data.error || "请求失败");
          error.detail = data.validation?.detail || "";
          throw error;
        }
        return data;
      }
      function releaseByVersion(version) {
        return (state?.releases || []).find(function (release) { return release.version === version; }) || null;
      }
      function renderSummary() {
        const selected = releaseByVersion(selectedVersion) || state?.pending || null;
        pendingSummary.innerHTML = '<div class="summary">' +
          '<div class="summary-title"><strong class="' + (selected ? "" : "empty") + '">' + htmlEscape(selected?.version || "还没有生成版本包") + '</strong><span class="badge ' + (selected?.isPublished ? "online" : "warning") + '">' + (selected ? (selected.isPublished ? "已发布" : "未发布") : "未生成") + '</span></div>' +
          '<div class="meta-row"><span>创建时间</span><strong>' + htmlEscape(timeText(selected?.builtAt)) + '</strong></div>' +
          '<div class="meta-row"><span>包目录</span><strong title="' + htmlEscape(selected?.path || "-") + '">' + htmlEscape(selected?.path || "-") + '</strong></div>' +
        '</div>';
        onlineSummary.innerHTML = '<div class="summary">' +
          '<div class="summary-title"><strong class="' + (state?.online?.version ? "" : "empty") + '">' + htmlEscape(state?.online?.version || "尚未发布版本") + '</strong><span class="badge ' + (state?.online?.version ? "online" : "warning") + '">' + (state?.online?.version ? "当前线上" : "未发布") + '</span></div>' +
          '<div class="meta-row"><span>发布时间</span><strong>' + htmlEscape(timeText(state?.online?.publishedAt)) + '</strong></div>' +
          '<div class="meta-row"><span>线上目录</span><strong title="' + htmlEscape(state?.online?.liveDir || "-") + '">' + htmlEscape(state?.online?.liveDir || "-") + '</strong></div>' +
        '</div>';
      }
      function renderReleaseTable() {
        if (!state.releases.length) {
          releaseTable.innerHTML = '<div class="empty"><div><strong>\u6682\u65e0\u7248\u672c\u5305</strong><span>\u8bf7\u5148\u5728\u5de6\u4fa7\u751f\u6210\u7248\u672c\u5305\u3002</span></div></div>';
          return;
        }
        releaseTable.innerHTML = '<div class="table-wrap"><table><thead><tr><th class="col-pick">\u9009\u62e9</th><th class="col-version">\u7248\u672c\u53f7</th><th class="col-time">\u521b\u5efa\u65f6\u95f4</th><th class="col-status">\u72b6\u6001</th><th>\u5305\u76ee\u5f55</th><th class="col-action">\u64cd\u4f5c</th></tr></thead><tbody>' +
          state.releases.map(function (release) {
            const checked = release.version === selectedVersion;
            return '<tr class="' + (checked ? "selected" : "") + '" data-version="' + htmlEscape(release.version) + '">' +
              '<td class="col-pick"><input type="radio" name="releaseVersion" value="' + htmlEscape(release.version) + '"' + (checked ? " checked" : "") + ' /></td>' +
              '<td><div class="mono" title="' + htmlEscape(release.version) + '">' + htmlEscape(release.version) + '</div></td>' +
              '<td>' + htmlEscape(timeText(release.builtAt)) + '</td>' +
              '<td><span class="badge ' + (release.isPublished ? "online" : "warning") + '">' + (release.isPublished ? "\u5df2\u53d1\u5e03" : "\u672a\u53d1\u5e03") + '</span></td>' +
              '<td><div class="path-cell" title="' + htmlEscape(release.path) + '">' + htmlEscape(release.path) + '</div></td>' +
              '<td class="col-action"><button data-publish-version="' + htmlEscape(release.version) + '">\u4e0a\u67b6</button></td>' +
            '</tr>';
          }).join("") + '</tbody></table></div>' +
          '<div class="table-actions"><div class="selected-note">\u9009\u4e2d\u7248\u672c\uff1a' + htmlEscape(selectedVersion || "-") + '</div><button class="primary" id="publishSelectedBtn">\u4e0a\u67b6\u9009\u4e2d\u7248\u672c</button></div>';
        releaseTable.querySelectorAll('input[name="releaseVersion"]').forEach(function (input) {
          input.addEventListener("change", function () {
            selectedVersion = input.value;
            render(state);
          });
        });
        releaseTable.querySelectorAll('tr[data-version]').forEach(function (row) {
          row.addEventListener("click", function (event) {
            if (event.target.closest("button")) return;
            selectedVersion = row.dataset.version;
            render(state);
          });
        });
        releaseTable.querySelectorAll('button[data-publish-version]').forEach(function (button) {
          button.addEventListener("click", function () {
            selectedVersion = button.dataset.publishVersion;
            publish(selectedVersion);
          });
        });
        document.getElementById("publishSelectedBtn").addEventListener("click", function () { publish(selectedVersion); });
      }

      function renderOnlineList() {
        const rows = state.publishedReleases || [];
        if (!rows.length) {
          onlineList.innerHTML = '<div class="empty"><div><strong>暂无线上版本</strong><span>只有发布成功后的版本才会出现在这里。</span></div></div>';
          return;
        }
        onlineList.innerHTML = '<div class="table-wrap"><table><thead><tr><th class="col-version">版本号</th><th class="col-time">发布时间</th><th class="col-status">状态</th><th>线上目录</th></tr></thead><tbody>' +
          rows.map(function (release) {
            const isOnline = release.isOnline;
            return '<tr class="' + (isOnline ? "selected" : "") + '">' +
              '<td><div class="mono" title="' + htmlEscape(release.version) + '">' + htmlEscape(release.version) + '</div></td>' +
              '<td>' + htmlEscape(timeText(release.publishedAt)) + '</td>' +
              '<td><span class="badge ' + (isOnline ? "success" : "online") + '">' + (isOnline ? "当前线上" : "已发布") + '</span></td>' +
              '<td><div class="path-cell" title="' + htmlEscape(release.liveDir || "-") + '">' + htmlEscape(release.liveDir || "-") + '</div></td>' +
            '</tr>';
          }).join("") + '</tbody></table></div>';
      }
      function render(next) {
        state = next;
        const hasSelected = state.releases.some(function (release) { return release.version === selectedVersion; });
        if (!hasSelected) selectedVersion = state.pending?.version || state.releases[0]?.version || "";
        versionPreview.textContent = state.workspace.nextVersion || "-";
        renderSummary();
        renderReleaseTable();
        renderOnlineList();
      }
      async function refresh() { render(await api("/api/state")); }
      async function build() {
        setBusy(true);
        try {
          setStatus("正在生成版本包...");
          const result = await api("/api/build", { method: "POST", body: JSON.stringify({ notes: notesInput.value }) });
          selectedVersion = result.version;
          notesInput.value = "";
          setStatus("版本包生成完成：" + result.version, result.log || []);
          await refresh();
        } catch (error) {
          setStatus(error.message, error.detail);
        } finally {
          setBusy(false);
        }
      }
      async function publish(version) {
        if (!version) {
          setStatus("\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u5f85\u4e0a\u67b6\u7248\u672c\u5305\u3002");
          return;
        }
        const current = state?.online?.version || "\u5c1a\u672a\u53d1\u5e03\u7248\u672c";
        if (!window.confirm("\u786e\u8ba4\u4e0a\u67b6\u7248\u672c " + version + "\uff0c\u66ff\u6362\u5f53\u524d\u7ebf\u4e0a\u7248\u672c " + current + " \u5417\uff1f")) return;
        setBusy(true);
        try {
          setStatus("\u6b63\u5728\u4e0a\u67b6\u7248\u672c " + version + "...");
          const result = await api("/api/publish", { method: "POST", body: JSON.stringify({ version, message: notesInput.value }) });
          setStatus("\u4e0a\u67b6\u6210\u529f\uff0c\u5f53\u524d\u7ebf\u4e0a\u7248\u672c\uff1a" + result.version);
          await refresh();
        } catch (error) {
          setStatus(error.message);
        } finally {
          setBusy(false);
        }
      }
      document.getElementById("refreshBtn").addEventListener("click", refresh);
      document.getElementById("buildBtn").addEventListener("click", build);
      refresh().catch(function (error) { setStatus(error.message); });
      window.setInterval(function () {
        if (!buttons.some(function (button) { return button.disabled; })) refresh().catch(function () {});
      }, 5000);
    </script>
  </body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    const html = pageV4();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html)
    });
    res.end(html);
  } catch (error) {
    json(res, { error: error.message || String(error) }, error.status || 500);
  }
});

const config = await readConfig();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`Release manager: http://127.0.0.1:${config.port}`);
  console.log(`Live directory: ${config.liveDir}`);
});
