import { initDb, db } from "../src/db.js";
import { all } from "../src/services.js";

initDb();

const demoPostings = all(`
  SELECT posting_number
  FROM orders
  WHERE posting_number LIKE 'DEMO-%'
     OR shop_id IN (SELECT id FROM shops WHERE api_key_hint LIKE 'demo%')
`).map((row) => row.posting_number);

const before = all("SELECT COUNT(*) AS count FROM orders")[0].count;

if (demoPostings.length) {
  const placeholders = demoPostings.map(() => "?").join(",");
  db.prepare(`DELETE FROM outbound_records WHERE order_ref IN (${placeholders})`).run(...demoPostings);
  db.prepare(`
    DELETE FROM inventory_movements
    WHERE source_ref IN (${placeholders})
       OR related_posting_number IN (${placeholders})
  `).run(...demoPostings, ...demoPostings);
  db.prepare(`DELETE FROM order_exceptions WHERE posting_number IN (${placeholders})`).run(...demoPostings);
}

db.exec(`
  DELETE FROM ozon_orders_raw
  WHERE posting_number LIKE 'DEMO-%'
     OR store_id IN (SELECT id FROM shops WHERE api_key_hint LIKE 'demo%');

  DELETE FROM orders
  WHERE posting_number LIKE 'DEMO-%'
     OR shop_id IN (SELECT id FROM shops WHERE api_key_hint LIKE 'demo%');
`);

const after = all("SELECT COUNT(*) AS count FROM orders")[0].count;
const rows = all(`
  SELECT s.name AS shop, o.status, o.tracking_stage, COUNT(*) AS count
  FROM orders o
  JOIN shops s ON s.id = o.shop_id
  GROUP BY s.name, o.status, o.tracking_stage
  ORDER BY count DESC
`);

console.log(JSON.stringify({ deleted: before - after, remaining: after, rows }, null, 2));
