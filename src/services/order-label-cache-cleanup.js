import { mysqlExecute } from "../mysql-pool.js";
import { orderTransportEvidenceSql } from "./order-transport-evidence.js";

export async function cleanupTransportedOrderLabelCache(options = {}) {
  const batchSize = Math.max(100, Math.min(5000, Number(options.batchSize || options.batch_size || 500) || 500));
  let deleted = 0;
  for (;;) {
    const result = await mysqlExecute(`
      DELETE FROM order_package_label_cache
      WHERE order_id IN (
        SELECT order_id FROM (
          SELECT cache.order_id
          FROM order_package_label_cache cache
          JOIN orders o ON o.id = cache.order_id
          WHERE LOWER(CONCAT_WS(' ', o.status, o.tracking_stage, o.logistics_status))
              NOT REGEXP 'awaiting_packaging|awaiting_deliver|awaiting_registration|posting_awaiting_registration|posting_registration_error|posting_registered'
            AND ${orderTransportEvidenceSql("o")}
          ORDER BY cache.order_id
          LIMIT ${batchSize}
        ) transported
      )
    `);
    const affected = Number(result?.affectedRows || 0);
    deleted += affected;
    if (affected < batchSize) break;
  }
  return { ok: true, deleted };
}
