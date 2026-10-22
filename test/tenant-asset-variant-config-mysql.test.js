import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { assetVariantExecutionScope } from "../src/services/asset-variant-tenant-scope.js";
import { loadAssetVariantConfigService, loadShopTailResolver } from "./helpers/asset-variant-config-service.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = (id, slug = `enterprise-${id}`) => ({ personId: id, tenant: { id, slug, role: "admin" } });

test("enterprise matrix configuration and tail fallback against a disposable MySQL database", {
  skip: !socketPath && "Set TENANT_TEST_MYSQL_SOCKET to an isolated MySQL instance; only a generated fixture database is created and dropped."
}, async t => {
  const database = `ozon_matrix_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
  let created = false;
  let reads = 0;
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database });
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT UNSIGNED PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active') ENGINE=InnoDB",
      `CREATE TABLE shops (id BIGINT PRIMARY KEY, tenant_id BIGINT UNSIGNED NULL, name VARCHAR(80), status VARCHAR(32) DEFAULT 'active',
        legal_entity VARCHAR(80) DEFAULT '', watermark_path TEXT, watermark_position VARCHAR(32), watermark_x_percent DECIMAL(8,4),
        watermark_y_percent DECIMAL(8,4), watermark_scale_percent DECIMAL(8,4), watermark_opacity_percent DECIMAL(8,4)) ENGINE=InnoDB`,
      `CREATE TABLE shop_variant_rules (id BIGINT PRIMARY KEY AUTO_INCREMENT, shop_id BIGINT NOT NULL UNIQUE, title_style VARCHAR(32), tag_style VARCHAR(32),
        price_index DECIMAL(10,4), price_role VARCHAR(32), watermark_template_id VARCHAR(128), tail_image_url TEXT, main_image_plan VARCHAR(32),
        tail_category VARCHAR(128), vehicle_model VARCHAR(128), tail_template_id BIGINT, updated_by_person_id BIGINT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB`,
      `CREATE TABLE asset_tail_templates (id BIGINT PRIMARY KEY AUTO_INCREMENT, tenant_id BIGINT UNSIGNED NULL, shop_id BIGINT NULL,
        category VARCHAR(128) DEFAULT 'C', vehicle_model VARCHAR(128) DEFAULT 'M', name VARCHAR(255) DEFAULT 'Tail', image_path TEXT,
        purpose VARCHAR(64) DEFAULT 'anti_hijack', is_default TINYINT DEFAULT 1, sort_order INT DEFAULT 0, status VARCHAR(32) DEFAULT 'active',
        created_by_person_id BIGINT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_asset_tail_templates_tenant_scope (tenant_id, shop_id, category, vehicle_model, status)) ENGINE=InnoDB`,
      `CREATE TABLE shop_watermark_templates (id BIGINT PRIMARY KEY, name VARCHAR(80), logo_url TEXT, logo_path TEXT, position VARCHAR(32),
        opacity DECIMAL(8,4), size_percent INT, margin_px INT, status VARCHAR(32), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`
    ]) await connection.execute(sql);
    await connection.execute("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'enterprise-2'), (3, 'enterprise-3')");
    await connection.execute(`INSERT INTO shops (id, tenant_id, name, watermark_path) VALUES
      (10, NULL, 'Legacy', '/legacy.png'), (11, 1, 'Default', '/default.png'), (20, 2, 'A', '/a.png'), (30, 3, 'B', '/b.png')`);
    await connection.execute("INSERT INTO shop_variant_rules (shop_id, price_index) VALUES (20, 1), (30, 9)");
    await connection.execute(`INSERT INTO asset_tail_templates (id, tenant_id, shop_id, image_path) VALUES
      (100, NULL, NULL, 'legacy-tail'), (101, 1, NULL, 'default-tail'),
      (200, 2, NULL, 'a-generic'), (201, 2, 20, 'a-shop'), (202, 2, 30, 'invalid-shop-owner'),
      (300, 3, NULL, 'b-generic'), (301, 3, 30, 'b-shop')`);
    const service = loadAssetVariantConfigService({
      query, execute: query,
      transaction: async action => {
        await connection.beginTransaction();
        try { const result = await action(connection); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
      },
      readFile: async () => { reads += 1; return Buffer.from("own-tail-bytes"); }
    });

    await t.test("A, B, and default bootstraps return only their shops and private tails", async () => {
      const a = await service.assetVariantBootstrap({ tenantId: 3 }, session(2));
      const b = await service.assetVariantBootstrap({}, session(3));
      const legacy = await service.assetVariantBootstrap({}, session(1, "default"));
      assert.deepEqual(Array.from(a.shops, row => row.id), [20]);
      assert.deepEqual(Array.from(b.shops, row => row.id), [30]);
      assert.deepEqual(Array.from(legacy.shops, row => row.id).sort(), [10, 11]);
      assert.deepEqual(Array.from(a.tailTemplates, row => row.id).sort(), [200, 201]);
      assert.deepEqual(Array.from(b.tailTemplates, row => row.id).sort(), [300, 301]);
      assert.deepEqual(Array.from(legacy.tailTemplates, row => row.id).sort(), [100, 101]);
    });

    await t.test("default operations members read their own publishing configuration without administrator grants", async () => {
      const operations = { personId: 9, roles: ["operations"], tenant: { id: 1, slug: "default", role: "member" } };
      assert.equal(assetVariantExecutionScope(operations).id, 1);
      const bootstrap = await service.assetVariantBootstrap({}, operations);
      assert.deepEqual(Array.from(bootstrap.shops, row => row.id).sort(), [10, 11]);
      assert.deepEqual(Array.from(await service.assetTailTemplates({}, operations), row => row.id).sort(), [100, 101]);
      assert.equal((await service.resolveAssetTailTemplateFile(100, operations)).buffer.toString(), "own-tail-bytes");
      await assert.rejects(service.saveShopVariantRule({ shopId: 11, priceIndex: 2 }, operations), { statusCode: 403 });
      await assert.rejects(service.createAssetTailTemplate({ image: "data:image/png;base64,AA==" }, operations), { statusCode: 403 });
      assert.equal((await query("SELECT COUNT(*) AS total FROM shop_variant_rules WHERE shop_id = 11"))[0].total, 0);
      assert.equal((await query("SELECT COUNT(*) AS total FROM asset_tail_templates"))[0].total, 7);
      assert.equal(assetVariantExecutionScope(session(2)).id, 2);
    });

    await t.test("A can edit its own rule while cross-tenant shop, watermark, and template references fail", async () => {
      await service.saveShopVariantRule({ tenant_id: 3, shopId: 20, priceIndex: 1.25, watermarkTemplateId: "shop-20", tailTemplateId: 201 }, session(2));
      for (const body of [{ shopId: 30 }, { shopId: 20, watermarkTemplateId: "shop-30" }, { shopId: 20, tailTemplateId: 300 }]) {
        await assert.rejects(service.saveShopVariantRule(body, session(2)), { statusCode: 404 });
      }
      assert.deepEqual((await query("SELECT shop_id, price_index FROM shop_variant_rules ORDER BY shop_id")).map(row => [row.shop_id, Number(row.price_index)]), [[20, 1.25], [30, 9]]);
    });

    await t.test("A generic default never changes B or legacy defaults and receives owner from session", async () => {
      const tail = await service.createAssetTailTemplate({ tenant_id: 3, category: "C", vehicleModel: "M", image: "data:image/png;base64,AA==", isDefault: true }, session(2));
      assert.equal(tail.tenant_id, 2);
      assert.equal(tail.shop_id, null);
      assert.deepEqual(await query("SELECT id, is_default FROM asset_tail_templates WHERE id IN (100, 200, 300) ORDER BY id"), [
        { id: 100, is_default: 1 }, { id: 200, is_default: 0 }, { id: 300, is_default: 1 }
      ]);
    });

    await t.test("default can retain legacy tails without resetting enterprise defaults", async () => {
      await service.createAssetTailTemplate({ category: "C", vehicleModel: "M", image: "data:image/png;base64,AA==", isDefault: true }, session(1, "default"));
      assert.equal((await query("SELECT is_default FROM asset_tail_templates WHERE id = 100"))[0].is_default, 0);
      assert.equal((await query("SELECT is_default FROM asset_tail_templates WHERE id = 300"))[0].is_default, 1);
      assert.equal((await query("SELECT SUM(is_default) AS total FROM asset_tail_templates WHERE tenant_id = 2 AND shop_id IS NULL"))[0].total, "1");
    });

    await t.test("private file lookup denies B before filesystem reads and allows A", async () => {
      const before = reads;
      assert.equal(await service.resolveAssetTailTemplateFile(300, session(2)), null);
      assert.equal(await service.resolveAssetTailTemplateFile(100, session(2)), null);
      assert.equal(reads, before);
      assert.equal((await service.resolveAssetTailTemplateFile(201, session(2))).buffer.toString(), "own-tail-bytes");
    });

    await t.test("listing fallback cannot materialize foreign templates even from a malformed legacy rule", async () => {
      const resolve = loadShopTailResolver(query);
      await query("UPDATE shop_variant_rules SET tail_template_id = 300, tail_image_url = '' WHERE shop_id = 20");
      assert.equal(await resolve({ id: 20 }, session(2)), "");
      await query("UPDATE shop_variant_rules SET tail_template_id = NULL WHERE shop_id = 20");
      assert.equal(await resolve({ id: 20 }, session(2)), "a-shop");
    });
  } finally {
    if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await connection.end();
  }
});
