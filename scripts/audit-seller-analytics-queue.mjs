import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

try {
  const tables = await mysqlQuery(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema=DATABASE()
      AND table_name IN ('seller_analytics_collect_runs', 'seller_analytics_collect_requests')
    ORDER BY table_name
  `);
  const runs = await mysqlQuery(`
    SELECT status, COUNT(*) count
    FROM seller_analytics_collect_runs
    GROUP BY status ORDER BY status
  `);
  const requests = await mysqlQuery(`
    SELECT status, COUNT(*) count
    FROM seller_analytics_collect_requests
    GROUP BY status ORDER BY status
  `);
  console.log(JSON.stringify({ tables, runs, requests }, null, 2));
} finally {
  await closeMysqlPool();
}
