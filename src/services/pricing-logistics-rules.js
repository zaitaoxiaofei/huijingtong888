import { mysqlQuery } from "../mysql-pool.js";

// Legacy GUOO/CEL tariff rows are shared reference prices. Keep tenant-owned
// logistics rules private; calculators may only read these unattributed rows.
export async function sharedPricingLogisticsRules() {
  return mysqlQuery(`
    SELECT id, name, carrier, channel, mode, min_weight_g, max_weight_g,
      min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny,
      enabled, version_group_id, effective_from, effective_to, note
    FROM logistics_fee_rules
    WHERE tenant_id IS NULL AND carrier IN ('GUOO', 'CEL') AND enabled != 0
    ORDER BY carrier, channel, version_group_id, effective_from DESC, id DESC
  `);
}
