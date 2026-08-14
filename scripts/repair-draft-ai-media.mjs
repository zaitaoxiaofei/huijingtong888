import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { repairAiOptimizationListingMedia } from "../src/services/listing-automation.js";

function parseArgs(argv = []) {
  const args = new Set(argv);
  const batchArg = argv.find((item) => item.startsWith("--batch="));
  const limitArg = argv.find((item) => item.startsWith("--limit="));
  const batchSize = Math.min(Math.max(Number(batchArg?.split("=")[1] || 20), 1), 100);
  const limit = Math.min(Math.max(Number(limitArg?.split("=")[1] || 1000), 1), 5000);
  return {
    dryRun: !args.has("--write"),
    batchSize,
    limit
  };
}

async function listDraftIdsNeedingRepair({ batchSize = 20, limit = 1000 } = {}) {
  const ids = [];
  let lastId = 0;
  while (ids.length < limit) {
    const rows = await mysqlQuery(`
      SELECT id
      FROM listing_drafts
      WHERE status <> 'deleted'
        AND id > ?
        AND (
          source_images_json LIKE '%/api/ai/file/%'
          OR manual_facts_json LIKE '%/api/ai/file/%'
          OR ai_payload_json LIKE '%/api/ai/file/%'
          OR template_payload_json LIKE '%/api/ai/file/%'
          OR source_images_json LIKE '%/uploads/listing-media/%'
          OR manual_facts_json LIKE '%/uploads/listing-media/%'
          OR ai_payload_json LIKE '%/uploads/listing-media/%'
          OR template_payload_json LIKE '%/uploads/listing-media/%'
          OR source_images_json LIKE '%localhost%'
          OR manual_facts_json LIKE '%localhost%'
          OR ai_payload_json LIKE '%localhost%'
          OR template_payload_json LIKE '%localhost%'
          OR source_images_json LIKE '%127.0.0.1%'
          OR manual_facts_json LIKE '%127.0.0.1%'
          OR ai_payload_json LIKE '%127.0.0.1%'
          OR template_payload_json LIKE '%127.0.0.1%'
        )
      ORDER BY id ASC
      LIMIT ?
    `, [lastId, Math.min(batchSize, limit - ids.length)]);
    if (!rows.length) break;
    for (const row of rows) {
      const id = Number(row.id || 0);
      if (id > 0) ids.push(id);
    }
    lastId = Number(rows.at(-1)?.id || lastId);
  }
  return ids;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ids = await listDraftIdsNeedingRepair(options);
  if (!ids.length) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: options.dryRun,
      scanned: 0,
      changed: 0,
      ids: []
    }, null, 2));
    return;
  }

  const batches = [];
  for (let index = 0; index < ids.length; index += options.batchSize) {
    batches.push(ids.slice(index, index + options.batchSize));
  }

  const summary = {
    ok: true,
    dryRun: options.dryRun,
    scanned: ids.length,
    changed: 0,
    ids: [],
    batches: []
  };

  for (const batchIds of batches) {
    const result = await repairAiOptimizationListingMedia({
      ids: batchIds,
      limit: batchIds.length,
      dryRun: options.dryRun
    }, null);
    const changedIds = result?.drafts?.ids || [];
    summary.changed += changedIds.length;
    summary.ids.push(...changedIds);
    summary.batches.push({
      ids: batchIds,
      changed: changedIds
    });
    console.log(JSON.stringify({
      batch: batchIds,
      changed: changedIds,
      dryRun: options.dryRun
    }));
  }

  console.log(JSON.stringify(summary, null, 2));
}

try {
  await main();
} finally {
  await closeMysqlPool().catch(() => null);
}
