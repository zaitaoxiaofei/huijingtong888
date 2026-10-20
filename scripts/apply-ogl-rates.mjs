import { OGL_EFFECTIVE_FROM, OGL_RATES } from "../src/ogl-rates.js";

const apply = process.argv.includes("--apply");
const note = "OGL 陆运资费；2026-10-20 00:00 北京时间生效。Big 两档取实重与体积重较高者；另收每件货件 2%（最低 ₽15、最高 ₽200）电子服务费。";

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", effective_from: OGL_EFFECTIVE_FROM, rules: OGL_RATES }));
} else {
  const { mysqlQuery, withMysqlTransaction, closeMysqlPool } = await import("../src/mysql-pool.js");
  try {
    const result = await withMysqlTransaction(async (connection) => {
      let created = 0;
      for (const rate of OGL_RATES) {
        const name = `OGL 陆运 ${rate.serviceClass}`;
        const [existing] = await connection.execute(
          "SELECT * FROM logistics_fee_rules WHERE tenant_id IS NULL AND carrier = 'OGL' AND name = ? AND effective_from = ? FOR UPDATE",
          [name, OGL_EFFECTIVE_FROM]
        );
        if (existing.length) {
          const row = existing[0];
          if (String(row.channel) !== "economy" || Number(row.min_weight_g) !== rate.minWeightG
            || Number(row.max_weight_g) !== rate.maxWeightG || Number(row.min_price_rub) !== rate.minPriceRub
            || Number(row.max_price_rub) !== rate.maxPriceRub || Number(row.per_ticket_cny) !== rate.perTicketCny
            || Number(row.per_gram_cny) !== rate.perGramCny) throw new Error(`OGL rule differs: ${name}`);
          continue;
        }
        const [inserted] = await connection.execute(`
          INSERT INTO logistics_fee_rules
            (tenant_id, name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub,
             base_fee_cny, per_gram_cny, per_ticket_cny, enabled, filter_keywords, note, effective_from)
          VALUES (NULL, ?, 'OGL', 'economy', 'per_gram', ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)
        `, [name, rate.minWeightG, rate.maxWeightG, rate.minPriceRub, rate.maxPriceRub,
          rate.perGramCny, rate.perTicketCny, name, note, OGL_EFFECTIVE_FROM]);
        await connection.execute("UPDATE logistics_fee_rules SET version_group_id = id WHERE id = ?", [inserted.insertId]);
        created += 1;
      }
      return { created };
    });
    const rows = await mysqlQuery("SELECT name FROM logistics_fee_rules WHERE tenant_id IS NULL AND carrier = 'OGL' AND effective_from = ?", [OGL_EFFECTIVE_FROM]);
    if (rows.length !== OGL_RATES.length) throw new Error(`OGL rule count mismatch: ${rows.length}`);
    console.log(JSON.stringify({ mode: "apply", ...result, verified: rows.length }));
  } finally {
    await closeMysqlPool();
  }
}
