import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { inspectReviewedUniqueRepair } from '../../scripts/lib/reviewed-unique-index-repair.mjs';
export const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
export async function fixture(run) {
  const db = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  const database = `ozon_unique_test_${randomBytes(8).toString('hex')}`;
  let created = false;
  try {
    const [[server]] = await db.query('SELECT @@skip_networking AS disabled');
    assert.equal(Number(server.disabled), 1);
    await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
    await db.changeUser({ database });
    await db.query("SET SESSION time_zone='+00:00'"); await db.query('SET SESSION max_execution_time=10000');
    // The source corruption is represented by NONUNIQUE versions of the three
    // exact keys, just like the full-row recovery clone. InnoDB correctly
    // refuses inserting these duplicates into a healthy UNIQUE key.
    await db.query(`
      CREATE TABLE tenants(id BIGINT UNSIGNED PRIMARY KEY,slug VARCHAR(64) UNIQUE) ENGINE=InnoDB;
      INSERT INTO tenants VALUES(1,'default'),(2,'customer-a'),(3,'customer-b');
      CREATE TABLE shops(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL) ENGINE=InnoDB;
      INSERT INTO shops VALUES(10,NULL),(20,2),(30,3);
      CREATE TABLE products(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL) ENGINE=InnoDB;
      INSERT INTO products VALUES(100,NULL),(200,2),(300,3);
      CREATE TABLE orders(id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB;
      INSERT INTO orders VALUES(1000,10),(2000,20),(3000,30);
      CREATE TABLE order_items(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB;
      INSERT INTO order_items VALUES(10001,1000);
      CREATE TABLE online_products(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,shop_id BIGINT UNSIGNED NOT NULL,ozon_sku VARCHAR(128) NOT NULL,
        ozon_product_id VARCHAR(128),product_id BIGINT UNSIGNED NULL,status VARCHAR(32),raw_json LONGTEXT,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY uk_online_products_shop_sku(shop_id,ozon_sku)) ENGINE=InnoDB;
      INSERT INTO online_products(id,shop_id,ozon_sku,ozon_product_id,product_id,status,raw_json,updated_at) VALUES
        (11,10,'PRIVATE-SKU','EXT-A',100,'historical','{"title":"old"}','2025-01-01'),
        (12,10,'PRIVATE-SKU','EXT-A',100,'ready','{"title":"new"}','2025-01-02'),
        (21,20,'PRIVATE-SKU','EXT-B',200,'ready','{}','2025-01-01');
      CREATE TABLE order_status_history(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,order_id BIGINT UNSIGNED NOT NULL,shop_id BIGINT UNSIGNED NOT NULL,
        observed_hour DATETIME NOT NULL,status VARCHAR(64) NOT NULL,logistics_status VARCHAR(64) NOT NULL,tracking_stage VARCHAR(64) NOT NULL,sync_state VARCHAR(32) NOT NULL,
        raw_status_json LONGTEXT,KEY uk_order_status_history_hour_state(order_id,observed_hour,status,logistics_status,tracking_stage,sync_state)) ENGINE=InnoDB;
      INSERT INTO order_status_history VALUES(31,1000,10,'2025-01-01','delivered','','','synced','{"event":1}'),(32,1000,10,'2025-01-01','delivered','','','synced','{"event":2}');
      CREATE TABLE ozon_category_mappings(id BIGINT AUTO_INCREMENT PRIMARY KEY,description_category_id BIGINT NOT NULL,type_id BIGINT NOT NULL,
        name_ru VARCHAR(500) NOT NULL,name_zh VARCHAR(500),status VARCHAR(32),is_auto TINYINT,raw_json LONGTEXT,source_shop_id BIGINT NULL,
        UNIQUE KEY other_unique(id),KEY uq_ozon_category_mapping(description_category_id,type_id)) ENGINE=InnoDB;
      INSERT INTO ozon_category_mappings VALUES(41,100,101,'name','old','inactive',1,'{}',10),(42,100,101,'name','current','active',0,'{"official":true}',20);
      CREATE TABLE online_product_actions(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED NOT NULL,shop_id BIGINT UNSIGNED NOT NULL,tenant_id VARCHAR(64),request_json LONGTEXT) ENGINE=InnoDB;
      INSERT INTO online_product_actions VALUES(1,11,10,'admin','{"online_product_id":11}');
      CREATE TABLE outbound_records(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,
        order_item_id BIGINT UNSIGNED,quantity INT,ozon_sku VARCHAR(128)) ENGINE=InnoDB;
      INSERT INTO outbound_records VALUES(2,11,10,100,10001,2,'PRIVATE-SKU');
      CREATE TABLE ozon_stock_snapshots(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,product_id BIGINT UNSIGNED,
        ozon_sku VARCHAR(128),warehouse_id BIGINT,stock_type VARCHAR(32),UNIQUE KEY stock_key(shop_id,ozon_sku,warehouse_id,stock_type)) ENGINE=InnoDB;
      INSERT INTO ozon_stock_snapshots VALUES(3,11,10,100,'PRIVATE-SKU',99,'fbs');
      CREATE TABLE product_barcode_label_cache(online_product_id BIGINT UNSIGNED PRIMARY KEY,shop_id BIGINT UNSIGNED,label_pdf LONGBLOB NOT NULL,ozon_product_id VARCHAR(128)) ENGINE=InnoDB;
      INSERT INTO product_barcode_label_cache VALUES(11,10,UNHEX('000102FF'),'EXT-A'),(12,10,UNHEX('ABCDEF'),'EXT-A');
      CREATE TABLE sku_inventory_recipes(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,ozon_sku VARCHAR(128),UNIQUE KEY recipe_key(shop_id,ozon_sku)) ENGINE=InnoDB;
      INSERT INTO sku_inventory_recipes VALUES(4,11,10,'PRIVATE-SKU');
      CREATE TABLE sku_mappings(id BIGINT UNSIGNED PRIMARY KEY,online_product_id BIGINT UNSIGNED,shop_id BIGINT UNSIGNED,tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED,ozon_sku VARCHAR(128),active TINYINT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY mapping_key(shop_id,ozon_sku)) ENGINE=InnoDB;
      INSERT INTO sku_mappings VALUES(5,11,10,NULL,100,'PRIVATE-SKU',1,'2025-01-01');
      CREATE TABLE inventory_product_requests(id BIGINT UNSIGNED PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED NULL,payload_json LONGTEXT NOT NULL,status VARCHAR(32),binding_status VARCHAR(32),updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB;
      INSERT INTO inventory_product_requests VALUES(6,NULL,100,'{ "online_product_id":11, "shop_id":10, "unchanged":"evidence" }','approved','pending','2025-01-01');
    `);
    await run({ db, database, query: async (text, args = []) => (await db.query(text, args))[0] });
  } finally { if (created) await db.query(`DROP DATABASE \`${database}\``); await db.end(); }
}
export function plan(tables = ['online_products', 'order_status_history', 'ozon_category_mappings']) {
  const groups = { online_products: { row_ids: [11,12], keeper_id: 12 }, order_status_history: { row_ids: [31,32], keeper_id: 31 }, ozon_category_mappings: { row_ids: [41,42], keeper_id: 42 } };
  return { version: 1, repair_id: randomBytes(6).toString('hex'), tables: tables.map(table => ({ table, groups: [groups[table]] })), reviewed_by: 'isolated-test-reviewer', reason: 'Reviewed historical duplicate fixture', maintenance_confirmed: true, rollback_restores_nonunique_schema: true, invalidate_barcode_cache: true, preserve_historical_json: true };
}
export async function reviewed(db, value = plan()) {
  const report = await inspectReviewedUniqueRepair(db, value);
  value.expected_reference_digest = report.expected_reference_digest;
  for (const entry of value.tables) for (let n = 0; n < entry.groups.length; n++) {
    const group = report.tables.find(row => row.table === entry.table).groups[n];
    entry.groups[n].expected_hashes = group.expected_hashes;
    entry.groups[n].accepted_differing_columns = group.differing_columns;
  }
  return value;
}

export async function unchangedOutboundFixture(query) {
  await query('INSERT INTO shops(id,tenant_id) VALUES(11,NULL); INSERT INTO orders(id,shop_id) VALUES(1100,11); INSERT INTO order_items(id,order_id) VALUES(11001,1100)');
  await query(`ALTER TABLE outbound_records ADD evidence_blob LONGBLOB,ADD evidence_json LONGTEXT,ADD amount DECIMAL(14,4),
    ADD updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
  await query(`UPDATE outbound_records SET online_product_id=12,order_item_id=11001,evidence_blob=UNHEX('0000FFABCDEF'),evidence_json='{ "old_parent":11001, "retain":true }',amount=-17.2500,updated_at='2025-01-01' WHERE id=2`);
  const columns = (await query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['outbound_records'])).map(row => row.COLUMN_NAME);
  const quote = value => '`' + value.replaceAll('`', '``') + '`';
  const expression = `SHA2(CONCAT(${columns.map(name => `IF(${quote(name)} IS NULL,'N',CONCAT('V',OCTET_LENGTH(CAST(${quote(name)} AS BINARY)),':',HEX(CAST(${quote(name)} AS BINARY))))`).join(',')}),256)`;
  const [fingerprint] = await query(`SELECT ${expression} AS sha256 FROM outbound_records FORCE INDEX(PRIMARY) WHERE id=2`);
  return { table: 'outbound_records', row_id: '2', shop_id: '10', online_product_id: '12', order_item_id: '11001', expected_parent_order_id: '1100', expected_parent_shop_id: '11', expected_tenant_id: '1',
    expected_full_row_sha256: fingerprint.sha256, user_confirmation_reference: 'Isolated fixture: human explicitly approved retaining the entire unresolved row', reason: 'Preserve exact historical evidence; do not guess a replacement parent' };
}
