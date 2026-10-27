import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("the actual monitor page distinguishes unknown from zero in light and dark modes", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1" }, async () => {
  const temporary = await fs.realpath(os.tmpdir());
  const output = await fs.mkdtemp(path.join(temporary, "ozon-monitor-values-"));
  assert.equal(path.dirname(output), temporary);
  const entry = `import {createApp} from 'vue';
    import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
    import '/frontend/admin/styles/index.css'; import '/frontend/admin/styles/erp-theme.css';
    import Monitor from '/frontend/admin/views/settings/SystemMonitoringView.vue';
    import {applyAppearancePreferences} from '/frontend/admin/utils/theme-presets.js';
    window.monitorAppearance=mode=>applyAppearancePreferences({version:1,mode,palettes:{light:'classic',dark:'classic'}},document);
    createApp(Monitor).use(ElementPlus).mount('#app');`;
  let browser, requests = 0;
  const errors = [];
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: "error", plugins: [vue(), {
      name: "monitor-values-fixture", resolveId(id) { if (id === "virtual:monitor-values") return "\0monitor-values"; },
      load(id) { if (id === "\0monitor-values") return entry; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: "virtual:monitor-values", output: { entryFileNames: "entry.js" } } } });
    const css = (await fs.readdir(path.join(output, "assets"))).find(name => name.endsWith(".css"));
    const chrome = process.env.CHROME_PATH || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost:8788/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: `<html><head><link rel="stylesheet" href="/assets/${css}"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
      if (url.pathname.startsWith("/api/")) {
        assert.equal(request.method(), "GET"); assert.equal(url.pathname, "/api/system-monitoring"); requests++;
        const latest = { capturedAt: "2026-10-27T08:00:00Z", usagePercent: 60, diskTotalBytes: 100 * 1024 ** 3,
          diskUsedBytes: 60 * 1024 ** 3, diskAvailableBytes: 40 * 1024 ** 3, dailyGrowthBytes: 0,
          mysqlBytes: requests > 1 ? 0 : null, binlogBytes: 0, uploadsBytes: 2048, backupsBytes: 4096,
          releasesBytes: 8192, logsBytes: null, appRssBytes: 1024, severity: "warning", topTables: [] };
        return route.fulfill({ json: { latest, history: [latest], thresholds: { warningDailyGrowthBytes: 512 * 1024 ** 2 } } });
      }
      const asset = path.resolve(output, "." + url.pathname);
      assert.ok(asset.startsWith(output + path.sep));
      return route.fulfill({ contentType: asset.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(asset) });
    });
    await page.goto("http://localhost:8788/admin.html");
    const rows = page.locator(".monitor-grid .panel").first().locator(".el-table__body tbody tr");
    await rows.first().getByText("未采集", { exact: true }).first().waitFor();
    const layout = [];
    for (const mode of ["light", "dark"]) {
      await page.evaluate(mode => window.monitorAppearance(mode), mode);
      assert.equal(await rows.count(), 6);
      assert.equal((await rows.first().innerText()).split("未采集").length - 1, 2);
      assert.match(await rows.nth(1).innerText(), /0\.0 B/);
      assert.match(await rows.nth(1).innerText(), /0\.0%/);
      assert.match(await page.locator(".history-panel .el-table__body tbody tr").first().innerText(), /未采集/);
      layout.push(await page.locator(".monitor-grid").evaluate(node => ({ columns: getComputedStyle(node).gridTemplateColumns, width: Math.round(node.getBoundingClientRect().width) })));
    }
    assert.deepEqual(layout[0], layout[1]);
    await page.getByRole("button", { name: "刷新数据" }).click();
    await rows.first().getByText("0.0 B", { exact: true }).waitFor();
    assert.equal(requests, 2); assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
