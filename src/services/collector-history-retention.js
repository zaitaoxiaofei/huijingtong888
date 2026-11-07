import { mysqlExecute, mysqlQuery } from '../mysql-pool.js';

export const COLLECTOR_RETENTION_DAYS = 30;
// Only disposable collector records. Templates/drafts/publish/OSS are not children
// of these rows and are deliberately outside this deletion boundary.
const tables = [
  { name: 'ozon_plugin_collected_products', where: 'collect_date < ? AND updated_at < ? AND (edited_at IS NULL OR edited_at < ?)', params: (date, instant) => [date, instant, instant], bytes: 'OCTET_LENGTH(payload_json) + COALESCE(OCTET_LENGTH(edit_payload_json),0)' },
  { name: 'listing_collected_product_details', where: 'created_at < ? AND updated_at < ?', params: (_, instant) => [instant, instant], bytes: 'OCTET_LENGTH(payload_json)' }
];

export async function cleanupCollectorHistory({ apply = false, batchSize = 500, maxBatches = 20, now = new Date() } = {}, { query = mysqlQuery, execute = mysqlExecute } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000 || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new Error('Invalid collector retention batch bounds');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid collector retention date');
  const cutoff = new Date(date.getTime() - COLLECTOR_RETENTION_DAYS * 86400000);
  const instant = cutoff.toISOString().slice(0,19).replace('T',' ');
  const localDate = new Date(cutoff.getTime()+8*3600000).toISOString().slice(0,10);
  const result = { apply, retentionDays: COLLECTOR_RETENTION_DAYS, cutoff: cutoff.toISOString(), tables: [] };
  for (const table of tables) {
    const exists = await query('SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?', [table.name]);
    if (!exists.length) continue;
    const params = table.params(localDate, instant);
    const [counts] = await query(`SELECT COUNT(*) AS eligible, COALESCE(SUM(${table.bytes}),0) AS payloadBytes FROM ${table.name} WHERE ${table.where}`, params);
    let deleted = 0;
    if (apply) for (let batch = 0; batch < maxBatches; batch++) {
      // Recheck the age in the DELETE so a concurrently re-collected/edited row
      // is retained. LIMIT bounds each transaction and total work per sweep.
      const done = await execute(`DELETE FROM ${table.name} WHERE ${table.where} LIMIT ${batchSize}`, params);
      const affected = Number(done.affectedRows || 0); deleted += affected;
      if (affected < batchSize) break;
    }
    result.tables.push({ table: table.name, eligible: Number(counts.eligible), payloadBytes: Number(counts.payloadBytes), deleted });
  }
  return result;
}
