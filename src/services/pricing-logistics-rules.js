import { mysqlQuery } from "../mysql-pool.js";

// Platform tariffs use the canonical default scope. Historical customer-owned
// rules stay private; expose only reference prices needed by calculators.
export async function sharedPricingLogisticsRules() {
  return mysqlQuery(`
    SELECT id, name, carrier, channel, mode, min_weight_g, max_weight_g,
      min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny,
      enabled, version_group_id, effective_from, effective_to
    FROM logistics_fee_rules
    WHERE (tenant_id IS NULL OR tenant_id = (SELECT id FROM tenants WHERE slug = 'default' LIMIT 1))
      AND carrier IN ('GUOO', 'CEL', 'OGL') AND enabled != 0
    ORDER BY carrier, channel, version_group_id, effective_from DESC, id DESC
  `);
}
