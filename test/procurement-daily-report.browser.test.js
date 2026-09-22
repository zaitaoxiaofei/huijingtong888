import test from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";
import ExcelJS from "exceljs";
import sharp from "sharp";

test("daily export downloads embedded images and exposes copyable WeChat summary", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1" }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "purchase-export-browser-"));
  const entry = `import {createApp} from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; import Export from '/frontend/admin/components/procurement/DailyPurchaseExport.vue'; createApp(Export).use(ElementPlus).mount('#app');`;
  let browser;
  try {
    await build({ configFile: false, root: process.cwd(), logLevel: "error", plugins: [vue(), {
      name: "daily-export-fixture", resolveId(id) { if (id === "virtual:daily-export") return "\0daily-export"; },
      load(id) { if (id === "\0daily-export") return entry; }
    }], build: { outDir: output, cssCodeSplit: false, rollupOptions: { input: "virtual:daily-export", output: { entryFileNames: "entry.js" } } } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedSummary = text; } } }));
    let empty = false;
    const image = await sharp({ create: { width: 64, height: 84, channels: 3, background: "#336699" } }).png().toBuffer();
    await page.route("http://localhost:8788/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === "/api/procurement/daily-report") return route.fulfill({ json: { date: url.searchParams.get("date"), rows: empty ? [] : [{ product_id: 1, product_code: "P-001", inventory_number: "1-1", inventory_category: "钥匙壳", product_name: "钥匙壳 JELAND J6 蓝色", quantity: 3, amount: 120.5, shipping_amount: 8, purchased_at: "2026-09-15 16:00:00", status: "purchased" }] } });
      if (url.pathname === "/api/products/1/image") return route.fulfill({ contentType: "image/png", body: image });
      const asset = url.pathname === "/style.css" ? path.join("assets", (await fs.readdir(path.join(output, "assets"))).find((name) => name.endsWith(".css"))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto("http://localhost:8788/admin.html");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出每日采购清单" }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^每日采购清单-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await download.path());
    assert.equal(workbook.getWorksheet("每日采购清单").getImages().length, 1);
    assert.equal(workbook.getWorksheet("每日采购清单").getCell("B4").value, "1_1");
    await page.getByRole("button", { name: "复制微信总结" }).click();
    assert.match(await page.evaluate(() => window.copiedSummary), /钥匙壳 JELAND J6 蓝色（1_1）：3 件，货款¥ 120.5 元/);
    assert.match(await page.evaluate(() => window.copiedSummary), /合计 ¥128.50/);
    await page.screenshot({ path: "/tmp/procurement-daily-export.png" });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    empty = true;
    await page.getByRole("button", { name: "导出每日采购清单" }).click();
    await page.getByText(/暂无已确认采购记录/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
