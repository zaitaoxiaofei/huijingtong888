import { mysqlQuery } from "../mysql-pool.js";

const PLATFORM_TARIFF_SCOPE_SQL = "(tenant_id IS NULL OR tenant_id = (SELECT id FROM tenants WHERE slug = 'default' LIMIT 1))";
const TARIFF_COLUMNS_SQL = `id, name, carrier, channel, mode, min_weight_g, max_weight_g,
      min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny,
      enabled, version_group_id, effective_from, effective_to`;

// Existing inventory and selection consumers filter enabled/current versions
// themselves and need every carrier, but never management or usage fields.
export async function businessLogisticsRules() {
  return mysqlQuery(`
    SELECT ${TARIFF_COLUMNS_SQL}, filter_keywords
    FROM logistics_fee_rules
    WHERE ${PLATFORM_TARIFF_SCOPE_SQL}
    ORDER BY enabled DESC, version_group_id, effective_from DESC, id
  `);
}

// Platform tariffs use the canonical default scope. Historical customer-owned
// rules stay private; expose only reference prices needed by calculators.
export async function sharedPricingLogisticsRules() {
  return mysqlQuery(`
    SELECT ${TARIFF_COLUMNS_SQL}
    FROM logistics_fee_rules
    WHERE ${PLATFORM_TARIFF_SCOPE_SQL}
      AND carrier IN ('GUOO', 'CEL', 'OGL') AND enabled != 0
    ORDER BY carrier, channel, version_group_id, effective_from DESC, id DESC
  `);
}
