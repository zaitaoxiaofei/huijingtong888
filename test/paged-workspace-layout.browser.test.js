import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startPagedWorkspacePreview } from "./fixtures/paged-workspace-preview.js";

// Uses the same Ego browser as interactive QA, against a local server whose API
// accepts GET only and always returns fixtures. Never connects to production.
test("paged workspaces retain controls, headers and pagination through scrolling and mode changes", {
  skip: process.env.RUN_TASK_BROWSER_TESTS !== "1", timeout: 240000
}, async () => {
  const server = await startPagedWorkspacePreview();
  const evidence = path.resolve(".verification/paged-workspace-layout.jsonl");
  const space = process.env.EGO_LAYOUT_SPACE_ID;
  const script = `
const task = await taskSpace(${space ? Number(space) : JSON.stringify(`ERP list layout regression ${Date.now()}`)});
const page = task.page("p1");
const tableSelector = '[data-erp-paged-layout="table"]';
const results = [];
for (const width of [1366, 1920]) {
  for (const route of ["/fixture", "/orders", "/orders?mode=inventory", "/procurement/workspace", "/procurement/workspace?mode=arrivals", "/procurement/workspace?mode=purchase", "/collector-box", "/inventory/products"]) {
    await page.goto("http://localhost:8788/admin.html#" + route);
    await page.waitForSelector(tableSelector, {timeout: 30000});
    await page.cdp("Emulation.setDeviceMetricsOverride", {width, height: width === 1366 ? 768 : 1080, deviceScaleFactor: 1, mobile: false});
    await page.waitForFunction(() => document.querySelector('[data-erp-paged-layout="table"]')?.clientHeight > 100);
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('[data-erp-paged-layout="table"], [data-erp-paged-layout="footer"]')];
      if (nodes.length < 2 || !document.querySelector('[data-erp-paged-layout="table"] .el-table__header-wrapper')) return false;
      const key = JSON.stringify(nodes.map(node => {const r=node.getBoundingClientRect();return [r.top,r.height,r.width];}));
      if (key !== window.layoutStableKey) {window.layoutStableKey=key;window.layoutStableCount=0;return false;}
      return ++window.layoutStableCount >= 3;
    });
    const before = await page.evaluate(() => {
      const table = document.querySelector('[data-erp-paged-layout="table"]');
      const rect = table.getBoundingClientRect();
      const header = table.querySelector('.el-table__header-wrapper').getBoundingClientRect();
      const footer = document.querySelector('[data-erp-paged-layout="footer"]').getBoundingClientRect();
      const panel = document.querySelector('.erp-workspace-panel');
      if (footer.bottom > innerHeight + 1 || footer.top < 0) throw Error('Pagination outside viewport');
      if (table.clientHeight < 100) throw Error('Table collapsed');
      if (panel.scrollHeight > panel.clientHeight + 2) throw Error('Whole page still scrolls');
      return {header: header.top, footer: footer.top, footerBottom: footer.bottom, x: rect.left + Math.min(600, rect.width / 2), y: header.bottom + 80};
    });
    await page.evaluate(() => {
      const wrap = document.querySelector('[data-erp-paged-layout="table"] > .el-table__inner-wrapper > .el-table__body-wrapper .el-scrollbar__wrap');
      wrap.scrollTop = wrap.scrollHeight;
    });
    await page.waitForFunction(() => {
      const wrap = document.querySelector('[data-erp-paged-layout="table"] > .el-table__inner-wrapper > .el-table__body-wrapper .el-scrollbar__wrap');
      return wrap && wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2;
    });
    const result = await page.evaluate(before => {
      const table = document.querySelector('[data-erp-paged-layout="table"]');
      const header = table.querySelector('.el-table__header-wrapper').getBoundingClientRect();
      const footer = document.querySelector('[data-erp-paged-layout="footer"]').getBoundingClientRect();
      const last = table.querySelector('.el-table__body tbody tr:last-child')?.getBoundingClientRect();
      const wrap = table.querySelector('.el-table__body-wrapper .el-scrollbar__wrap');
      if (Math.abs(header.top - before.header) > 1 || Math.abs(footer.top - before.footer) > 1) throw Error('Fixed controls moved: '+JSON.stringify({before,header:header.top,footer:footer.top}));
      if (last && last.bottom > wrap.getBoundingClientRect().bottom + 2) throw Error('Last row obscured');
      if (window.layoutErrors.length) throw Error(window.layoutErrors.join(';'));
      return {tableHeight: table.clientHeight, footerBottom: footer.bottom, scrollTop: wrap.scrollTop, lastRowVisible: true};
    }, before);
    results.push({route, width, ...result});
    console.log(JSON.stringify(results.at(-1)));
  }
}
await page.goto('http://localhost:8788/admin.html#/orders');
await page.waitForSelector(tableSelector);
await page.evaluate(() => window.layoutRouter.replace('/orders?mode=inventory'));
await page.waitForFunction(() => getComputedStyle(document.querySelector('.orders-print-workspace')).display === 'none' && document.querySelector('.supply-table')?.clientHeight > 100);
await page.evaluate(() => window.layoutRouter.replace('/orders'));
await page.waitForSelector('.orders-table[data-erp-paged-layout="table"]');
await page.goto('http://localhost:8788/admin.html#/fixture');
await page.waitForSelector(tableSelector);
await page.click('button[aria-label="Go to next page"]');
await page.waitForFunction(() => document.querySelector('.erp-page-status').textContent.includes('2 /'));
await page.click('text="打开库存详情"');
await page.waitForSelector('.el-dialog');
await page.evaluate(() => {
  if (document.querySelector('.el-dialog [data-erp-paged-layout]')) throw Error('Dialog layout was overridden');
  window.layoutFixture.dialog.value = false;
  window.layoutFixture.rows.value = [];
});
await page.waitForFunction(() => document.querySelector('.el-table__empty-block'));
await page.evaluate(() => {
  const footer = document.querySelector('[data-erp-paged-layout="footer"]');
  if (!footer || footer.getBoundingClientRect().bottom > innerHeight) throw Error('Empty-list pagination hidden');
  window.layoutFixture.tab.value = 'report';
});
await page.waitForFunction(() => !document.querySelector('.erp-workspace-panel[data-erp-paged-layout]'));
await page.evaluate(() => {
  const panel = document.querySelector('.erp-workspace-panel');
  if (getComputedStyle(panel).overflowY !== 'auto') throw Error('Non-list page lost normal scrolling');
  window.layoutFixture.tab.value = 'list';
});
await page.waitForSelector(tableSelector);
await page.cdp('Emulation.setDeviceMetricsOverride', {width: 375, height: 812, deviceScaleFactor: 1, mobile: true});
await page.waitForFunction(() => !document.querySelector('[data-erp-paged-layout]'));
console.log(JSON.stringify({modeSwitch: true, paginationClick: true, dialogUnchanged: true, emptyList: true, reportScrolling: true, mobileFallback: true}));
${space ? "" : "await task.finish({keep: []});"}
`;
  try {
    const running = promisify(execFile)("ego-browser", ["nodejs", "-e", script], { timeout: 220000, maxBuffer: 1024 * 1024 });
    running.child.stdin.end();
    running.child.stdout.on("data", chunk => process.stdout.write(chunk));
    running.child.stderr.on("data", chunk => process.stdout.write(chunk));
    const { stdout, stderr } = await running;
    const output = stdout + stderr;
    await fs.mkdir(path.dirname(evidence), { recursive: true });
    await fs.writeFile(evidence, output);
    assert.equal(output.split("\n").filter(line => line.startsWith('{"route"')).length, 16);
    assert.match(output, /"modeSwitch":true/);
  } finally {
    await server.close();
    await fs.rm(server.config.cacheDir, { recursive: true, force: true });
  }
});
