import { closeMysqlPool } from "../src/mysql-pool.js";
import { cleanupListingPublishHistory } from "../src/services/listing-publish-history-cleanup.js";

const result = await cleanupListingPublishHistory({
  taskRetentionDays: 7,
  recordRetentionDays: 30,
  orphanTemplateRetentionDays: 7,
  batchSize: 500
}).finally(() => closeMysqlPool());

console.log(JSON.stringify(result));
