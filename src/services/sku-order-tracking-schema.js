export const SKU_ORDER_TRACKERS_SCHEMA = `CREATE TABLE IF NOT EXISTS sku_order_trackers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  owner_person_id BIGINT UNSIGNED NULL,
  decline_weeks TINYINT UNSIGNED NOT NULL DEFAULT 2,
  decline_percent DECIMAL(6,2) NOT NULL DEFAULT 20,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_notified_at DATETIME NULL,
  created_by_person_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sku_order_tracker_tenant_shop_sku (tenant_id, shop_id, ozon_sku),
  KEY idx_sku_order_tracker_owner (owner_person_id, active),
  KEY idx_sku_order_tracker_tenant_active_shop (tenant_id, active, shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export function skuOrderTrackerSchemaState(columns, indexes) {
  const tenant = columns.find(column => column.Field === 'tenant_id');
  const indexRows = name => indexes.filter(index => index.Key_name === name).sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
  const matches = (name, names, unique) => {
    const rows = indexRows(name);
    return rows.length === names.length && rows.every((row, index) => row.Column_name === names[index]
      && Number(row.Non_unique) === (unique ? 0 : 1) && row.Sub_part == null);
  };
  const state = {
    tenant_column: Boolean(tenant),
    tenant_type_valid: /^bigint(?:\(\d+\))? unsigned$/i.test(String(tenant?.Type || '')),
    tenant_not_null: tenant?.Null === 'NO',
    unique_index: matches('uk_sku_order_tracker_tenant_shop_sku', ['tenant_id', 'shop_id', 'ozon_sku'], true),
    active_index: matches('idx_sku_order_tracker_tenant_active_shop', ['tenant_id', 'active', 'shop_id'], false),
    legacy_unique_index: indexRows('uk_sku_order_tracker').length > 0,
    unexpected_unique_indexes: [...new Set(indexes.filter(index => Number(index.Non_unique) === 0).map(index => index.Key_name))].filter(name => {
      const expected = {
        PRIMARY: ['id'], uk_sku_order_tracker_tenant_shop_sku: ['tenant_id', 'shop_id', 'ozon_sku'], uk_sku_order_tracker: ['shop_id', 'ozon_sku']
      }[name];
      return !expected || !matches(name, expected, true);
    })
  };
  return { ...state, ready: state.tenant_type_valid && state.tenant_not_null && state.unique_index && state.active_index && !state.legacy_unique_index && !state.unexpected_unique_indexes.length };
}
