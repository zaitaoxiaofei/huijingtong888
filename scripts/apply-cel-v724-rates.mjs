import { withMysqlTransaction } from "../src/mysql-pool.js";

const effectiveFrom = "2026-07-23 16:00:00";
const ratesByName = {
  "CEL 陆空标准 Extra Small": [0.0364, 3.12, 0.0393, 3.37],
  "CEL 陆运经济 Extra Small": [0.026, 3.12, 0.0281, 3.37],
  "CEL 陆空特快 Extra Small": [0.0468, 3.12, 0.0505, 3.37],
  "CEL 陆空特快 Budget": [0.03432, 23.92, 0.0371, 25.83],
  "CEL 陆空标准 Budget": [0.026, 23.92, 0.0281, 25.83],
  "CEL 陆运经济 Budget": [0.0177, 23.92, 0.0191, 25.83],
  "CEL 陆空特快 Small": [0.0468, 16.64, 0.0505, 17.97],
  "CEL 陆空标准 Small": [0.0364, 16.64, 0.0393, 17.97],
  "CEL 陆运经济 Small": [0.026, 16.64, 0.0281, 17.97],
  "CEL 陆空标准 Big": [0.026, 37.44, 0.0281, 40.44],
  "CEL 陆运经济 Big": [0.01768, 37.44, 0.0191, 40.44],
  "CEL 陆空特快 Premium Small": [0.0468, 22.88, 0.0505, 24.71],
  "CEL 陆空标准 Premium Small": [0.0364, 22.88, 0.0393, 24.71],
  "CEL 陆运经济 Premium Small": [0.026, 22.88, 0.0281, 24.71],
  "CEL 陆空标准 Premium Big": [0.02912, 64.48, 0.0314, 69.64],
  "CEL 陆运经济 Premium Big": [0.02392, 64.48, 0.0258, 69.64]
};

const result = await withMysqlTransaction(async (connection) => {
  const [rows] = await connection.execute("SELECT * FROM logistics_fee_rules WHERE carrier = 'CEL' AND effective_to IS NULL FOR UPDATE");
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const rates = ratesByName[String(row.name || "")];
    if (!rates) {
      skipped += 1;
      continue;
    }
    const [oldPerGram, oldPerTicket, newPerGram, newPerTicket] = rates;
    if (Math.abs(Number(row.per_gram_cny || 0) - oldPerGram) > 0.00001 || Math.abs(Number(row.per_ticket_cny || 0) - oldPerTicket) > 0.00001) {
      skipped += 1;
      continue;
    }
    const groupId = Number(row.version_group_id || row.id);
    const [existing] = await connection.execute("SELECT id FROM logistics_fee_rules WHERE version_group_id = ? AND effective_from = ? LIMIT 1", [groupId, effectiveFrom]);
    if (existing.length) {
      skipped += 1;
      continue;
    }
    await connection.execute("UPDATE logistics_fee_rules SET effective_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [effectiveFrom, Number(row.id)]);
    await connection.execute(`
      INSERT INTO logistics_fee_rules
      (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub,
       base_fee_cny, per_gram_cny, per_ticket_cny, enabled, filter_keywords, usage_count, note,
       version_group_id, effective_from, effective_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)
    `, [
      row.name, row.carrier, row.channel, row.mode, row.min_weight_g, row.max_weight_g,
      row.min_price_rub, row.max_price_rub, row.base_fee_cny, newPerGram, newPerTicket,
      row.enabled, row.filter_keywords || "", row.note || "", groupId, effectiveFrom
    ]);
    created += 1;
  }
  const [verifiedRows] = await connection.execute(`
    SELECT COUNT(DISTINCT old_rule.version_group_id) AS verified_groups
    FROM logistics_fee_rules old_rule
    JOIN logistics_fee_rules new_rule ON new_rule.version_group_id = old_rule.version_group_id
    WHERE old_rule.effective_to = ? AND new_rule.effective_from = ?
  `, [effectiveFrom, effectiveFrom]);
  return { created, skipped, verified_groups: Number(verifiedRows[0]?.verified_groups || 0) };
});

console.log(JSON.stringify({ ok: true, effective_at_beijing: "2026-07-24 00:00:00", ...result }));
process.exit(0);
