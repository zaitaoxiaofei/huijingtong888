import { performance } from "node:perf_hooks";

import { closeMysqlPool } from "../src/mysql-pool.js";
import {
  mappingsMysql,
  onlineProductsMysql,
  outboundRecordsMysql,
  productsMysql,
  procurementRequestsMysql,
  purchaseOrdersMysql,
  selectionProductsMysql,
  stockAlertsMysql
} from "../src/services/mysql-cutover.js";

const checks = [
  ["orders page dependency: products", () => productsMysql({ paged: "1", page: 1, pageSize: 30 })],
  ["selection products", () => selectionProductsMysql({ paged: "1", page: 1, pageSize: 30 })],
  ["online products", () => onlineProductsMysql({ paged: "1", page: 1, pageSize: 30 })],
  ["stock alerts", () => stockAlertsMysql({ paged: "1", page: 1, pageSize: 30 })],
  ["stock fbp", () => stockAlertsMysql({ mode: "fbp", paged: "1", page: 1, pageSize: 30 })],
  ["inventory mappings", () => mappingsMysql({ paged: "1", page: 1, pageSize: 30 })],
  ["procurement requests", () => procurementRequestsMysql({ paged: "1", page: 1, pageSize: 20 })],
  ["outbound records", () => outboundRecordsMysql({ paged: "1", page: 1, pageSize: 30 })],
  ["purchase orders", () => purchaseOrdersMysql({ paged: "1", page: 1, pageSize: 30 })]
];

try {
  const results = [];
  for (const [label, run] of checks) {
    const startedAt = performance.now();
    const payload = await run();
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
    results.push({
      label,
      elapsedMs,
      rows: Array.isArray(payload?.rows) ? payload.rows.length : Array.isArray(payload) ? payload.length : 0,
      total: Number(payload?.total || 0)
    });
  }
  console.table(results);
} finally {
  await closeMysqlPool();
}
