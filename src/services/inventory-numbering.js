import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";

let ready;

// A persistent counter keeps issued numbers stable even after products are retired.
export function inventoryNumberTriggerSql(event) {
  const retainOrAllocate = event === "UPDATE" ? `
        IF OLD.inventory_number IS NOT NULL
          AND OLD.inventory_number_category = category_id
          AND TRIM(COALESCE(OLD.inventory_category, '')) = TRIM(NEW.inventory_category) THEN
          SET NEW.inventory_number = OLD.inventory_number;
          SET NEW.inventory_number_category = OLD.inventory_number_category;
          SET NEW.inventory_number_sequence = OLD.inventory_number_sequence;
        ELSE
          UPDATE inventory_number_categories SET last_sequence = last_sequence + 1 WHERE id = category_id;
          SELECT last_sequence INTO sequence_no FROM inventory_number_categories WHERE id = category_id;
          SET NEW.inventory_number_category = category_id;
          SET NEW.inventory_number_sequence = sequence_no;
          SET NEW.inventory_number = CONCAT(category_id, '-', sequence_no);
        END IF;` : `
        UPDATE inventory_number_categories SET last_sequence = last_sequence + 1 WHERE id = category_id;
        SELECT last_sequence INTO sequence_no FROM inventory_number_categories WHERE id = category_id;
        SET NEW.inventory_number_category = category_id;
        SET NEW.inventory_number_sequence = sequence_no;
        SET NEW.inventory_number = CONCAT(category_id, '-', sequence_no);`;
  return `CREATE TRIGGER products_inventory_number_${event.toLowerCase()}
    BEFORE ${event} ON products FOR EACH ROW
    BEGIN
      DECLARE category_id BIGINT UNSIGNED DEFAULT NULL;
      DECLARE sequence_no BIGINT UNSIGNED;
      IF TRIM(COALESCE(NEW.inventory_category, '')) <> '' THEN
        -- Lock the registry before allocating either a category or its sequence.
        UPDATE inventory_number_categories SET last_sequence = last_sequence WHERE id = 0;
        SELECT id INTO category_id FROM inventory_number_categories
          WHERE core_name = TRIM(NEW.inventory_category) FOR UPDATE;
        IF category_id IS NULL THEN
          SELECT MAX(id) + 1 INTO category_id FROM inventory_number_categories;
          INSERT INTO inventory_number_categories (id, core_name) VALUES (category_id, TRIM(NEW.inventory_category));
        END IF;
        ${retainOrAllocate}
      END IF;
    END`;
}

export async function ensureInventoryNumberingMysql() {
  if (!ready) ready = initialize().catch((error) => { ready = null; throw error; });
  return ready;
}

async function initialize() {
  // Named lock also serializes initialization across candidate/production processes.
  await withMysqlTransaction(async (connection) => {
    const [[lock]] = await connection.query("SELECT GET_LOCK('inventory_numbering_schema_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("库存编号初始化繁忙，请稍后重试");
    try {
      await initializeInventoryNumberingSchemaMysql(connection);
    } finally {
      await connection.query("SELECT RELEASE_LOCK('inventory_numbering_schema_v1')");
    }
  });
  // Deterministic, idempotent backfill and correction for records created before category reassignment existed.
  await mysqlExecute(`UPDATE products SET inventory_category = inventory_category, updated_at = updated_at
    WHERE inventory_number IS NULL AND TRIM(COALESCE(inventory_category, '')) <> ''
    ORDER BY id ASC`);
  await repairInventoryNumberCategoryMismatchMysql();
}

export async function repairInventoryNumberCategoryMismatchMysql() {
  const mismatch = `
    p.inventory_number IS NOT NULL
    AND TRIM(COALESCE(p.inventory_category, '')) <> ''
    AND (category.id IS NULL OR p.inventory_number_category <> category.id)`;
  const rows = await mysqlQuery(`
    SELECT p.id
    FROM products p
    LEFT JOIN inventory_number_categories category ON category.core_name = TRIM(p.inventory_category)
    WHERE ${mismatch}
    ORDER BY p.id ASC
  `);
  const repaired = rows.length;
  if (!repaired) return { repaired: 0 };
  for (const row of rows) {
    await mysqlExecute(`UPDATE products SET inventory_category = inventory_category, updated_at = updated_at WHERE id = ?`, [row.id]);
  }
  return { repaired };
}

export async function initializeInventoryNumberingSchemaMysql(connection, { triggerDefiner = "" } = {}) {
  for (const sql of [
    "ALTER TABLE products ADD COLUMN inventory_number VARCHAR(64) NULL",
    "ALTER TABLE products ADD COLUMN inventory_number_category BIGINT UNSIGNED NULL",
    "ALTER TABLE products ADD COLUMN inventory_number_sequence BIGINT UNSIGNED NULL",
    "CREATE UNIQUE INDEX uk_products_inventory_number ON products (inventory_number)",
    "CREATE INDEX idx_products_inventory_number_order ON products (inventory_number_category, inventory_number_sequence)"
  ]) {
    try { await connection.query(sql); } catch (error) {
      if (!["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error.code)) throw error;
    }
  }
  await connection.query(`CREATE TABLE IF NOT EXISTS inventory_number_categories (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    core_name VARCHAR(255) NOT NULL UNIQUE,
    last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await connection.query(`INSERT IGNORE INTO inventory_number_categories (id, core_name) VALUES
    (0, ''), (1, '钥匙壳'), (2, '门槛条'), (3, '门槛条贴纸'), (4, '扶手箱'), (5, '中柱贴纸')`);
  for (const event of ["INSERT", "UPDATE"]) {
    const [triggers] = await connection.query(`SELECT TRIGGER_NAME, ACTION_STATEMENT FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`, [`products_inventory_number_${event.toLowerCase()}`]);
    const action = String(triggers[0]?.ACTION_STATEMENT || "").toLowerCase();
    const needsUpgrade = action.includes("new.product_type") || !action.includes("old.inventory_number_category = category_id");
    if (needsUpgrade && triggerDefiner) await connection.query(`DROP TRIGGER products_inventory_number_${event.toLowerCase()}`);
    if (!triggers.length || (needsUpgrade && triggerDefiner)) {
      const sql = inventoryNumberTriggerSql(event);
      await connection.query(triggerDefiner ? sql.replace("CREATE TRIGGER", `CREATE DEFINER = ${triggerDefiner} TRIGGER`) : sql);
    }
  }
}
