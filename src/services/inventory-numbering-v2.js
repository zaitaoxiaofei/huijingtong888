import { VEHICLE_BRAND_CHINESE, vehicleBrandAliases } from '../shared/vehicle-brand.js';

// Preparing these structures never activates V2 or rewrites an issued number.
export const INVENTORY_NUMBERING_V2_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS inventory_number_core_categories_v2 (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    core_name VARCHAR(255) COLLATE utf8mb4_bin NOT NULL UNIQUE,
    initial_product_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_number_brands_v2 (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    brand_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL UNIQUE,
    initial_product_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_number_sequences_v2 (
    category_id BIGINT UNSIGNED NOT NULL,
    brand_id BIGINT UNSIGNED NOT NULL,
    last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (category_id, brand_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_number_aliases (
    alias_number VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    product_id BIGINT UNSIGNED NOT NULL,
    tenant_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_inventory_number_alias_product (product_id),
    KEY idx_inventory_number_alias_tenant (tenant_id, product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_numbering_state (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    version TINYINT UNSIGNED NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_inventory_numbering_state CHECK (id = 1 AND version IN (1, 2))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];

export const INVENTORY_NUMBERING_V2_PRODUCT_COLUMN_STATEMENTS = [
  'ALTER TABLE products ADD COLUMN inventory_number VARCHAR(64) NULL',
  'ALTER TABLE products ADD COLUMN inventory_number_category BIGINT UNSIGNED NULL',
  'ALTER TABLE products ADD COLUMN inventory_number_sequence BIGINT UNSIGNED NULL',
  'ALTER TABLE products ADD COLUMN inventory_number_brand BIGINT UNSIGNED NULL',
  'ALTER TABLE products ADD COLUMN inventory_number_version TINYINT UNSIGNED NOT NULL DEFAULT 1',
  'CREATE UNIQUE INDEX uk_products_inventory_number ON products (inventory_number)',
  'CREATE UNIQUE INDEX uk_products_inventory_number_v2 ON products (inventory_number_category, inventory_number_brand, inventory_number_sequence)'
];

export const INVENTORY_NUMBERING_V2_TRIGGER_NAMES = [
  'products_inventory_number_insert', 'products_inventory_number_update', 'products_inventory_number_alias_update'
];
const tableNames = INVENTORY_NUMBERING_V2_SCHEMA_STATEMENTS.map(sql => /EXISTS (\w+)/.exec(sql)[1]);
const rows = async (db, sql, params = []) => {
  const result = await (typeof db === 'function' ? db(sql, params) : db.query(sql, params));
  return Array.isArray(result?.[0]) ? result[0] : result;
};
const fail = message => Object.assign(new Error(message), { code: 'INVENTORY_NUMBERING_V2_REFUSED' });
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const bypass = "COALESCE(@inventory_numbering_v2_migration, 0) = 1 AND SUBSTRING_INDEX(USER(), '@', 1) = 'root'";

export async function inventoryNumberingVersion(db) {
  const exists = await rows(db, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_numbering_state'");
  if (!exists.length) return null;
  const result = await rows(db, 'SELECT version FROM inventory_numbering_state WHERE id = 1');
  if (!result.length) return null;
  const version = Number(result[0].version);
  if (![1, 2].includes(version)) throw fail('Unsupported inventory numbering version; legacy initialization refused');
  return version;
}

export async function inspectInventoryNumberingV2Schema(db) {
  const inspectedTables = ['products', ...tableNames];
  const existing = await rows(db, `SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${inspectedTables.map(() => '?').join(',')})`, inspectedTables);
  const tables = new Set(existing.map(row => row.TABLE_NAME));
  const columns = await rows(db, 'SHOW COLUMNS FROM products');
  const indexes = await rows(db, 'SHOW INDEX FROM products');
  const missingTables = tableNames.filter(name => !tables.has(name));
  const missingColumns = ['inventory_number', 'inventory_number_category', 'inventory_number_sequence', 'inventory_number_brand', 'inventory_number_version'].filter(name => !columns.some(row => row.Field === name));
  const expectedIndexes = {
    uk_products_inventory_number: ['inventory_number'],
    uk_products_inventory_number_v2: ['inventory_number_category', 'inventory_number_brand', 'inventory_number_sequence']
  };
  const missingIndexes = [], issues = [];
  for (const [name, expected] of Object.entries(expectedIndexes)) {
    const found = indexes.filter(row => row.Key_name === name).sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index));
    if (!found.length) missingIndexes.push(name);
    else if (found.map(row => row.Column_name).join(',') !== expected.join(',') || found.some(row => Number(row.Non_unique) !== 0 || row.Sub_part != null || row.Expression != null)) issues.push(`Incompatible product index: ${name}`);
  }
  for (const column of columns.filter(row => row.Field.startsWith('inventory_number'))) {
    if (/GENERATED|INVISIBLE/i.test(column.Extra || '')) issues.push(`Unsupported product column: ${column.Field}`);
    if (column.Field === 'inventory_number_version' && (!/^tinyint(?:\(\d+\))?(?: unsigned)?$/i.test(column.Type) || column.Null !== 'NO' || String(column.Default) !== '1')) issues.push('Incompatible inventory_number_version column');
    if (['inventory_number_category', 'inventory_number_sequence', 'inventory_number_brand'].includes(column.Field) && (!/^bigint(?:\(\d+\))? unsigned$/i.test(column.Type) || column.Null !== 'YES')) issues.push(`Incompatible product column: ${column.Field}`);
    if (column.Field === 'inventory_number' && (!/^varchar\(64\)$/i.test(column.Type) || column.Null !== 'YES')) issues.push('Incompatible inventory_number column');
  }
  for (const table of existing) if (table.ENGINE !== 'InnoDB') issues.push(`Nontransactional numbering table: ${table.TABLE_NAME}`);
  const required = {
    inventory_number_core_categories_v2: ['id', 'core_name', 'initial_product_count', 'created_at'],
    inventory_number_brands_v2: ['id', 'brand_key', 'initial_product_count', 'created_at'],
    inventory_number_sequences_v2: ['category_id', 'brand_id', 'last_sequence'],
    inventory_number_aliases: ['alias_number', 'product_id', 'tenant_id', 'created_at'],
    inventory_numbering_state: ['id', 'version', 'updated_at']
  };
  for (const table of existing.filter(table => tableNames.includes(table.TABLE_NAME))) {
    const fields = await rows(db, `SHOW FULL COLUMNS FROM ${table.TABLE_NAME}`);
    for (const name of required[table.TABLE_NAME]) if (!fields.some(row => row.Field === name)) issues.push(`Missing numbering column: ${table.TABLE_NAME}.${name}`);
    const exactKey = table.TABLE_NAME === 'inventory_number_core_categories_v2' ? 'core_name'
      : table.TABLE_NAME === 'inventory_number_brands_v2' ? 'brand_key' : table.TABLE_NAME === 'inventory_number_aliases' ? 'alias_number' : '';
    if (exactKey && fields.find(row => row.Field === exactKey)?.Collation !== 'utf8mb4_bin') issues.push(`Numbering key must preserve exact identity: ${table.TABLE_NAME}.${exactKey}`);
    if (table.TABLE_NAME === 'inventory_number_aliases') {
      const tenant = fields.find(row => row.Field === 'tenant_id');
      if (tenant?.Null !== 'NO') issues.push('Number aliases require explicit non-null enterprise ownership');
    }
    const keys = await rows(db, `SHOW INDEX FROM ${table.TABLE_NAME}`);
    const expected = table.TABLE_NAME === 'inventory_number_sequences_v2' ? ['category_id', 'brand_id']
      : table.TABLE_NAME === 'inventory_number_aliases' ? ['alias_number'] : ['id'];
    const primary = keys.filter(row => row.Key_name === 'PRIMARY').sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index));
    if (primary.map(row => row.Column_name).join(',') !== expected.join(',')) issues.push(`Incompatible numbering primary key: ${table.TABLE_NAME}`);
    const natural = table.TABLE_NAME === 'inventory_number_core_categories_v2' ? 'core_name' : table.TABLE_NAME === 'inventory_number_brands_v2' ? 'brand_key' : '';
    if (natural && ![...new Set(keys.map(row => row.Key_name))].some(name => {
      const group = keys.filter(row => row.Key_name === name);
      return group.length === 1 && group[0].Column_name === natural && Number(group[0].Non_unique) === 0 && group[0].Sub_part == null;
    })) issues.push(`Missing unique numbering key: ${table.TABLE_NAME}.${natural}`);
  }
  const version = await inventoryNumberingVersion(db);
  let reserved = false;
  if (!missingTables.length && !issues.length) {
    const core = await rows(db, "SELECT id, core_name FROM inventory_number_core_categories_v2 WHERE id = 0 OR core_name = ''");
    const brands = await rows(db, "SELECT id, brand_key FROM inventory_number_brands_v2 WHERE id IN (0, 1) OR brand_key IN ('PENDING', 'UNIVERSAL')");
    reserved = core.length === 1 && Number(core[0].id) === 0 && core[0].core_name === ''
      && brands.length === 2 && brands.some(row => Number(row.id) === 0 && row.brand_key === 'PENDING') && brands.some(row => Number(row.id) === 1 && row.brand_key === 'UNIVERSAL') && version != null;
  }
  const triggers = await rows(db, `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN (${INVENTORY_NUMBERING_V2_TRIGGER_NAMES.map(() => '?').join(',')})`, INVENTORY_NUMBERING_V2_TRIGGER_NAMES);
  const definitions = triggers.map(row => ({ name: row.TRIGGER_NAME, event: row.EVENT_MANIPULATION, timing: row.ACTION_TIMING, action: row.ACTION_STATEMENT, definer: row.DEFINER }));
  const triggersReady = INVENTORY_NUMBERING_V2_TRIGGER_NAMES.every((name, index) => definitions.some(row => row.name === name
    && row.event === (index === 0 ? 'INSERT' : 'UPDATE') && row.timing === (index === 2 ? 'AFTER' : 'BEFORE')
    && row.action.includes('inventory_numbering_v2_migration') && row.action.includes(index === 2 ? 'inventory_number_aliases' : 'inventory_number_sequences_v2')));
  const ready = !missingTables.length && !missingColumns.length && !missingIndexes.length && !issues.length && reserved;
  return { schema_ready: ready, numbering_version: version, triggers_ready: triggersReady, active: ready && version === 2 && triggersReady,
    missing_tables: missingTables, missing_product_columns: missingColumns, missing_indexes: missingIndexes, issues,
    reserved_rows_valid: reserved, trigger_definitions: definitions };
}

export async function prepareInventoryNumberingV2Schema(db) {
  const before = await inspectInventoryNumberingV2Schema(db);
  if (before.numbering_version === 2) {
    if (!before.active) throw fail('Active V2 schema or triggers are incomplete; automatic repair refused');
    return before;
  }
  if (before.issues.length) throw fail(before.issues.join('; '));
  for (const sql of INVENTORY_NUMBERING_V2_PRODUCT_COLUMN_STATEMENTS) {
    const column = /ADD COLUMN (\w+)/.exec(sql)?.[1], index = /INDEX (\w+)/.exec(sql)?.[1];
    if ((column && before.missing_product_columns.includes(column)) || (index && before.missing_indexes.includes(index))) await db.query(sql);
  }
  for (const sql of INVENTORY_NUMBERING_V2_SCHEMA_STATEMENTS) await db.query(sql);
  await db.query("INSERT IGNORE INTO inventory_number_core_categories_v2 (id, core_name) VALUES (0, '')");
  await db.query("INSERT IGNORE INTO inventory_number_brands_v2 (id, brand_key) VALUES (0, 'PENDING'), (1, 'UNIVERSAL')");
  await db.query('INSERT IGNORE INTO inventory_numbering_state (id, version) VALUES (1, 1)');
  const after = await inspectInventoryNumberingV2Schema(db);
  if (!after.schema_ready) throw fail('Prepared numbering schema failed verification');
  return after;
}

function brandNormalizationSql() {
  // Same exact aliases as the shared brand normalizer; never infer from names.
  const width = Array.from({ length: 94 }, (_, index) => [String.fromCodePoint(0xff01 + index), String.fromCodePoint(0x21 + index)]);
  const replaceWidth = width.map(([wide, ascii]) => `SET brand_text = REPLACE(brand_text, ${literal(wide)}, ${literal(ascii === '\\' ? '\\\\' : ascii)});`).join('\n      ');
  const invisible = ['E2808B', 'E2808C', 'E2808D', 'E281A0', 'EFBBBF'].map(hex => `SET brand_text = REPLACE(brand_text, CONVERT(0x${hex} USING utf8mb4), '');`).join('\n      ');
  const cases = Object.keys(VEHICLE_BRAND_CHINESE).map(brand => `WHEN brand_text IN (${vehicleBrandAliases(brand).map(value => literal(value.toUpperCase())).join(', ')}) THEN ${literal(brand)}`).join('\n        ');
  return `SET brand_text = COALESCE(NEW.vehicle_brand, '');
      ${replaceWidth}
      SET brand_text = REPLACE(brand_text, CONVERT(0xE38080 USING utf8mb4), ' ');
      ${invisible}
      SET brand_text = UPPER(TRIM(REGEXP_REPLACE(brand_text, '[[:space:]]+', ' ')));
      SET brand_text = REGEXP_REPLACE(brand_text, ' *[|] *', '|');
      SET brand_text = CASE ${cases} ELSE brand_text END;
      IF brand_text IN ('无品牌', '无品牌|', 'NO BRAND', 'NO-BRAND', 'NONE') THEN SET brand_text = ''; END IF;
      IF LEFT(brand_text, 4) = '无品牌|' THEN SET brand_text = SUBSTRING(brand_text, 5);
      ELSEIF LEFT(brand_text, 1) = '|' THEN SET brand_text = SUBSTRING(brand_text, 2); END IF;`;
}

function namespaceGuardSql() {
  return `SELECT MIN(conflicts.product_id) INTO conflict_id FROM (
        SELECT p.id AS product_id FROM products p WHERE p.id <> COALESCE(NEW.id, 0) AND (
          (NULLIF(TRIM(NEW.code), '') IS NOT NULL AND (p.code = NEW.code OR p.selection_id = NEW.code OR p.inventory_number = NEW.code))
          OR (NULLIF(TRIM(NEW.selection_id), '') IS NOT NULL AND (p.code = NEW.selection_id OR p.selection_id = NEW.selection_id OR p.inventory_number = NEW.selection_id)))
        UNION ALL
        SELECT a.product_id FROM inventory_number_aliases a WHERE a.product_id <> COALESCE(NEW.id, 0)
          AND (a.alias_number = NULLIF(TRIM(NEW.code), '') OR a.alias_number = NULLIF(TRIM(NEW.selection_id), ''))
      ) conflicts;
      IF conflict_id IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory code or selection identifier belongs to another product'; END IF;`;
}

export function inventoryNumberTriggerSqlV2(event) {
  if (!['INSERT', 'UPDATE'].includes(event)) throw fail('Number trigger event must be INSERT or UPDATE');
  const fresh = event === 'INSERT' ? 'TRUE' : 'OLD.inventory_number IS NULL AND COALESCE(OLD.inventory_number_version, 1) <> 2';
  const requireCompleteIdentity = event === 'INSERT' ? fresh : `(${fresh}) OR (OLD.inventory_number_version = 2 AND OLD.inventory_number IS NOT NULL AND OLD.inventory_number_category > 0 AND OLD.inventory_number_brand > 0)`;
  const emptyInitial = event === 'INSERT' ? "core_text = ''" : "core_text = '' AND OLD.inventory_number IS NULL AND COALESCE(OLD.inventory_number_version, 1) <> 2";
  const unchangedIdentity = event === 'UPDATE' ? `IF OLD.inventory_number_version = 2 AND OLD.inventory_number IS NOT NULL
        AND (BINARY OLD.inventory_category <=> BINARY NEW.inventory_category)
        AND (BINARY OLD.vehicle_brand <=> BINARY NEW.vehicle_brand)
        AND (BINARY OLD.fitment_type <=> BINARY NEW.fitment_type)
        AND (BINARY OLD.vehicle_model <=> BINARY NEW.vehicle_model)
        AND (BINARY OLD.vehicle_models_json <=> BINARY NEW.vehicle_models_json) THEN
        SET NEW.inventory_number = OLD.inventory_number;
        SET NEW.inventory_number_category = OLD.inventory_number_category;
        SET NEW.inventory_number_brand = OLD.inventory_number_brand;
        SET NEW.inventory_number_sequence = OLD.inventory_number_sequence;
        SET NEW.inventory_number_version = 2;
        LEAVE numbering;
      END IF;` : '';
  const retain = event === 'UPDATE' ? `IF OLD.inventory_number_version = 2 AND OLD.inventory_number IS NOT NULL
        AND OLD.inventory_number_category = category_id AND OLD.inventory_number_brand = brand_id
        AND OLD.inventory_number_sequence > 0 THEN
        SET NEW.inventory_number = OLD.inventory_number;
        SET NEW.inventory_number_category = OLD.inventory_number_category;
        SET NEW.inventory_number_brand = OLD.inventory_number_brand;
        SET NEW.inventory_number_sequence = OLD.inventory_number_sequence;
        SET NEW.inventory_number_version = 2;
        LEAVE numbering;
      END IF;` : '';
  return `CREATE TRIGGER products_inventory_number_${event.toLowerCase()}
    BEFORE ${event} ON products FOR EACH ROW
    numbering: BEGIN
      DECLARE legacy_initializer_guard VARCHAR(64) DEFAULT 'old.inventory_number_category = category_id';
      DECLARE active_version TINYINT DEFAULT NULL;
      DECLARE category_id BIGINT UNSIGNED DEFAULT NULL;
      DECLARE brand_id BIGINT UNSIGNED DEFAULT NULL;
      DECLARE sequence_no BIGINT UNSIGNED;
      DECLARE conflict_id BIGINT UNSIGNED DEFAULT NULL;
      DECLARE candidate_number VARCHAR(64);
      DECLARE core_text VARCHAR(255);
      DECLARE brand_text VARCHAR(255);
      DECLARE brand_key_text VARCHAR(128) DEFAULT 'PENDING';
      DECLARE fitment_text VARCHAR(32);
      DECLARE raw_brand_present BOOLEAN;
      DECLARE models_valid BOOLEAN;
      DECLARE has_models BOOLEAN;
      IF ${bypass} THEN LEAVE numbering; END IF;
      SELECT version INTO active_version FROM inventory_numbering_state WHERE id = 1 FOR UPDATE;
      IF COALESCE(active_version, 0) <> 2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory numbering V2 is not active; reviewed migration required'; END IF;
      ${namespaceGuardSql()}
      SET core_text = TRIM(REGEXP_REPLACE(COALESCE(NEW.inventory_category, ''), '^[[:space:]]+|[[:space:]]+$', ''));
      IF ${emptyInitial} THEN
        SET NEW.inventory_number = NULL;
        SET NEW.inventory_number_category = NULL;
        SET NEW.inventory_number_brand = NULL;
        SET NEW.inventory_number_sequence = NULL;
        SET NEW.inventory_number_version = 1;
        LEAVE numbering;
      END IF;
      ${unchangedIdentity}
      SET raw_brand_present = TRIM(COALESCE(NEW.vehicle_brand, '')) <> '';
      ${brandNormalizationSql()}
      SET fitment_text = TRIM(COALESCE(NEW.fitment_type, ''));
      SET models_valid = NEW.vehicle_models_json IS NULL OR JSON_TYPE(NEW.vehicle_models_json) = 'ARRAY';
      SET has_models = TRIM(COALESCE(NEW.vehicle_model, '')) <> '' OR (models_valid AND COALESCE(JSON_LENGTH(NEW.vehicle_models_json), 0) > 0);
      IF (fitment_text = 'specific' OR fitment_text = '')
        AND brand_text NOT IN ('', 'PENDING', 'UNIVERSAL') AND CHAR_LENGTH(brand_text) <= 128
        AND REGEXP_LIKE(brand_text, '^[A-Z0-9][A-Z0-9 &/().+''-]*$', 'c') AND REGEXP_LIKE(brand_text, '[A-Z]', 'c') THEN
        SET brand_key_text = brand_text;
      ELSEIF models_valid AND fitment_text = 'universal' AND NOT raw_brand_present AND NOT has_models THEN
        SET brand_key_text = 'UNIVERSAL';
      END IF;
      IF (${requireCompleteIdentity}) AND (core_text = '' OR fitment_text NOT IN ('specific', 'universal') OR brand_key_text = 'PENDING' OR NOT models_valid) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'New inventory identity is incomplete: confirm vehicle brand and fitment before saving';
      END IF;
      SELECT id INTO category_id FROM inventory_number_core_categories_v2 WHERE core_name = core_text FOR UPDATE;
      IF category_id IS NULL THEN
        SELECT COALESCE(MAX(id), 0) + 1 INTO category_id FROM inventory_number_core_categories_v2;
        INSERT INTO inventory_number_core_categories_v2 (id, core_name) VALUES (category_id, core_text);
      END IF;
      SELECT id INTO brand_id FROM inventory_number_brands_v2 WHERE brand_key = brand_key_text FOR UPDATE;
      IF brand_id IS NULL THEN
        SELECT COALESCE(MAX(id), 1) + 1 INTO brand_id FROM inventory_number_brands_v2;
        INSERT INTO inventory_number_brands_v2 (id, brand_key) VALUES (brand_id, brand_key_text);
      END IF;
      ${retain}
      INSERT INTO inventory_number_sequences_v2 (category_id, brand_id, last_sequence) VALUES (category_id, brand_id, 0)
        ON DUPLICATE KEY UPDATE last_sequence = last_sequence;
      allocate_number: LOOP
        UPDATE inventory_number_sequences_v2 SET last_sequence = last_sequence + 1
          WHERE inventory_number_sequences_v2.category_id = category_id AND inventory_number_sequences_v2.brand_id = brand_id;
        SELECT last_sequence INTO sequence_no FROM inventory_number_sequences_v2 s WHERE s.category_id = category_id AND s.brand_id = brand_id;
        SET candidate_number = CONCAT(category_id, '-', brand_id, '-', sequence_no);
        SELECT MIN(conflicts.product_id) INTO conflict_id FROM (
          SELECT p.id AS product_id FROM products p WHERE p.id <> COALESCE(NEW.id, 0)
            AND (p.inventory_number = candidate_number OR p.code = candidate_number OR p.selection_id = candidate_number)
          UNION ALL SELECT a.product_id FROM inventory_number_aliases a WHERE a.alias_number = candidate_number
        ) conflicts;
        IF conflict_id IS NULL THEN LEAVE allocate_number; END IF;
      END LOOP;
      SET NEW.inventory_number_category = category_id;
      SET NEW.inventory_number_brand = brand_id;
      SET NEW.inventory_number_sequence = sequence_no;
      SET NEW.inventory_number_version = 2;
      SET NEW.inventory_number = candidate_number;
    END`;
}

export function inventoryNumberAliasTriggerSqlV2() {
  return `CREATE TRIGGER products_inventory_number_alias_update AFTER UPDATE ON products FOR EACH ROW
    numbering: BEGIN
      DECLARE owner_id BIGINT UNSIGNED DEFAULT NULL;
      DECLARE owner_tenant BIGINT UNSIGNED DEFAULT NULL;
      DECLARE current_owner BIGINT UNSIGNED DEFAULT NULL;
      IF ${bypass} THEN LEAVE numbering; END IF;
      IF OLD.inventory_number IS NULL OR (BINARY OLD.inventory_number <=> BINARY NEW.inventory_number) THEN LEAVE numbering; END IF;
      SET owner_tenant = NEW.tenant_id;
      IF owner_tenant IS NULL THEN SELECT id INTO owner_tenant FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1; END IF;
      IF owner_tenant IS NULL OR owner_tenant = 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical number alias requires explicit enterprise ownership'; END IF;
      SELECT product_id INTO owner_id FROM inventory_number_aliases WHERE alias_number = OLD.inventory_number FOR UPDATE;
      SELECT id INTO current_owner FROM products WHERE inventory_number = OLD.inventory_number AND id <> NEW.id LIMIT 1;
      IF (owner_id IS NOT NULL AND owner_id <> NEW.id) OR current_owner IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical inventory number belongs to another product';
      END IF;
      INSERT INTO inventory_number_aliases (alias_number, product_id, tenant_id) VALUES (OLD.inventory_number, NEW.id, owner_tenant)
        ON DUPLICATE KEY UPDATE alias_number = alias_number;
    END`;
}

export async function installInventoryNumberingV2Triggers(db, { triggerDefiner = '' } = {}) {
  const before = await inspectInventoryNumberingV2Schema(db);
  if (!before.schema_ready) throw fail('Prepare and verify the additive V2 schema before installing triggers');
  const columns = new Set((await rows(db, 'SHOW COLUMNS FROM products')).map(row => row.Field));
  if (['id', 'tenant_id', 'code', 'selection_id', 'inventory_category', 'vehicle_brand', 'fitment_type', 'vehicle_model', 'vehicle_models_json'].some(name => !columns.has(name))) throw fail('Required product identity columns are missing; existing triggers were not changed');
  if (triggerDefiner && !/^(?:CURRENT_USER|`[^`]+`@`[^`]+`|'[^']+'@'[^']+')$/.test(triggerDefiner)) throw fail('Invalid explicit trigger definer');
  for (const name of INVENTORY_NUMBERING_V2_TRIGGER_NAMES) await db.query(`DROP TRIGGER IF EXISTS ${name}`);
  for (const sql of [inventoryNumberTriggerSqlV2('INSERT'), inventoryNumberTriggerSqlV2('UPDATE'), inventoryNumberAliasTriggerSqlV2()]) {
    await db.query(triggerDefiner ? sql.replace('CREATE TRIGGER', `CREATE DEFINER = ${triggerDefiner} TRIGGER`) : sql);
  }
  const after = await inspectInventoryNumberingV2Schema(db);
  if (!after.triggers_ready) throw fail('V2 trigger installation did not verify');
  return after;
}
