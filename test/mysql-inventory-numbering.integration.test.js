import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import mysql from "mysql2/promise";

// Opt-in: uses only a newly created disposable database, never the ERP database.
test("MySQL inventory numbers: migration, category reassignment, concurrency and no reuse", { skip: process.env.INVENTORY_NUMBERING_TEST_MYSQL !== "1" }, async () => {
  const database = `inventory_numbering_test_${process.pid}_${Date.now()}`;
  const settings = { socketPath: process.env.MYSQL_TEST_SOCKET || "/var/run/mysqld/mysqld.sock", user: "root" };
  const admin = await mysql.createConnection(settings);
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...settings, database, connectionLimit: 8 });
    await pool.query(`CREATE TABLE products (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), code VARCHAR(128),
      inventory_category VARCHAR(255), product_type VARCHAR(32) DEFAULT 'main', selection_status VARCHAR(32) DEFAULT 'listed',
      stock_unit VARCHAR(32) DEFAULT '个', active INT DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await pool.query("INSERT INTO products (name, code, inventory_category) VALUES ('first', 'old-1', '钥匙壳'), ('second', 'old-2', '钥匙壳'), ('third', 'old-3', '门槛条')");
    const source = readFileSync(new URL('../src/services/inventory-numbering.js', import.meta.url), 'utf8')
      .replace(/^import .*;\n/m, '').replaceAll('export ', '');
    const context = vm.createContext({
      mysqlExecute: (sql, params) => pool.execute(sql, params),
      mysqlQuery: async (sql, params) => (await pool.query(sql, params))[0],
      withMysqlTransaction: async work => {
        const connection = await pool.getConnection();
        try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      }
    });
    vm.runInContext(source, context);
    await context.ensureInventoryNumberingMysql();
    await pool.query("DROP TRIGGER products_inventory_number_update");
    await pool.query("CREATE TRIGGER products_inventory_number_update BEFORE UPDATE ON products FOR EACH ROW SET NEW.product_type = NEW.product_type");
    await context.initializeInventoryNumberingSchemaMysql(pool, { triggerDefiner: "CURRENT_USER" });
    const [initial] = await pool.query("SELECT id, code, inventory_number FROM products ORDER BY id");
    assert.deepEqual(initial.map(row => row.inventory_number), ['1-1', '1-2', '2-1']);
    assert.equal(initial[0].code, 'old-1');
    await pool.query("UPDATE products SET name='renamed', inventory_category='门槛条', inventory_number='99-99' WHERE id=1");
    assert.equal((await pool.query("SELECT inventory_number FROM products WHERE id=1"))[0][0].inventory_number, '2-2');
    await pool.query("DELETE FROM products WHERE id=2");
    const parallel = await Promise.all(Array.from({length:24}, (_, index) => pool.query("INSERT INTO products (name, inventory_category) VALUES (?, '钥匙壳')", [`parallel-${index}`])));
    assert.equal(new Set(parallel.map(([result]) => result.insertId)).size, 24);
    const [numbers] = await pool.query("SELECT inventory_number FROM products WHERE inventory_number_category=1 ORDER BY inventory_number_sequence");
    assert.deepEqual(numbers.map(row => row.inventory_number), Array.from({length:24}, (_, i) => `1-${i+3}`));
    await Promise.all(Array.from({length:8}, () => pool.query("INSERT INTO products (name, inventory_category) VALUES ('new', '新类目')")));
    const [categories] = await pool.query("SELECT * FROM inventory_number_categories WHERE core_name='新类目'");
    assert.equal(categories.length, 1); assert.equal(categories[0].id, 6); assert.equal(categories[0].last_sequence, 8);
    await pool.query("INSERT INTO products (name, inventory_category, product_type, selection_status) VALUES ('selection', '钥匙壳', 'selection', 'draft')");
    assert.equal((await pool.query("SELECT inventory_number FROM products WHERE name='selection'"))[0][0].inventory_number, '1-27');
    await pool.query("UPDATE products SET selection_status='listed' WHERE name='selection'");
    assert.equal((await pool.query("SELECT inventory_number FROM products WHERE name='selection'"))[0][0].inventory_number, '1-27');
    await pool.query("INSERT INTO products (name, inventory_category) VALUES ('missing', '')");
    await pool.query("UPDATE products SET inventory_category='钥匙壳' WHERE name='missing'");
    assert.equal((await pool.query("SELECT inventory_number FROM products WHERE name='missing'"))[0][0].inventory_number, '1-28');
    const tx = await pool.getConnection();
    await tx.beginTransaction(); await tx.query("INSERT INTO products (name, inventory_category) VALUES ('rollback', '钥匙壳')"); await tx.rollback(); tx.release();
    const [before] = await pool.query('SELECT inventory_number FROM products ORDER BY id');
    await context.initialize();
    assert.deepEqual((await pool.query('SELECT inventory_number FROM products ORDER BY id'))[0], before);
    await pool.query("UPDATE inventory_number_categories SET last_sequence=999 WHERE id=1");
    await pool.query("INSERT INTO products (name, inventory_category) VALUES ('thousand', '钥匙壳')");
    assert.equal((await pool.query("SELECT inventory_number FROM products WHERE name='thousand'"))[0][0].inventory_number, '1-1000');

    await pool.query("DROP TRIGGER products_inventory_number_update");
    await pool.query("UPDATE products SET inventory_category='门槛条', inventory_number_category=1, inventory_number_sequence=3, inventory_number='1-3' WHERE name='parallel-0'");
    await context.initializeInventoryNumberingSchemaMysql(pool, { triggerDefiner: "CURRENT_USER" });
    await context.repairInventoryNumberCategoryMismatchMysql();
    const [[repaired]] = await pool.query("SELECT inventory_number FROM products WHERE name='parallel-0'");
    assert.match(repaired.inventory_number, /^2-/);

    await pool.query("CREATE TABLE orders (id BIGINT PRIMARY KEY, shop_id BIGINT)");
    await pool.query("CREATE TABLE order_items (id BIGINT PRIMARY KEY, order_id BIGINT, ozon_sku VARCHAR(64), sku_mapping_id BIGINT, quantity INT)");
    await pool.query("CREATE TABLE sku_mappings (id BIGINT PRIMARY KEY, shop_id BIGINT, ozon_sku VARCHAR(64), product_id BIGINT, active INT)");
    await pool.query("CREATE TABLE sku_inventory_recipes (id BIGINT PRIMARY KEY, shop_id BIGINT, ozon_sku VARCHAR(64), active INT)");
    await pool.query("CREATE TABLE sku_inventory_recipe_items (recipe_id BIGINT, product_id BIGINT, quantity INT)");
    await pool.query("CREATE TABLE product_components (product_id BIGINT, component_product_id BIGINT, quantity INT)");
    await pool.query("INSERT INTO orders VALUES (1,1), (2,1)");
    await pool.query("INSERT INTO sku_mappings VALUES (1,1,'a',1,1),(2,1,'b',1,1)");
    await pool.query("INSERT INTO order_items VALUES (1,1,'a',1,2),(2,1,'b',2,4),(3,2,'a',NULL,1)");
    await pool.query("INSERT INTO product_components VALUES (1,3,2)");
    await pool.query("INSERT INTO sku_inventory_recipes VALUES (1,1,'b',1)");
    await pool.query("INSERT INTO sku_inventory_recipe_items VALUES (1,3,3)");
    context.mysqlQuery = async (sql, params) => (await pool.query(sql, params))[0];
    vm.runInContext(readFileSync(new URL('../src/services/order-inventory-picking.js', import.meta.url), 'utf8')
      .replace(/^import .*;\n/m, '').replaceAll('export ', ''), context);
    const picking = await context.orderInventoryPickingMysql([1,2]);
    assert.equal(picking.get(1).find(row => row.sku === 'a').required_quantity, 4);
    assert.equal(picking.get(1).find(row => row.sku === 'b').required_quantity, 12);
    assert.equal(picking.get(2)[0].required_quantity, 2);
    assert.equal(picking.get(2)[0].inventory_number, '2-1');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
