export const AI_VEHICLE_CATALOG_SCHEMA = `
    CREATE TABLE IF NOT EXISTS ai_vehicle_catalog (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      brand_key VARCHAR(128) NOT NULL,
      brand_name VARCHAR(128) NOT NULL,
      model_key VARCHAR(191) NOT NULL,
      model_name VARCHAR(191) NOT NULL DEFAULT '',
      tags_json JSON NULL,
      aliases_json JSON NULL,
      supply_anchor VARCHAR(500) NOT NULL DEFAULT '',
      search_keywords_json JSON NULL,
      recommended_products_json JSON NULL,
      ozon_competition VARCHAR(128) NOT NULL DEFAULT '',
      user_priority VARCHAR(128) NOT NULL DEFAULT '',
      vehicle_reference_image_url VARCHAR(2000) NOT NULL DEFAULT '',
      source VARCHAR(32) NOT NULL DEFAULT 'builtin',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_vehicle_catalog_tenant_brand_model (tenant_id, brand_key, model_key),
      KEY idx_ai_vehicle_catalog_brand (brand_name),
      KEY idx_ai_vehicle_catalog_source (source, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

// Both startup and the explicit administrator migration use the same locked upgrade.
export async function migrateAiVehicleCatalogSchema(connection, { apply = false } = {}) {
  let locked = false;
  try {
    if (apply) {
      const [[lock]] = await connection.query("SELECT GET_LOCK(CONCAT('vehicle_tenant_', LEFT(SHA2(DATABASE(),256),32)),10) acquired");
      if (Number(lock.acquired) !== 1) throw new Error('Vehicle catalog ownership migration lock unavailable');
      locked = true;
    }
    const [tables] = await connection.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_vehicle_catalog'");
    const [columns] = tables.length ? await connection.query('SHOW COLUMNS FROM ai_vehicle_catalog') : [[]];
    const [indexes] = tables.length ? await connection.query('SHOW INDEX FROM ai_vehicle_catalog') : [[]];
    const tenant = columns.find(row => row.Field === 'tenant_id');
    if (tenant && tenant.Type !== 'varchar(64)') throw new Error('Vehicle catalog tenant_id must be VARCHAR(64)');
    const keyColumns = name => indexes.filter(row => row.Key_name === name).sort((a,b) => a.Seq_in_index-b.Seq_in_index).map(row => row.Column_name).join(',');
    const oldKey = keyColumns('uniq_ai_vehicle_catalog_brand_model');
    const newKey = keyColumns('uniq_ai_vehicle_catalog_tenant_brand_model');
    if (oldKey && oldKey !== 'brand_key,model_key') throw new Error('Conflicting legacy vehicle catalog unique key');
    if (newKey && newKey !== 'tenant_id,brand_key,model_key') throw new Error('Conflicting vehicle catalog tenant unique key');
    if (apply) {
      if (!tables.length) await connection.query(AI_VEHICLE_CATALOG_SCHEMA);
      else {
        if (tenant) await connection.query("UPDATE ai_vehicle_catalog SET tenant_id='admin', updated_at=updated_at WHERE tenant_id IS NULL OR tenant_id=''");
        const alters = [];
        if (!tenant) alters.push("ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin' AFTER id");
        else if (tenant.Null !== 'NO' || tenant.Default !== 'admin') alters.push("MODIFY COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin'");
        if (oldKey) alters.push('DROP INDEX uniq_ai_vehicle_catalog_brand_model');
        if (!newKey) alters.push('ADD UNIQUE KEY uniq_ai_vehicle_catalog_tenant_brand_model (tenant_id,brand_key,model_key)');
        if (alters.length) await connection.query(`ALTER TABLE ai_vehicle_catalog ${alters.join(', ')}`);
        await connection.query("UPDATE ai_vehicle_catalog SET tenant_id='builtin', updated_at=updated_at WHERE tenant_id='admin' AND source='builtin'");
      }
      const [verified] = await connection.query("SHOW COLUMNS FROM ai_vehicle_catalog LIKE 'tenant_id'");
      const [keys] = await connection.query('SHOW INDEX FROM ai_vehicle_catalog');
      const unique = keys.filter(row => row.Key_name === 'uniq_ai_vehicle_catalog_tenant_brand_model').sort((a,b) => a.Seq_in_index-b.Seq_in_index);
      if (verified[0]?.Type !== 'varchar(64)' || verified[0]?.Null !== 'NO' || unique.some(row => Number(row.Non_unique) !== 0) || unique.map(row => row.Column_name).join(',') !== 'tenant_id,brand_key,model_key' || keys.some(row => row.Key_name === 'uniq_ai_vehicle_catalog_brand_model')) {
        throw new Error('Vehicle catalog ownership schema verification failed');
      }
    }
    return { ok: true, mode: apply ? 'apply' : 'dry-run', exists: Boolean(tables.length), add_tenant_column: !tenant, replace_global_unique_key: Boolean(oldKey), builtin_scope: 'builtin', legacy_private_scope: 'admin' };
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('vehicle_tenant_', LEFT(SHA2(DATABASE(),256),32)))");
  }
}
