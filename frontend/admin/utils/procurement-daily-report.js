import { shanghaiDateTimeText } from "./shanghai-date.js";

export function purchaseStatusText(status) {
  return { purchased: "采购在途", partial_inbound: "部分入库", inbound_done: "已入库" }[status] || status;
}

export function purchaseInventoryNumber(row) {
  return String(row.inventory_number || "").trim().replace(/^(\d+)-(\d+)$/, "$1_$2") || "未编号";
}

function categoryText(row) {
  return String(row.inventory_category || "").trim() || "未分类";
}

function groupedPurchaseRows(rows) {
  return [...rows].sort((a, b) => categoryText(a).localeCompare(categoryText(b), "zh-CN")
    || purchaseInventoryNumber(a).localeCompare(purchaseInventoryNumber(b), "zh-CN", { numeric: true }));
}

function summaryMoney(cents) {
  return (cents / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function dailyPurchaseSummary(date, rows) {
  const products = new Map();
  let goods = 0;
  let shipping = 0;
  let quantity = 0;
  const unpriced = rows.filter((row) => !(Number(row.amount) > 0)).length;
  for (const row of groupedPurchaseRows(rows)) {
    const count = Number(row.quantity || 0);
    const amount = Math.round(Number(row.amount || 0) * 100);
    goods += amount;
    shipping += Math.round(Number(row.shipping_amount || 0) * 100);
    quantity += count;
    const item = products.get(row.product_id) || { name: String(row.product_name || "未命名商品").replace(/\s+/g, " ").trim(), code: purchaseInventoryNumber(row), category: categoryText(row), quantity: 0, amount: 0 };
    item.quantity += count;
    item.amount += amount;
    products.set(row.product_id, item);
  }
  const details = [];
  let category = "";
  for (const item of products.values()) {
    if (category !== item.category) {
      category = item.category;
      details.push("", `【${category}】`);
    }
    details.push(`${item.name}（${item.code}）：${item.quantity} 件，货款¥ ${summaryMoney(item.amount)} 元`);
  }
  return [
    `【每日采购清单】${date}（北京时间）`,
    `共采购 ${products.size} 种商品，${quantity} 件；货款 ¥${(goods / 100).toFixed(2)}，运费 ¥${(shipping / 100).toFixed(2)}，合计 ¥${((goods + shipping) / 100).toFixed(2)}。`,
    ...(unpriced ? [`其中 ${unpriced} 条货款为零或未填写，合计仅为已记录金额，请核对采购金额后重新导出。`] : []),
    ...details,
    "",
    rows.length ? "商品图片、逐笔采购时间及入库状态见 Excel 清单，请仓库按到货情况核对。" : "当天暂无已确认采购记录。"
  ].join("\n");
}

export async function buildDailyPurchaseWorkbook(date, rows, loadImage) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("每日采购清单");
  sheet.columns = [12, 24, 38, 12, 15, 13, 15, 24, 16, 16, 27, 32].map((width) => ({ width }));
  sheet.mergeCells("A1:L1");
  sheet.getCell("A1").value = `${date} 每日采购清单（北京时间 / 人民币）`;
  sheet.getCell("A1").font = { size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17365D" } };
  sheet.getRow(1).height = 32;
  sheet.mergeCells("A2:L2");
  sheet.getCell("A2").value = dailyPurchaseSummary(date, rows).split("\n").slice(1).filter((line) => line.startsWith("共采购") || line.startsWith("其中 ")).join("\n");
  sheet.getCell("A2").alignment = { wrapText: true, vertical: "middle" };
  sheet.getRow(2).height = 42;
  sheet.addRow(["库存图片", "库存号", "库存商品", "采购数量", "货款（元）", "运费（元）", "合计（元）", "采购时间（北京）", "采购人", "入库状态", "采购单号", "备注"]);
  sheet.getRow(3).font = { bold: true };
  sheet.getRow(3).height = 26;
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  const images = new Map();
  const pendingIds = [...new Set(rows.map((row) => row.product_id))];
  await Promise.all(Array.from({ length: Math.min(4, pendingIds.length) }, async () => {
    while (pendingIds.length) {
      const productId = pendingIds.shift();
      try { images.set(productId, await loadImage(productId)); }
      catch { images.set(productId, null); }
    }
  }));
  let missingImages = 0;
  for (const record of groupedPurchaseRows(rows)) {
    const row = sheet.addRow(["", purchaseInventoryNumber(record), record.product_name || "未命名商品",
      Number(record.quantity || 0), Number(record.amount || 0), Number(record.shipping_amount || 0),
      null, shanghaiDateTimeText(record.purchased_at, { assumeUtcWhenNaive: true }),
      record.person_name || "未记录", purchaseStatusText(record.status), record.purchase_order_no || "", record.note || ""]);
    row.height = 72;
    row.alignment = { vertical: "middle", wrapText: true };
    row.getCell(7).value = { formula: `E${row.number}+F${row.number}`, result: (Math.round(Number(record.amount || 0) * 100) + Math.round(Number(record.shipping_amount || 0) * 100)) / 100 };
    for (const col of [5, 6, 7]) row.getCell(col).numFmt = '#,##0.00';
    const image = images.get(record.product_id);
    if (image) {
      const imageId = workbook.addImage({ base64: image, extension: "png" });
      sheet.addImage(imageId, { tl: { col: 0.15, row: row.number - 1 + 0.06 }, ext: { width: 64, height: 84 }, editAs: "oneCell" });
    } else {
      row.getCell(1).value = "图片不可用";
      missingImages += 1;
    }
  }
  sheet.autoFilter = { from: "A3", to: `L${Math.max(3, sheet.rowCount)}` };
  const summary = workbook.addWorksheet("微信文字总结");
  summary.getColumn(1).width = 110;
  for (const line of dailyPurchaseSummary(date, rows).split("\n")) {
    const row = summary.addRow([line]);
    row.alignment = { vertical: "middle", wrapText: true };
    row.height = Math.max(30, Math.ceil(line.length / 50) * 22);
  }
  return { workbook, missingImages };
}
