import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const manifestPath = path.resolve(rootDir, "public", "vue-apps", ".vite", "manifest.json");
const adminHtmlPath = path.resolve(rootDir, "public", "admin.html");

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const adminEntry = manifest["frontend/admin/main.js"];
  const globalStyleEntry = manifest["style.css"];

  if (!adminEntry?.file) {
    throw new Error("Vite manifest 缺少 frontend/admin/main.js 入口。");
  }

  const styleFiles = [
    ...(globalStyleEntry?.file ? [globalStyleEntry.file] : []),
    ...((adminEntry.css || []).filter(Boolean))
  ];

  const styleTags = styleFiles
    .map((file) => `    <link rel="stylesheet" href="/vue-apps/${file}" />`)
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OZON ERP</title>
    <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='28' font-family='Arial, sans-serif' font-weight='700' fill='white'%3EOZ%3C/text%3E%3C/svg%3E" />
${styleTags}
  </head>
  <body>
    <div id="adminApp"></div>
    <script type="module" src="/vue-apps/${adminEntry.file}"></script>
  </body>
</html>
`;

  await fs.writeFile(adminHtmlPath, html, "utf8");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
