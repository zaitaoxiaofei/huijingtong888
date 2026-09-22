import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const marker = "[fbp-auto-receipt-repair-20260916]";

export function planRepair(transfers, movements, orders) {
  const repairs = [];
  const review = [];
  for (const row of transfers) {
    if (String(row.note || "").includes(marker)) continue;
    const match = /^fbp_replenishment:(\d+):(\d+)$/.exec(row.source_ref || "");
    const order = match && orders.find((item) => Number(item.id) === Number(match[1]));
    const quantities = [...String(row.note || "").matchAll(/确认入仓 (\d+) 件：库存同步自动确认/g)].map((item) => Number(item[1]));
    const quantity = quantities.reduce((sum, value) => sum + value, 0);
    if (!quantity) continue;
    if (!order || !["approved", "sent", "ozon_created"].includes(order.status)) {
      review.push({ id: row.id, sku: row.ozon_sku, quantity, reason: order ? `原单状态 ${order.status}，需核实实际签收` : "无法关联原备货单，需核实实际签收" });
      continue;
    }
    const receipts = movements.filter((item) => String(item.source_ref || "").startsWith(`fbp_transfer:${row.id}:received:`));
    // Only reverse fully traceable automatic receipts; mixed/manual history needs review.
    const actual = receipts.map((item) => Number(item.quantity_delta)).sort((a, b) => a - b);
    const expected = [...quantities].sort((a, b) => a - b);
    assert.deepEqual(actual, expected, `Transfer ${row.id}: receipt evidence differs`);
    assert.equal(Number(row.listed_quantity), quantity, `Transfer ${row.id}: mixed or altered receipt history`);
    assert.ok(["listed", "received"].includes(row.status));
    assert.ok(quantity <= Number(row.quantity));
    for (const receipt of receipts) {
      assert.equal(receipt.status, "posted");
      assert.equal(receipt.stock_location, "FBP");
      assert.equal(receipt.source_type, "fbp_transfer_received");
      assert.equal(receipt.movement_type, "MANUAL_ADJUST");
      assert.equal(Number(receipt.product_id), Number(row.product_id));
      assert.equal(Number(receipt.shop_id), Number(row.shop_id));
    }
    repairs.push({ id: row.id, product_id: row.product_id, sku: row.ozon_sku, order_id: order.id, quantity, movement_ids: receipts.map((item) => item.id) });
  }
  return { repairs, review, restored_quantity: repairs.reduce((sum, row) => sum + row.quantity, 0) };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const backup = process.argv.find((arg) => arg.startsWith("--backup="))?.slice(9);
  assert.ok(backup, "Provide --backup=<new JSON path>");
  const { getMysqlPool } = await import("../src/mysql-pool.js");
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.query("SELECT * FROM fbp_replenishment_orders ORDER BY id FOR UPDATE");
    const [transfers] = await connection.query("SELECT * FROM fbp_transfer_records WHERE note LIKE '%库存同步自动确认%' ORDER BY id FOR UPDATE");
    const [movements] = await connection.query("SELECT * FROM inventory_movements WHERE source_type = 'fbp_transfer_received' ORDER BY id FOR UPDATE");
    const plan = planRepair(transfers, movements, orders);
    const productIds = [...new Set(plan.repairs.map((row) => Number(row.product_id)))];
    const current = [];
    for (const id of productIds) {
      const [rows] = await connection.query("SELECT * FROM inventory_current WHERE real_product_id = ? FOR UPDATE", [id]);
      assert.equal(rows.length, 1, `Product ${id}: inventory summary missing`);
      current.push(rows[0]);
    }
    await fs.writeFile(backup, JSON.stringify({ captured_at: new Date().toISOString(), apply, plan, orders, transfers, movements, current }, null, 2), { flag: "wx", mode: 0o600 });
    if (apply) {
      for (const row of plan.repairs) {
        for (const id of row.movement_ids) {
          const [result] = await connection.execute("UPDATE inventory_movements SET status = 'void', note = CONCAT(COALESCE(note, ''), ?) WHERE id = ? AND status = 'posted'", [`\n${marker} 撤销库存涨幅推断入仓，恢复待核实在途`, id]);
          assert.equal(result.affectedRows, 1);
        }
        const [result] = await connection.execute("UPDATE fbp_transfer_records SET listed_quantity = 0, status = 'sent', closed_at = NULL, note = CONCAT(COALESCE(note, ''), ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND listed_quantity = ?", [`\n${marker} 撤销自动入仓 ${row.quantity} 件；恢复待核实在途，按实际签收重新确认`, row.id, row.quantity]);
        assert.equal(result.affectedRows, 1);
        await connection.execute("UPDATE inventory_current SET available_stock = available_stock - ?, last_updated_at = CURRENT_TIMESTAMP WHERE real_product_id = ?", [row.quantity, row.product_id]);
      }
      await connection.commit();
    } else {
      await connection.rollback();
    }
    console.log(JSON.stringify({ applied: apply, backup, ...plan }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
