import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildWarehouseRows } from "../frontend/admin/utils/fbp-warehouse.js";
import { inventoryDemandLines, buildFbpSummaryWorkbook } from "../frontend/admin/utils/fbp-summary-export.js";

const orders = [
  { id: 1, shop_id: 1, shop_name: "A店", order_no: "FBP-001", status: "approved", created_by_name: "张三", items: [
    { id: 1, product_id: 7, inventory_number: "1-7", product_name: "黑色钥匙壳", final_qty: 100 },
    { id: 2, product_id: 7, inventory_number: "1-7", final_qty: 20 }
  ] },
  { id: 2, shop_id: 2, shop_name: "B店", order_no: "FBP-002", status: "approved", created_by_name: "张三", items: [
    { id: 3, product_id: 7, inventory_number: "1-7", final_qty: 50, requested_by_name: "李四" }
  ] },
  { id: 3, shop_id: 2, shop_name: "B店", order_no: "FBP-003", status: "cancelled", items: [
    { id: 4, product_id: 7, inventory_number: "1-7", final_qty: 90 }
  ] }
];

test("summary keeps one inventory and aligned shop/order/owner quantities, excluding cancelled demand", () => {
  const rows = buildWarehouseRows(orders);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].final_qty, 170);
  assert.deepEqual(inventoryDemandLines(rows[0]), [
    { shop: "A店", order: "FBP-001", owner: "张三", quantity: 120 },
    { shop: "B店", order: "FBP-002", owner: "李四", quantity: 50 }
  ]);
});

test("real xlsx roundtrip retains separate columns, image, numeric totals and Beijing export time", async () => {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  let calls = 0;
  const { workbook, missingImages } = await buildFbpSummaryWorkbook(buildWarehouseRows(orders), async (id) => { assert.equal(id, 7); calls++; return image; }, new Date("2026-09-24T05:00:00Z"));
  assert.equal(calls, 1);
  assert.equal(missingImages, 0);
  const buffer = await workbook.xlsx.writeBuffer();
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer);
  const sheet = reopened.getWorksheet("库存备货汇总");
  assert.equal(sheet.getCell("B4").value, "1-7");
  assert.equal(sheet.getCell("D4").value, 170);
  assert.match(sheet.getCell("A2").value, /2026\/09\/24 13:00:00/);
  assert.equal(sheet.getCell("E4").value, "1. A店：120 件\n2. B店：50 件");
  assert.equal(sheet.getCell("F4").value, "1. FBP-001\n2. FBP-002");
  assert.equal(sheet.getCell("G4").value, "1. 张三\n2. 李四");
  assert.equal(sheet.getImages().length, 1);
  assert.equal(sheet.views[0].ySplit, 3);
  assert.ok(sheet.getColumn(3).width >= 38);
  assert.ok(sheet.getRow(4).height >= 72);
});

test("unavailable images do not discard quantities or masquerade as successful images", async () => {
  const { workbook, missingImages } = await buildFbpSummaryWorkbook(buildWarehouseRows(orders), async () => { throw Error("unavailable"); });
  assert.equal(missingImages, 1);
  assert.equal(workbook.worksheets[0].getCell("A4").value, "图片不可用");
  assert.equal(workbook.worksheets[0].getCell("D4").value, 170);
});
