import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=", "base64");

test("real AI and cropper services guard enterprise media before filesystem reads", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("ai_media");
  const cleanupPaths = [];
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const query = fixture.query;
    const [tenantColumns] = await fixture.connection.query("SHOW COLUMNS FROM tenants");
    if (!tenantColumns.some(column => column.Field === "subscription_status")) await query("ALTER TABLE tenants ADD subscription_status VARCHAR(32) DEFAULT 'active'");
    if (!tenantColumns.some(column => column.Field === "subscription_expires_at")) await query("ALTER TABLE tenants ADD subscription_expires_at DATETIME NULL");
    await query("INSERT INTO tenants (id, slug, name) VALUES (1, 'default', 'Default'), (2, 'enterprise-2', 'A'), (3, 'enterprise-3', 'B')");
    await query("INSERT INTO people (id, name, role) VALUES (7, 'Media operator', 'operations')");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id, tenant_id, name) VALUES (10, NULL, 'Legacy'), (11, 1, 'Default'), (20, 2, 'A'), (30, 3, 'B')");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const cropper = await import("../src/server/services/tools/imageCropperService.js");
    const ai = await import("../src/server/services/ai/aiWorkflowService.js");
    const owners = await import("../src/services/ai-image-task-ownership.js");
    const uploaded = [];
    for (const id of [1, 2, 3]) {
      const image = await cropper.saveUploadedImage({ filename: "source.png", contentType: "image/png", buffer: pixel }, session(id));
      uploaded.push(image);
      cleanupPaths.push({ root: cropper.imageCropperPaths.tempRoot, target: path.join(cropper.imageCropperPaths.tempRoot, image.taskId) });
    }

    await t.test("A/B/default file reads and every ZIP operation reject foreign task IDs", async () => {
      assert.equal((await cropper.getTaskFile(uploaded[1].taskId, "source.png", session(2))).size, pixel.length);
      for (const viewer of [1, 2]) {
        const foreign = uploaded[2].taskId;
        await assert.rejects(cropper.getTaskFile(foreign, "source.png", session(viewer)), /不属于当前企业/);
        for (const createZip of [cropper.createTaskZip, cropper.createEnhancedTaskZip, cropper.createRatioTaskZip, cropper.createWatermarkedTaskZip]) {
          await assert.rejects(createZip(foreign, "", session(viewer)), /不属于当前企业/);
        }
      }
      const ownDir = path.join(cropper.imageCropperPaths.tempRoot, uploaded[1].taskId, "crops");
      await fs.writeFile(path.join(ownDir, "own.png"), pixel);
      assert.ok((await cropper.createTaskZip(uploaded[1].taskId, "", session(2))).buffer.length > pixel.length);
    });

    await t.test("foreign detect/enhance/ratio/watermark fail before invoking processors", async () => {
      const foreign = { taskId: uploaded[2].taskId, imagePath: uploaded[2].imagePath };
      await assert.rejects(cropper.detectAndCropImage(foreign, session(2)), /不属于当前企业/);
      await assert.rejects(cropper.enhanceTaskCrops(foreign, session(2)), /不属于当前企业/);
      await assert.rejects(cropper.convertTaskCropsToRatio(foreign, session(2)), /不属于当前企业/);
      await assert.rejects(cropper.watermarkTaskCrops({ ...foreign, shopId: 20 }, session(2)), /不属于当前企业/);
      await assert.rejects(cropper.getTaskFile(uploaded[1].taskId, `../${uploaded[2].taskId}/source.png`, session(2)), { status: 400 });
      await assert.rejects(cropper.createTaskZip(uploaded[1].taskId, "../..", session(2)), { status: 400 });
    });

    await t.test("shop watermarks read and write only own enterprise shops", async () => {
      for (const id of [1, 2, 3]) {
        const shopId = id === 1 ? 11 : id * 10;
        const result = await cropper.saveShopWatermark({ shopId, filename: "mark.png", contentType: "image/png", buffer: pixel }, session(id));
        const row = (await query("SELECT watermark_path FROM shops WHERE id = ?", [shopId]))[0];
        const { resolveUploadSubdir } = await import("../src/runtime-uploads.js");
        const root = resolveUploadSubdir("shop-watermarks");
        cleanupPaths.push({ root, target: path.join(root, path.basename(row.watermark_path)) });
        assert.equal(result.shopId, shopId);
      }
      assert.equal((await cropper.getShopWatermarkFile(20, session(2))).size, pixel.length);
      for (const id of [1, 2]) {
        await assert.rejects(cropper.getShopWatermarkFile(30, session(id)), { status: 404 });
        await assert.rejects(cropper.saveShopWatermark({ shopId: 30, filename: "bad.png", contentType: "image/png", buffer: pixel }, session(id)), { status: 404 });
      }
    });

    await t.test("matrix jobs, private variant files, and media deletion stay within the enterprise", async () => {
      const assets = await import("../src/services/asset-variant-engine.js");
      await assets.assetVariantJobs({}, session(2)); // Initialize the real service schema.
      for (const [key, id] of [["admin", 101], ["2", 102], ["3", 103]]) {
        await query("INSERT INTO asset_variant_jobs (id, tenant_id, job_no, status, created_by_person_id) VALUES (?, ?, ?, 'queued', 7)", [id, key, `job-${id}`]);
      }
      assert.deepEqual((await assets.assetVariantJobs({ createdByPersonId: 7 }, session(2))).map(job => job.id), [102]);
      assert.deepEqual((await assets.assetVariantJobs({}, session(1))).map(job => job.id), [101]);
      assert.equal(await assets.assetVariantJobDetail(103, session(2)), null);
      assert.equal(await assets.assetVariantJobDetail(103, session(1)), null);
      await assert.rejects(assets.cancelAssetVariantJob(103, session(2)), /not found/);
      await assert.rejects(assets.retryAssetVariantJobFailures(103, session(1)), /not found/);
      await assets.cancelAssetVariantJob(102, session(2));
      assert.equal((await query("SELECT status FROM asset_variant_jobs WHERE id = 103"))[0].status, "queued");
      assert.equal((await query("SELECT status FROM asset_variant_jobs WHERE id = 102"))[0].status, "cancelled");
      const root = path.resolve("uploads", "shop-variants");
      const batch = `tenant-fixture-${randomUUID()}`;
      const batchDir = path.join(root, batch);
      cleanupPaths.push({ root, target: batchDir });
      for (const shop of [20, 30]) {
        const output = path.join(batchDir, `shop-${shop}`);
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, "image.png"), pixel);
        await query("INSERT INTO asset_variants (batch_id, shop_id, output_dir) VALUES (?, ?, ?)", [batch, shop, path.relative(process.cwd(), output).replaceAll("\\", "/")]);
      }
      assert.ok(await assets.resolveAssetVariantFile(batch, "shop-20/image.png", session(2)));
      assert.equal(await assets.resolveAssetVariantFile(batch, "shop-30/image.png", session(2)), null);
      assert.equal(await assets.resolveAssetVariantFile(batch, "shop-30/image.png", session(1)), null);
      const removed = await assets.deleteAssetVariantMediaGroup({ batchId: batch }, session(2));
      assert.equal(removed.deletedVariants, 1);
      assert.deepEqual((await query("SELECT shop_id FROM asset_variants WHERE batch_id = ?", [batch])).map(row => row.shop_id), [30]);
      assert.equal((await fs.stat(path.join(batchDir, "shop-30", "image.png"))).isFile(), true);
    });

    await t.test("AI generated files and ZIP use durable task owner and reject sibling path traversal", async () => {
      const tasks = [];
      const root = path.resolve("uploads", "ai-generated");
      for (const id of [1, 2, 3]) {
        const taskId = randomUUID(); tasks.push(taskId);
        await owners.registerAiImageTaskOwner(taskId, session(id));
        const target = path.join(root, taskId);
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "generated_001.png"), pixel);
        cleanupPaths.push({ root, target });
      }
      assert.equal((await ai.getAiTaskFile(tasks[1], "generated", "generated_001.png", session(2))).size, pixel.length);
      assert.ok((await ai.createAiTaskZip(tasks[1], session(2))).buffer.length > pixel.length);
      for (const id of [1, 2]) {
        await assert.rejects(ai.getAiTaskFile(tasks[2], "generated", "generated_001.png", session(id)), /不属于当前企业/);
        await assert.rejects(ai.createAiTaskZip(tasks[2], session(id)), /不属于当前企业/);
      }
      await assert.rejects(ai.getAiTaskFile(tasks[1], "generated", `../${tasks[2]}/generated_001.png`, session(2)), { status: 400 });
      await query("UPDATE tenant_members SET active = 0 WHERE tenant_id = 2");
      await assert.rejects(ai.getAiTaskFile(tasks[1], "generated", "generated_001.png", session(2)), { statusCode: 403 });
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    for (const { root, target } of cleanupPaths) {
      const relative = path.relative(path.resolve(root), path.resolve(target));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe fixture cleanup target");
      await fs.rm(target, { recursive: true, force: true });
    }
    await fixture.cleanup();
  }
});
