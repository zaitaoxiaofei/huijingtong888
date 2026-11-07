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
    let empty = false, reportCalls = 0, reportDates;
    const image = await sharp({ create: { width: 64, height: 84, channels: 3, background: "#336699" } }).png().toBuffer();
    await page.route("http://localhost:8788/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>' });
      if (url.pathname === "/api/procurement/daily-report") {
        reportCalls++;
        reportDates = [url.searchParams.get("dateFrom"), url.searchParams.get("dateTo")];
        const row = { product_id: 1, product_code: "P-001", inventory_number: "1-1", inventory_category: "钥匙壳", product_name: "钥匙壳 JELAND J6 蓝色", quantity: 3, amount: 120.5, shipping_amount: 8, purchased_at: `${reportDates[0]}T00:00:00+08:00`, status: "purchased" };
        const rows = [row];
        if (reportDates[0] !== reportDates[1]) rows.push({ ...row, quantity: 5, amount: 200, shipping_amount: 0, purchased_at: `${reportDates[1]}T00:00:00+08:00` });
        return route.fulfill({ json: { dateFrom: reportDates[0], dateTo: reportDates[1], rows: empty ? [] : rows } });
      }
      if (url.pathname === "/api/products/1/image") return route.fulfill({ contentType: "image/png", body: image });
      const asset = url.pathname === "/style.css" ? path.join("assets", (await fs.readdir(path.join(output, "assets"))).find((name) => name.endsWith(".css"))) : url.pathname.slice(1);
      return route.fulfill({ contentType: asset.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(path.join(output, asset)) });
    });
    await page.goto("http://localhost:8788/admin.html");
    assert.equal(await page.locator('.el-date-editor').count(),0,'toolbar contains no date filter');
    await page.getByRole('button',{name:'导出采购记录',exact:true}).click();
    await page.getByRole('dialog',{name:'导出采购记录',exact:true}).waitFor();
    await page.getByText(/导出所选日期内全部正式采购记录，不受工作台需求分类、库存缺口或当前分页影响/).waitFor();
    assert.equal(reportCalls,0,'opening the export dialog does not query records');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(reportCalls,0,'cancel does not export or query');
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出采购记录", exact:true }).click();
    await page.getByRole("button", { name: "确认导出", exact:true }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^采购清单-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await download.path());
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [reportDates[0]]);
    assert.equal(workbook.getWorksheet(reportDates[0]).getImages().length, 1);
    assert.equal(workbook.getWorksheet(reportDates[0]).getCell("B4").value, "1-1");
    await page.getByRole("button", { name: "复制微信总结" }).click();
    assert.match(await page.evaluate(() => window.copiedSummary), /钥匙壳 JELAND J6 蓝色（1-1）：3 件，货款¥ 120.5 元/);
    assert.match(await page.evaluate(() => window.copiedSummary), /合计 ¥128.50/);
    await page.screenshot({ path: path.join(os.tmpdir(), "procurement-daily-export.png") });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "导出采购记录", exact:true }).click();
    const dates = page.getByRole('dialog',{name:'导出采购记录',exact:true}).locator('.el-range-input');
    await dates.nth(0).fill('2026-10-01');
    await dates.nth(1).fill('2026-10-05');
    await dates.nth(1).press('Enter');
    const rangeDownloadPromise = page.waitForEvent('download');
    await page.getByRole("button", { name: "确认导出", exact:true }).click();
    const rangeDownload = await rangeDownloadPromise;
    assert.equal(rangeDownload.suggestedFilename(), '采购清单-2026-10-01至2026-10-05.xlsx');
    assert.deepEqual(reportDates, ['2026-10-01', '2026-10-05']);
    const rangeWorkbook = new ExcelJS.Workbook();
    await rangeWorkbook.xlsx.readFile(await rangeDownload.path());
    assert.deepEqual(rangeWorkbook.worksheets.map((sheet) => sheet.name), ['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05']);
    assert.equal(rangeWorkbook.getWorksheet('2026-10-01').getCell('D4').value, 3);
    assert.equal(rangeWorkbook.getWorksheet('2026-10-05').getCell('D4').value, 5);
    assert.equal(rangeWorkbook.getWorksheet('2026-10-02').getImages().length, 0);
    await page.getByRole("button", { name: "复制微信总结" }).click();
    const rangeSummary = await page.evaluate(() => window.copiedSummary);
    assert.equal(rangeSummary.match(/【采购清单】/g).length, 5);
    assert.match(rangeSummary, /【采购清单】2026-10-01（北京时间）\n共采购 1 种商品，3 件/);
    assert.match(rangeSummary, /【采购清单】2026-10-05（北京时间）\n共采购 1 种商品，5 件/);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    empty = true;
    await page.getByRole("button", { name: "导出采购记录", exact:true }).click();
    await page.getByRole("button", { name: "确认导出", exact:true }).click();
    await page.getByText(/暂无已确认采购记录/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
