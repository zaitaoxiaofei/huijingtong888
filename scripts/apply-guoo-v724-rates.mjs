import { mysqlExecute, withMysqlTransaction } from "../src/mysql-pool.js";

const effectiveFrom = "2026-07-23 16:00:00";
const sourceNote = "GUOO产品资费测算表【2026.7.20更新】 / GUOO realFBS资费试算表 / 2026-07-24 00:00（北京时间）生效";
const rules = [
  ["GUOO 特快 Extra Small", "express", 1, 500, 1, 1500, 0.05055, 3.37],
  ["GUOO 标准 Extra Small", "standard", 1, 500, 1, 1500, 0.0393, 3.37],
  ["GUOO 经济 Extra Small", "economy", 1, 500, 1, 1500, 0.0281, 3.37],
  ["GUOO 标准 Budget", "standard", 501, 30000, 1, 1500, 0.0281, 25.83],
  ["GUOO 经济 Budget", "economy", 501, 30000, 1, 1500, 0.0191, 25.83],
  ["GUOO 特快 Small", "express", 1, 2000, 1501, 7000, 0.0505, 17.97],
  ["GUOO 标准 Small", "standard", 1, 2000, 1501, 7000, 0.0393, 17.97],
  ["GUOO 经济 Small", "economy", 1, 2000, 1501, 7000, 0.0281, 17.97],
  ["GUOO 标准 Big", "standard", 2001, 30000, 1501, 7000, 0.0281, 40.44],
  ["GUOO 经济 Big", "economy", 2001, 30000, 1501, 7000, 0.0191, 40.44],
  ["GUOO 特快 Premium Small", "express", 1, 5000, 7001, 250000, 0.0505, 24.71],
  ["GUOO 标准 Premium Small", "standard", 1, 5000, 7001, 250000, 0.0393, 24.71],
  ["GUOO 经济 Premium Small", "economy", 1, 5000, 7001, 250000, 0.0281, 24.71],
  ["GUOO 标准 Premium Big", "standard", 5001, 30000, 7001, 250000, 0.0314, 69.64],
  ["GUOO 经济 Premium Big", "economy", 5001, 30000, 7001, 250000, 0.0258, 69.64]
];

function nearlyEqual(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= 0.00001;
}

await mysqlExecute("ALTER TABLE logistics_fee_rules MODIFY COLUMN per_gram_cny DECIMAL(18,6) NOT NULL DEFAULT 0");
await mysqlExecute(`
  UPDATE logistics_fee_rules
  SET per_gram_cny = 0.05055
  WHERE carrier = 'GUOO'
    AND name = 'GUOO 特快 Extra Small'
    AND effective_from = ?
    AND per_gram_cny = 0.0506
    AND note = ?
`, [effectiveFrom, sourceNote]);

const result = await withMysqlTransaction(async (connection) => {
  let created = 0;
  let skipped = 0;
  for (const rule of rules) {
    const [name, channel, minWeight, maxWeight, minPrice, maxPrice, perGram, perTicket] = rule;
    const [existingRows] = await connection.execute(`
      SELECT * FROM logistics_fee_rules
      WHERE carrier = 'GUOO' AND name = ? AND effective_from = ?
      LIMIT 1 FOR UPDATE
    `, [name, effectiveFrom]);
    const existing = existingRows[0];
    if (existing) {
      const matches = String(existing.channel) === channel
        && nearlyEqual(existing.min_weight_g, minWeight)
        && nearlyEqual(existing.max_weight_g, maxWeight)
        && nearlyEqual(existing.min_price_rub, minPrice)
        && nearlyEqual(existing.max_price_rub, maxPrice)
        && nearlyEqual(existing.per_gram_cny, perGram)
        && nearlyEqual(existing.per_ticket_cny, perTicket);
      if (!matches) throw new Error(`GUOO rule already exists with different rates: ${name}`);
      skipped += 1;
      continue;
    }

    const [inserted] = await connection.execute(`
      INSERT INTO logistics_fee_rules
      (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub,
       base_fee_cny, per_gram_cny, per_ticket_cny, enabled, filter_keywords, usage_count, note,
       version_group_id, effective_from, effective_to)
      VALUES (?, 'GUOO', ?, 'per_gram', ?, ?, ?, ?, 0, ?, ?, 1, ?, 0, ?, NULL, ?, NULL)
    `, [
      name, channel, minWeight, maxWeight, minPrice, maxPrice, perGram, perTicket,
      `${name} GUOO ${channel}`, sourceNote, effectiveFrom
    ]);
    const id = Number(inserted.insertId);
    await connection.execute("UPDATE logistics_fee_rules SET version_group_id = ? WHERE id = ?", [id, id]);
    created += 1;
  }

  const [verifiedRows] = await connection.execute(`
    SELECT COUNT(*) AS rule_count
    FROM logistics_fee_rules
    WHERE carrier = 'GUOO' AND effective_from = ?
  `, [effectiveFrom]);
  return { created, skipped, rule_count: Number(verifiedRows[0]?.rule_count || 0) };
});

if (result.rule_count !== rules.length) {
  throw new Error(`GUOO rule verification failed: expected ${rules.length}, got ${result.rule_count}`);
}

console.log(JSON.stringify({ ok: true, effective_at_beijing: "2026-07-24 00:00:00", ...result }));
process.exit(0);
