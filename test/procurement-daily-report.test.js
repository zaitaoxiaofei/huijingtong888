import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { procurementDayRange, procurementDailyReport } from "../src/services/procurement-daily-report.js";
import { dailyPurchaseSummary, buildDailyPurchaseWorkbook, purchaseInventoryNumber } from "../frontend/admin/utils/procurement-daily-report.js";
import { createOperationsRoutes } from "../src/server/routes/operations.js";

const rows = [
  { id: 1, product_id: 7, product_code: "P-007", inventory_number: "2-7", inventory_category: "脚垫", product_name: "黑色脚垫", quantity: 2, amount: "20.10", shipping_amount: "1.20", purchased_at: "2026-09-15 16:00:00", status: "purchased", purchase_order_no: "CG-001" },
  { id: 2, product_id: 7, product_code: "P-007", inventory_number: "2-7", inventory_category: "脚垫", product_name: "黑色脚垫", quantity: 3, amount: "30.20", shipping_amount: "0.00", purchased_at: "2026-09-16 15:59:59", status: "inbound_done", purchase_order_no: "CG-002" }
];

test("daily purchase date uses Beijing midnight and rejects invalid calendar dates", () => {
  assert.deepEqual(procurementDayRange("2026-09-16"), ["2026-09-15 16:00:00", "2026-09-16 16:00:00"]);
  assert.deepEqual(procurementDayRange("2026-01-01"), ["2025-12-31 16:00:00", "2026-01-01 16:00:00"]);
  for (const date of ["", "2026-02-30", "2026-13-01", "2026-9-1", "2026-09-16' OR 1=1"]) {
    assert.throws(() => procurementDayRange(date), /有效的采购日期/);
  }
});

test("daily report is unpaginated and includes only purchased facts without multiplying allocations", async () => {
  const result = await procurementDailyReport({ date: "2026-09-16" }, async (sql, params) => {
    assert.deepEqual(params, procurementDayRange("2026-09-16"));
    assert.match(sql, /po.status IN \('purchased', 'partial_inbound', 'inbound_done'\)/);
    assert.match(sql, /p.inventory_number, p.inventory_category/);
    assert.match(sql, />= \?/);
    assert.match(sql, /< \?/);
    assert.doesNotMatch(sql, /JOIN (inbound_records|procurement_requests)|LIMIT/);
    return rows;
  });
  assert.deepEqual(result, { date: "2026-09-16", rows });
  const routes = createOperationsRoutes({ services: { procurementDailyReport: (query) => query } });
  assert.deepEqual(routes["GET /api/procurement/daily-report"]({}, new URL("http://localhost/api/procurement/daily-report?date=2026-09-16")), { date: "2026-09-16" });
});

test("WeChat summary combines repeated products and separates freight from goods", () => {
  const summary = dailyPurchaseSummary("2026-09-16", rows);
  assert.match(summary, /1 种商品，5 件；货款 ¥50.30，运费 ¥1.20，合计 ¥51.50/);
  assert.match(summary, /黑色脚垫（2_7）：5 件，货款¥ 50.3 元/);
  assert.match(dailyPurchaseSummary("2026-09-16", []), /当天暂无已确认采购记录/);
  assert.match(dailyPurchaseSummary("2026-09-16", [{ ...rows[0], amount: 0 }]), /1 条货款为零或未填写/);
});

test("xlsx round trip retains embedded image, all rows, numeric amounts, Beijing times and summary", async () => {
  let loads = 0;
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const { workbook, missingImages } = await buildDailyPurchaseWorkbook("2026-09-16", rows, async () => { loads += 1; return png; });
  assert.equal(loads, 1);
  assert.equal(missingImages, 0);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.getWorksheet("每日采购清单");
  assert.equal(sheet.rowCount, 5);
  assert.equal(sheet.getCell("B3").value, "库存号");
  assert.equal(sheet.getCell("B4").value, "2_7");
  assert.equal(sheet.getImages().length, 2);
  assert.equal(sheet.getCell("D4").value, 2);
  assert.equal(sheet.getCell("E4").value, 20.1);
  assert.equal(sheet.getCell("G4").value.result, 21.3);
  assert.match(sheet.getCell("H4").value, /2026\/09\/16 00:00:00/);
  assert.match(sheet.getCell("H5").value, /2026\/09\/16 23:59:59/);
  assert.equal(sheet.getCell("J5").value, "已入库");
  assert.match(restored.getWorksheet("微信文字总结").getCell("A2").value, /¥51.50/);
});

test("failed images remain explicit without losing purchase rows or treating product names as formulas", async () => {
  const { workbook, missingImages } = await buildDailyPurchaseWorkbook("2026-09-16", [{ ...rows[0], product_name: '=HYPERLINK("bad")' }], async () => { throw new Error("image unavailable"); });
  assert.equal(missingImages, 1);
  const sheet = workbook.getWorksheet("每日采购清单");
  assert.equal(sheet.getCell("A4").value, "图片不可用");
  assert.equal(sheet.getCell("C4").type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("E4").value, 20.1);
});

test("summary and Excel group categories, sort inventory numbers naturally, and never reuse legacy codes", async () => {
  const mixed = [
    { ...rows[0], product_id: 10, inventory_category: "钥匙壳", inventory_number: "1-10", product_name: "钥匙壳 JELAND J6 红色" },
    rows[0],
    { ...rows[0], product_id: 1, inventory_category: "钥匙壳", inventory_number: "1_1", product_name: "钥匙壳 JELAND J6 蓝色", quantity: 100, amount: 250 },
    { ...rows[0], product_id: 2, inventory_category: "钥匙壳", inventory_number: "1-2", product_name: "钥匙壳 JELAND J6 黑色" },
    rows[1]
  ];
  const text = dailyPurchaseSummary("2026-09-16", mixed);
  assert.match(text, /【钥匙壳】\n钥匙壳 JELAND J6 蓝色（1_1）：100 件，货款¥ 250 元\n钥匙壳 JELAND J6 黑色（1_2）/);
  assert.ok(text.indexOf("（1_2）") < text.indexOf("（1_10）"));
  assert.equal(text.split("【脚垫】").length, 2);
  assert.doesNotMatch(text, /P-007/);
  assert.equal(purchaseInventoryNumber({ product_code: "P-007" }), "未编号");
  const { workbook } = await buildDailyPurchaseWorkbook("2026-09-16", mixed, async () => null);
  const sheet = workbook.getWorksheet("每日采购清单");
  const numbers = sheet.getColumn(2).values.slice(4);
  const first = numbers.indexOf("1_1");
  assert.deepEqual(numbers.slice(first, first + 3), ["1_1", "1_2", "1_10"]);
  assert.equal(numbers.filter((number) => number === "2_7").length, 2);
  assert.equal(sheet.getCell("B3").value, "库存号");
});
