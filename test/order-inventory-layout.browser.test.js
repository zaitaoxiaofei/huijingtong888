import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

const children = [
  { id: 11, name: "不锈钢门槛条加厚拉丝银色汽车内外保护配件适用多款车型完整长名称", quantity: 2, stock: 0, incoming: 0, shortage: 2 },
  { id: 12, name: "车标装饰贴片高亮黑色耐磨防水组合配件长名称用于验证库存栏省略显示", quantity: 4, stock: 0, incoming: 4, shortage: 0 },
  { id: 13, name: "包装礼盒", quantity: 2, stock: 2, incoming: 0, shortage: 0 },
  { id: 14, name: "钥匙扣数量待核", quantity: 2, review: true }
];

function orderFixture() {
  const common = {
    shop_id: 1, shop_name: "布局验证店铺", status: "awaiting_packaging",
    ordered_at: "2026-10-21T08:00:00Z", updated_at: "2026-10-21T09:00:00Z",
    revenue: 50, estimated_profit: 0, actual_profit: 0, item_count: 1,
    settlement_states: "pending", profit_statuses: "estimated", actual_profit_ready: 0,
    fulfillment_type_label: "FBS", logistics_carrier_label: "OGL", delivery_method_name: "OGL Extra Small"
  };
  const row = {
    ...common, id: 1, posting_number: "INVENTORY-LAYOUT-1", skus: "SKU-1", product_ids: "10",
    product_names: "汽车装饰套装", sku_names: "SKU-1:汽车装饰套装",
    sku_product_ids: "SKU-1:10", sku_inventory_modes: "SKU-1:single", sku_component_counts: "SKU-1:4",
    sku_inventory_names: "SKU-1:汽车装饰套装", sku_inventory_numbers: "SKU-1:2-10",
    sku_quantities: "SKU-1:2", sku_order_item_ids: "SKU-1:101",
    sku_stock_summaries: "SKU-1:0:5:-5", sku_incoming_summaries: "SKU-1:4",
    inventory_picking_items: children.map((item) => ({
      parent_product_id: 10, sku: "SKU-1", product_id: item.id, product_name: item.name,
      inventory_number: `2-${item.id}`, required_quantity: item.quantity, per_set_quantity: item.quantity / 2
    })),
    procurement_coverage: { needs_fulfillment: true, stock_location: "LOCAL", inventory_needs_review: true,
      items: children.map((item) => ({
        product_id: item.id, product_name: item.name, quantity: item.quantity,
        stock_quantity: item.stock, incoming_quantity: item.incoming, shortage_quantity: item.shortage,
        product_local_available: item.review ? null : item.stock,
        physical_stock_estimate: item.review ? null : item.stock + 3,
        quantity_needs_review: item.review || false
      }))
    },
    fbp_inventory: [{ shop_id: 1, ozon_sku: "SKU-1", present: 5, available: 4, synced_at: "2026-10-21T09:00:00Z" }]
  };
  return [row, {
    ...common, id: 2, posting_number: "INVENTORY-SINGLE-2", skus: "SKU-2", product_ids: "20",
    product_names: "单品库存", sku_product_ids: "SKU-2:20", sku_quantities: "SKU-2:1",
    sku_inventory_names: "SKU-2:单品库存", sku_inventory_numbers: "SKU-2:2-20",
    procurement_coverage: { needs_fulfillment: true, stock_location: "LOCAL", items: [{
      product_id: 20, quantity: 1, stock_quantity: 1, incoming_quantity: 0, shortage_quantity: 0,
      product_local_available: 6, physical_stock_estimate: 8
    }] }
  }, {
    ...common, id: 3, posting_number: "INVENTORY-UNBOUND-3", skus: "SKU-3", unbound_skus: "SKU-3",
    product_names: "待绑定商品", sku_quantities: "SKU-3:1", sku_inventory_modes: "SKU-3:unbound"
  }];
}

function ledgerFixture(id) {
  const item = children.find((child) => child.id === id);
  return {
    product: { id, name: item.name, code: `P-${id}`, inventory_number: `2-${id}` }, revision: `fixture-${id}`,
    physical_estimate: id === 11 ? 12 : 27, available_estimate: id === 11 ? 8 : 22,
    open_order_demand: id === 11 ? 3 : 4, fbp_reserved: 1, current_stock_reserved: item.stock || 0,
    incoming_quantity: 5, current_incoming: item.incoming || 0, current_shortage: item.shortage || 0,
    local_stock: -5, missing_purchase: 0, missing_receipt: 0, purchase_quantity: 0, received_quantity: 0,
    fbp_inventory: { present: 11, available: 10, incomplete: false, rows: [
      { shop_id: 1, shop_name: "布局验证店铺", ozon_sku: "SKU-1", present: 5, available: 4,
        per_set_quantity: 1, inventory_quantity: 5, warehouse_name: "仓一", synced_at: "2026-10-21T09:00:00Z" },
      { shop_id: 2, shop_name: "第二店铺", ozon_sku: "SKU-2", present: 3, available: 3,
        per_set_quantity: 2, inventory_quantity: 6, warehouse_name: "仓二" }
    ] },
    orders: [{ order_id: 1, order_item_id: id, posting_number: "INVENTORY-LAYOUT-1", needs_fulfillment: true,
      quantity: item.quantity, stock_quantity: item.stock, incoming_quantity: item.incoming,
      shortage_quantity: item.shortage, quantity_needs_review: item.review || false }],
    movements: [], actions: [], purchases: [], cost_tasks: [], batches: [], sources: []
  };
}

test("real orders inventory layout and mark notes preserve selection, scrolling and saved values", {
  skip: process.env.RUN_ORDER_INVENTORY_LAYOUT_BROWSER_TESTS !== "1", timeout: 180000
}, async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "order-inventory-layout-"));
  let browser;
  const requests = [], errors = [], markUpdates = [];
  try {
    await build({ configFile: false, root: process.cwd(), publicDir: false, logLevel: "error", plugins: [vue(), {
      name: "order-inventory-layout-fixture",
      resolveId(id) { if (id === "virtual:order-inventory-layout") return "\0order-inventory-layout"; },
      load(id) { if (id === "\0order-inventory-layout") return `
        import {createApp,h} from 'vue'; import {createPinia} from 'pinia';
        import {createRouter,createWebHashHistory,RouterView} from 'vue-router';
        import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
        import OrdersPage from '/frontend/orders/OrdersPage.vue';
        const router=createRouter({history:createWebHashHistory(),routes:[{path:'/orders',component:OrdersPage}]});
        createApp({render:()=>h(RouterView)}).use(createPinia()).use(router).use(ElementPlus).mount('#app');
      `; }
    }], build: { outDir: outputDir, minify: false, cssCodeSplit: false,
      rollupOptions: { input: "virtual:order-inventory-layout", output: { entryFileNames: "entry.js" } } } });
    browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined),
      headless: true
    });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      const pageRequests = [];
      let releaseSlow, delayAccessory = false, failAccessory = false, failNextMark = false;
      let releaseAvailability;
      const availabilityReady = new Promise((resolve) => { releaseAvailability = resolve; });
      const savedMarks = new Map();
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "http://localhost:8788") return route.abort();
        if (url.pathname.startsWith("/api/")) {
          const request = { method: route.request().method(), url: url.pathname + url.search };
          requests.push(request); pageRequests.push(request);
          if (request.method === "PUT" && url.pathname === "/api/orders/1/mark") {
            const body = route.request().postDataJSON();
            markUpdates.push(body);
            if (failNextMark) {
              failNextMark = false;
              return route.fulfill({ status: 503, json: { error: "fixture mark save failed" } });
            }
            const saved = { mark_type: String(body.mark_type || "").trim(), note: String(body.note || "").trim() };
            savedMarks.set(1, saved);
            return route.fulfill({ json: { ok: true, id: 1, ...saved } });
          }
          if (request.method !== "GET") return route.abort("blockedbyclient");
          if (url.pathname === "/api/orders/inventory-availability") {
            await availabilityReady;
            return route.fulfill({ json: { rows: [
              { order_id: 1, inventory_availability: [
                { product_id: 11, physical_stock: 12, available_stock: 0, inventory_needs_review: false },
                { product_id: 12, physical_stock: 27, available_stock: 22, inventory_needs_review: false },
                { product_id: 13, physical_stock: 9, available_stock: 7, inventory_needs_review: false },
                { product_id: 14, physical_stock: 8, available_stock: 6, inventory_needs_review: false }
              ] },
              { order_id: 2, inventory_availability: [{ product_id: 20, physical_stock: 8, available_stock: 6, inventory_needs_review: false }] },
              { order_id: 3, inventory_availability: [] }
            ] } });
          }
          if (url.pathname === "/api/orders") return route.fulfill({ json: {
            rows: orderFixture().map((row) => savedMarks.has(row.id)
              ? { ...row, mark_type: savedMarks.get(row.id).mark_type, mark_note: savedMarks.get(row.id).note } : row),
            total: 3, page: 1, pageSize: 20, counts: { all: 3, awaiting_packaging: 3 }
          } });
          if (url.pathname === "/api/shops") return route.fulfill({ json: [{ id: 1, name: "布局验证店铺" }] });
          if (url.pathname === "/api/procurement/ledger") {
            const id = Number(url.searchParams.get("product_id"));
            if (id === 12 && failAccessory) return route.fulfill({ status: 503, json: { error: "fixture temporarily unavailable" } });
            if (id === 12 && delayAccessory) await new Promise((resolve) => { releaseSlow = resolve; });
            return route.fulfill({ json: ledgerFixture(id) });
          }
          if (/^\/api\/products\/\d+\/image$/.test(url.pathname)) return route.fulfill({
            contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#607d8b"/></svg>'
          });
          return route.fulfill({ json: {} });
        }
        if (url.pathname === "/admin.html") return route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>' });
        const asset = url.pathname === "/style.css" ? path.join("assets", (await fs.readdir(path.join(outputDir, "assets"))).find((name) => name.endsWith(".css"))) : url.pathname.slice(1);
        return route.fulfill({ contentType: asset.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(path.join(outputDir, asset)) });
      });
      await page.goto("http://localhost:8788/admin.html#/orders");
      await page.addStyleTag({ content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }" });
      const identity = page.locator(".inventory-identity").first();
      await identity.getByText("汽车装饰套装", { exact: true }).waitFor();
      await identity.getByText("虚拟库存 ID：2-10", { exact: true }).waitFor();
      await identity.getByText("本单 2 套", { exact: true }).waitFor();
      const orderRow = identity.locator("xpath=ancestor::tr");
      for (const label of [/^库存明细/, /^修改绑定$/, /^修改库存$/]) {
        const button = orderRow.getByRole("button", { name: label });
        assert.equal(await button.locator(".el-icon").count(), 1, "the three inventory actions retain their individual icons");
        assert.ok((await button.getAttribute("class")).includes("is-link"), "inventory quick actions use the same text style");
      }
      assert.equal(await page.locator(".orders-table th").filter({ hasText: "归类 / 具体原因" }).count(), 0);
      const inventoryHeader = page.locator(".orders-table th").filter({ hasText: "库存信息" });
      assert.ok((await inventoryHeader.boundingBox()).width >= 360, "inventory column retains its widened minimum");
      assert.equal(await identity.locator(".inventory-child").count(), 2);
      const ellipsis = await identity.locator(".inventory-child-label").first().evaluate((element) => ({
        title: element.title, text: element.textContent, clipped: element.scrollWidth > element.clientWidth,
        overflow: getComputedStyle(element).overflow, ellipsis: getComputedStyle(element).textOverflow,
        nowrap: getComputedStyle(element).whiteSpace
      }));
      assert.equal(ellipsis.title, ellipsis.text);
      assert.deepEqual([ellipsis.clipped, ellipsis.overflow, ellipsis.ellipsis, ellipsis.nowrap], [true, "hidden", "ellipsis", "nowrap"]);
      assert.equal(await identity.locator(".inventory-child-quantity").first().innerText(), "× 2 件");
      assert.match(await identity.locator(".inventory-local-counts").innerText(), /可用[：\s]*待核对[\s\S]*实物[：\s]*待核对[\s\S]*FBP[：\s]*5/);
      const availabilityCalls = pageRequests.filter((request) => request.url.startsWith("/api/orders/inventory-availability?"));
      assert.equal(availabilityCalls.length, 1, "the visible list starts exactly one batch without waiting for its response");
      assert.equal(new URL(availabilityCalls[0].url, "http://localhost:8788").searchParams.get("orderIds"), "1,2,3");
      releaseAvailability();
      await page.waitForFunction(() => {
        const text = document.querySelector(".inventory-local-counts")?.textContent.replace(/\s/g, "");
        return text?.includes("可用：0") && text.includes("实物：8");
      });
      assert.match(await identity.locator(".inventory-local-counts").innerText(), /可用[：\s]*0[\s\S]*实物[：\s]*8[\s\S]*FBP[：\s]*5/);
      assert.equal(await identity.locator(".inventory-child-quantity").first().innerText(), "× 2 件", "product facts cannot replace this-order component quantities");
      const counts = await identity.locator(".inventory-local-counts > span").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
      assert.ok(Math.max(...counts) - Math.min(...counts) < 2, "local and FBP figures share one line");
      await identity.getByRole("button", { name: "展开其余 2 项", exact: true }).click();
      assert.equal(await identity.locator(".inventory-child").count(), 4);
      await identity.getByText("本单数量待核", { exact: true }).waitFor();
      await identity.getByRole("button", { name: "收起子产品", exact: true }).click();
      assert.equal(await identity.locator(".inventory-child").count(), 2);
      assert.equal(pageRequests.some((request) => /\/api\/(?:procurement\/ledger|products)/.test(request.url)), false, "list does not load each inventory ledger or child image");
      await page.locator(".orders-table .el-table__body-wrapper .el-scrollbar__wrap").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await screenshot(page, viewport.width, "list");
      await orderRow.getByRole("button", { name: /^库存明细/ }).click();
      const dialog = page.getByRole("dialog", { name: "库存明细与历史核对", exact: true });
      await dialog.locator(".ledger-warehouse-summary").getByText("仓库实物总数", { exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.equal(await page.locator(".el-drawer").count(), 0);
      assert.deepEqual(pageRequests.filter((request) => request.url.startsWith("/api/procurement/ledger")).map((request) => request.url), ["/api/procurement/ledger?product_id=11"]);
      assert.equal(pageRequests.some((request) => request.url.startsWith("/api/products?")), false, "order context never searches all inventory products");
      const actions = dialog.locator(".ledger-top-actions");
      for (const label of ["更新本地库存", "库存转换", "更多操作", "刷新对账"]) await actions.getByRole("button", { name: label, exact: true }).waitFor();
      await screenshot(page, viewport.width, "dialog");
      const actionBox = await actions.boundingBox(), summaryBox = await dialog.locator(".ledger-order-summary").boundingBox();
      assert.ok(actionBox.y + actionBox.height <= summaryBox.y, "all primary actions precede the order component table");
      const closeBox = await dialog.locator(".el-dialog__headerbtn").boundingBox();
      assert.ok(actionBox.x + actionBox.width <= closeBox.x || actionBox.y >= closeBox.y + closeBox.height || actionBox.y + actionBox.height <= closeBox.y, "header actions do not overlap the close button");
      assert.ok(actionBox.y >= 0 && actionBox.y + actionBox.height < viewport.height);
      assert.equal(await dialog.locator(".inventory-local-counts").count(), 0, "parent stock figures are not repeated above warehouse totals");
      assert.equal(await dialog.locator(".ledger-product:not(.ledger-order-product)").count(), 0, "selected product identity remains in its row only");
      assert.equal(await dialog.getByText("仓库实物总数", { exact: true }).count(), 1);
      assert.equal(await dialog.getByText("剩余可用", { exact: true }).count(), 1);
      const metric = dialog.locator(".ledger-warehouse-summary .ledger-metrics > div").filter({ hasText: /^仓库实物总数/ }).locator("strong");
      assert.equal(await metric.innerText(), "12");
      assert.match(await dialog.locator(".selected-inventory-row").innerText(), new RegExp(children[0].name));
      const imageBox = await dialog.locator(".ledger-order-product .ledger-image").first().boundingBox();
      assert.deepEqual([imageBox.width, imageBox.height], [64, 84]);
      await screenshot(page, viewport.width, "dialog");
      const scrolled = await dialog.locator(".el-dialog__body").evaluate((element) => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
      if (viewport.width === 1366) assert.ok(scrolled > 0, "the narrow viewport exercises the independent body scroll");
      assert.ok(Math.abs((await actions.boundingBox()).y - actionBox.y) < 1, "body scrolling keeps top actions in place");
      await screenshot(page, viewport.width, "dialog-scrolled");
      await dialog.getByRole("button", { name: "查看各店铺 SKU 库存", exact: true }).click();
      await dialog.locator(".current-fbp-sku").getByText("布局验证店铺", { exact: true }).waitFor();
      await dialog.getByRole("tab", { name: "订单分配", exact: true }).click();
      await dialog.locator(".ledger-product-select").filter({ hasText: children[1].name }).click();
      await page.waitForFunction(() => document.querySelector(".ledger-warehouse-summary .ledger-metrics strong")?.textContent === "27");
      assert.match(await dialog.locator(".selected-inventory-row").innerText(), new RegExp(children[1].name));
      assert.equal(await dialog.locator(".selected-inventory-row td").last().innerText(), "0");
      if (viewport.width === 1920) {
        await dialog.locator(".ledger-product-select").filter({ hasText: children[0].name }).click();
        await page.waitForFunction(() => document.querySelector(".ledger-warehouse-summary .ledger-metrics strong")?.textContent === "12");
        delayAccessory = true;
        const slowRequest = page.waitForRequest("**/api/procurement/ledger?product_id=12");
        await dialog.locator(".ledger-product-select").filter({ hasText: children[1].name }).click();
        await slowRequest;
        await dialog.locator(".ledger-product-select").filter({ hasText: children[0].name }).click();
        await page.waitForFunction(() => document.querySelector(".ledger-warehouse-summary .ledger-metrics strong")?.textContent === "12");
        const slowResponse = page.waitForResponse("**/api/procurement/ledger?product_id=12");
        releaseSlow(); await slowResponse;
        assert.equal(await metric.innerText(), "12", "late child ledger cannot replace the current product");
        delayAccessory = false; failAccessory = true;
        await dialog.locator(".ledger-product-select").filter({ hasText: children[1].name }).click();
        await dialog.getByText("库存明细加载失败，请点击刷新对账重试", { exact: true }).waitFor();
        assert.equal(await dialog.locator(".ledger-warehouse-summary").count(), 0, "failed selection does not display previous inventory totals");
        failAccessory = false;
        await actions.getByRole("button", { name: "刷新对账", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".ledger-warehouse-summary .ledger-metrics strong")?.textContent === "27");
      }
      await dialog.locator(".el-dialog__headerbtn").click();
      await dialog.waitFor({ state: "hidden" });
      if (viewport.width === 1920) await verifyMarkNotes(page, orderRow, markUpdates, () => { failNextMark = true; });
      await page.close();
    }
    assert.ok(requests.every((request) => request.method === "GET" || (request.method === "PUT" && request.url === "/api/orders/1/mark")), "only the explicit mark save can reach the in-memory mutation fixture");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

async function verifyMarkNotes(page, row, updates, failNextMark) {
  const draft = "  等待仓库确认\n客户要求周五发货  ", note = draft.trim();
  const editor = page.locator(".el-message-box").filter({ hasText: "订单标记备注" });
  const summary = row.locator(".orders-mark-note-summary");
  const waitForSave = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/orders/1/mark" && response.request().method() === "PUT");
  async function chooseColor(label) {
    await row.locator(".orders-mark-pill").click();
    await page.locator(".orders-mark-menu-item").filter({ hasText: label }).click();
    await editor.locator("textarea").waitFor();
  }
  async function save(value) {
    await editor.locator("textarea").fill(value);
    const response = waitForSave();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await response;
    await editor.waitFor({ state: "hidden" });
  }
  await chooseColor("待跟进");
  await editor.locator("textarea").fill(draft);
  await screenshot(page, 1920, "mark-editor");
  await save(draft);
  await summary.waitFor();
  assert.deepEqual(updates.at(-1), { mark_type: "follow", note: draft }, "the composable forwards the exact multi-line note argument");
  assert.equal(await summary.getAttribute("title"), note);
  assert.equal(await summary.textContent(), note, "saved notes use the existing server trim convention");
  assert.ok((await row.locator(".orders-mark-pill").getAttribute("title")).includes(note), "hover text includes the full note");
  assert.equal(await row.locator(".orders-mark-note-icon").count(), 1);
  await screenshot(page, 1920, "mark-note");
  await summary.click();
  assert.equal(await editor.locator("textarea").inputValue(), note, "reopening pre-fills the saved multi-line note");
  await editor.locator("textarea").fill("取消这次编辑");
  const beforeCancel = updates.length;
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(updates.length, beforeCancel, "cancel does not save");
  assert.equal(await summary.textContent(), note);
  await summary.click();
  failNextMark();
  await save("失败的保存不能覆盖旧备注");
  await page.getByText("fixture mark save failed", { exact: true }).waitFor();
  assert.equal(await summary.textContent(), note, "failed save leaves the old row value intact");
  const requery = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/orders" && response.request().method() === "GET");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await requery;
  assert.equal(await summary.textContent(), note, "list query refetches saved note instead of restoring its stale cache");
  await page.reload();
  await summary.waitFor();
  assert.equal(await summary.getAttribute("title"), note, "a full page load reads the persisted API note");
  await summary.click();
  await save("");
  await summary.waitFor({ state: "hidden" });
  assert.deepEqual(updates.at(-1), { mark_type: "follow", note: "" });
  assert.equal(await row.locator(".orders-mark-dot.is-orange").count(), 1, "clearing only the note retains the color");
  await chooseColor("待跟进");
  await save(note);
  await summary.waitFor();
  await chooseColor("无标记");
  assert.equal(await editor.locator("textarea").inputValue(), note);
  await save(note);
  await page.waitForFunction(() => document.querySelector(".orders-mark-note-summary")?.closest(".orders-mark-cell")?.classList.contains("is-none"));
  assert.deepEqual(updates.at(-1), { mark_type: "", note });
  assert.equal(await row.locator(".orders-mark-dot").count(), 0, "existing semantics allow note-only marks without a color");
  assert.equal(await row.locator(".orders-mark-note-icon").count(), 1);
  await summary.click();
  await save("");
  await summary.waitFor({ state: "hidden" });
  assert.deepEqual(updates.at(-1), { mark_type: "", note: "" });
  assert.equal(await row.locator(".orders-mark-pencil-ring").count(), 1);
  assert.equal(updates.length, 6, "the only saves are the five intentional changes and one rejected attempt");
}

async function screenshot(page, width, suffix) {
  const target = process.env.ORDER_INVENTORY_LAYOUT_SCREENSHOT;
  if (!target) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const extension = path.extname(target) || ".png";
  await page.screenshot({ path: path.join(path.dirname(target), `${path.basename(target, path.extname(target))}-${width}-${suffix}${extension}`), animations: "disabled" });
}
