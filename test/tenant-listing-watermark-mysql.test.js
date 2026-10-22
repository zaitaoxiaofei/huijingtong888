import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parse } from "acorn";
import mysql from "mysql2/promise";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey } from "../src/services/business-task-tenant.js";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { AI_IMAGE_TASK_OWNERS_SCHEMA } from "../src/services/ai-tenant-schema.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = (id, personId = 7) => ({ personId, roles: ["operations"], tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function declarations(file, names) {
  const text = source(file);
  const nodes = parse(text, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
  return names.map(name => {
    const node = nodes.find(item => item.type === "FunctionDeclaration" && item.id.name === name);
    assert.ok(node, `${file}: missing actual function ${name}`);
    return text.slice(node.start, node.end);
  }).join("\n");
}

test("listing watermarking rechecks real enterprise authority and shop ownership before media side effects", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  // No application pool/config is imported. Only a freshly created random DB on
  // the explicitly supplied, TCP-disabled test server may be read or dropped.
  const database = `ozon_watermark_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  let created = false;
  try {
    const [[server]] = await connection.query("SELECT @@skip_networking AS networking_disabled");
    assert.equal(Number(server.networking_disabled), 1, "Refuse a network-accessible MySQL server");
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database });
    const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL, active TINYINT DEFAULT 1)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, active TINYINT DEFAULT 1, PRIMARY KEY (tenant_id, person_id))",
      "CREATE TABLE shops (id BIGINT PRIMARY KEY, tenant_id BIGINT NULL, name VARCHAR(80), status VARCHAR(32) DEFAULT 'active', watermark_path TEXT, watermark_name VARCHAR(100), watermark_position VARCHAR(32), watermark_x_percent DECIMAL(8,4), watermark_y_percent DECIMAL(8,4), watermark_scale_percent DECIMAL(8,4), watermark_opacity_percent DECIMAL(8,4))",
      AI_IMAGE_TASK_OWNERS_SCHEMA
    ]) await query(sql);
    await query("INSERT INTO tenants (id,slug) VALUES (1,'default'),(2,'enterprise-2'),(3,'enterprise-3')");
    await query("INSERT INTO people (id) VALUES (7),(8)");
    await query("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (1,7,JSON_ARRAY('operations')),(2,7,JSON_ARRAY('operations')),(3,7,JSON_ARRAY('operations')),(3,8,JSON_ARRAY('operations'))");
    await query("INSERT INTO shops (id,tenant_id,name,watermark_path) VALUES (10,NULL,'Legacy default','shop-watermarks/default.png'),(11,1,'Default','shop-watermarks/default.png'),(20,2,'A','shop-watermarks/a.png'),(30,3,'B','shop-watermarks/b.png')");
    for (const [task, key] of [["task-default", "admin"], ["task-enterprise-a", "2"], ["task-enterprise-b", "3"], ["image-cropper:crop-enterprise-a", "2"], ["image-cropper:crop-enterprise-b", "3"]]) {
      await query("INSERT INTO ai_image_task_owners (task_id,tenant_id,created_by_person_id) VALUES (?,?,7)", [task, key]);
    }

    const calls = [], timeoutValues = [];
    let hook = async () => {}, fileBytes = Buffer.from("fixture image");
    const stage = async (name, detail = {}) => { calls.push({ ...detail, name }); await hook(name, detail); };
    const context = vm.createContext({
      Buffer, process, URL, AbortSignal: { timeout(ms) { timeoutValues.push(ms); return AbortSignal.timeout(ms); } },
      crypto, path, AI_IMAGE_TASK_OWNERS_SCHEMA, listingTenantLookup, businessTaskTenantKey, assertBusinessTaskPermission,
      mysqlQuery: query, mysqlExecute: query,
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query),
      currentAiTenantSession: () => null,
      // Schema setup, image rendering and storage are deliberately adapters.
      // Authorization, shop SELECTs and private-file owner SELECTs remain real.
      ensureListingAutomationSchema: async () => {},
      resolveListingMediaLocalPath: value => value.startsWith("/uploads/listing-media/") ? path.resolve("fixture-media", path.basename(value)) : "",
      resolveListingShopWatermarkPath: async shop => { await stage("watermark", { shop: Number(shop.id) }); return shop.watermark_path; },
      applyListingWatermark: async buffer => { await stage("render"); return buffer; },
      optimizeListingImageForPublish: async buffer => { await stage("optimize"); return { buffer, extension: ".png", contentType: "image/png" }; },
      fs: {
        stat: async () => ({ isFile: () => true, size: fileBytes.length }),
        readFile: async file => { await stage("read", { file }); return fileBytes; }
      },
      fsSync: { existsSync: () => true },
      writeListingMediaFile: async (name, bytes) => {
        await stage("write", { name, bytes: bytes.length });
        return { localPath: path.resolve("fixture-media", name), previewUrl: `/uploads/listing-media/${name}`, publishUrl: `https://fixture.invalid/${name}`, storageName: name };
      },
      registerListingMediaAsset: async (body, current) => {
        await stage("register", { tenant: current.tenant.id, person: current.personId, shop: body.shop_id }); return { id: calls.length };
      },
      buildListingMediaPublishUrl: value => value,
      requestPublicImage: async (url, options) => {
        assert.equal(options.maxBytes, 30 * 1024 * 1024);
        assert.equal(options.signal instanceof AbortSignal, true);
        assert.equal(typeof options.beforeRequest, "function");
        await stage("before-public-request", { url });
        await options.beforeRequest();
        await stage("public-read", { url });
        return { buffer: fileBytes, contentType: "image/png" };
      },
      fetch: async () => { throw new Error("Real external requests are forbidden"); },
      TEMP_ROOT: path.resolve("fixture-cropper"), GENERATED_ROOT: path.resolve("fixture-generated"), CROPPED_ROOT: path.resolve("fixture-cropped"),
      LISTING_MEDIA_TYPES: new Map([[".png", "image/png"]]),
      mimeTypeForListingMediaExtension: () => "image/png",
      resolvePreviewAiTaskMedia: async () => { throw new Error("Unexpected private preview fallback"); }
    });
    vm.runInContext("let schema; const LISTING_WATERMARK_CONCURRENCY=1; let activeListingWatermarkJobs=0; const pendingListingWatermarkJobs=[];", context);
    vm.runInContext(declarations("src/services/ai-image-task-ownership.js", ["ensureSchema", "assertAiImageTaskOwner"]), context);
    vm.runInContext(declarations("src/server/services/openai/imageGenerationService.js", ["validateTaskId", "resolveGeneratedTaskDir"]), context);
    vm.runInContext(declarations("src/server/services/ai/aiWorkflowService.js", ["getAiTaskFile", "resolveCroppedTaskDir", "contentTypeFor"]), context);
    vm.runInContext(declarations("src/server/services/tools/imageCropperService.js", ["assertImageCropperTaskOwner", "resolveTaskDir"]), context);
    vm.runInContext(declarations("src/services/listing-automation.js", [
      "watermarkListingMedia", "withListingWatermarkSlot", "processListingMediaWatermark", "listingWatermarkShop", "readListingImageBuffer",
      "listingTenantId", "row", "normalizeArray", "sanitizeListingMediaFilename", "listingShopWatermarkOptions", "clampNumberValue",
      "resolveLocalAiTaskMedia", "resolveLocalImageCropperMedia", "isKnownAppMediaHost", "isListingPathInside"
    ]), context);
    const body = (shop = 20, urls = ["https://fixture.invalid/source.png"]) => ({ shop_id: shop, images: urls });
    const count = name => calls.filter(call => call.name === name).length;
    const noMedia = () => { for (const name of ["read", "public-read", "render", "write", "register"]) assert.equal(count(name), 0, name); };
    const reset = async () => {
      hook = async () => {}; calls.length = timeoutValues.length = 0; fileBytes = Buffer.from("fixture image");
      await query("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at=NULL");
      await query("UPDATE people SET active=1");
      await query("UPDATE tenant_members SET active=1,role='member',business_roles_json=JSON_ARRAY('operations')");
      await query("UPDATE shops SET status='active'");
      await query("UPDATE shops SET tenant_id=2 WHERE id=20");
    };
    const scenario = (name, action) => t.test(name, async () => { await reset(); await action(); });

    await scenario("A/B/default and legacy NULL shops use session identity despite forged body authority", async () => {
      for (const [id, shop] of [[1, 10], [1, 11], [2, 20], [3, 30]]) {
        const result = await context.watermarkListingMedia({ ...body(shop), tenant_id: "3", tenant: { id: 3 }, personId: 8, created_by_person_id: 8 }, session(id));
        assert.equal(result.ok, true); assert.equal(result.shop.id, shop); assert.equal(result.images.length, 1);
      }
      assert.deepEqual(calls.filter(call => call.name === "register").map(({ tenant, person, shop }) => [tenant, person, shop]), [[1, 7, 10], [1, 7, 11], [2, 7, 20], [3, 7, 30]]);
      assert.deepEqual(timeoutValues, [20000, 20000, 20000, 20000]);
    });

    await scenario("foreign shops, legacy NULL shops and deleted shops reject before media I/O", async () => {
      for (const [id, shop] of [[1, 30], [2, 30], [2, 10], [2, 11], [3, 20], [3, 10]]) {
        await assert.rejects(context.watermarkListingMedia({ ...body(shop), tenant_id: "admin" }, session(id)), { status: 404 });
      }
      await query("UPDATE shops SET status='deleted' WHERE id=20");
      await assert.rejects(context.watermarkListingMedia(body(), session(2)), { status: 404 });
      noMedia();
    });

    await scenario("missing membership, stale roles and platform grants cannot manufacture enterprise operations authority", async () => {
      await assert.rejects(context.watermarkListingMedia(body(), null), { statusCode: 403 });
      await assert.rejects(context.watermarkListingMedia(body(), { ...session(2, 8), platform_role: "super_admin" }), { statusCode: 403 });
      for (const id of [1, 2]) {
        await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=? AND person_id=7", [id]);
        await assert.rejects(context.watermarkListingMedia(body(id === 1 ? 10 : 20), { ...session(id), platform_role: "super_admin" }), { statusCode: 403 });
      }
      noMedia();
    });

    const revocations = [
      ["operations duty", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=7"],
      ["membership", "UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7"],
      ["person", "UPDATE people SET active=0 WHERE id=7"],
      ["subscription", "UPDATE tenants SET subscription_status='suspended' WHERE id=2"],
      ["expired subscription", "UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2"]
    ];
    for (const [name, sql] of revocations) await scenario(`${name} revoked before request stops watermarking`, async () => {
      await query(sql);
      await assert.rejects(context.watermarkListingMedia(body(), session(2)), { statusCode: 403 }); noMedia();
    });

    await scenario("the internal processor independently rejects stale authority and foreign shops", async () => {
      await assert.rejects(context.processListingMediaWatermark(body(30), session(2)), { status: 404 });
      await query(revocations[0][1]);
      await assert.rejects(context.processListingMediaWatermark(body(), session(2)), { statusCode: 403 });
      noMedia();
    });

    await scenario("a job waiting for the serial slot rechecks authorization after it is released", async () => {
      vm.runInContext("activeListingWatermarkJobs=1", context);
      const pending = context.watermarkListingMedia(body(), session(2));
      // Attach rejection handling before revoking a queued operation.
      const rejection = assert.rejects(pending, { statusCode: 403 });
      for (let attempt = 0; attempt < 1000 && !vm.runInContext("pendingListingWatermarkJobs.length", context); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(vm.runInContext("pendingListingWatermarkJobs.length", context), 1);
      await query(revocations[0][1]);
      vm.runInContext("activeListingWatermarkJobs=0; pendingListingWatermarkJobs.shift()()", context);
      await rejection; noMedia();
      assert.equal(vm.runInContext("activeListingWatermarkJobs", context), 0);
    });

    await scenario("the public-image beforeRequest hook rechecks fresh authority before network bytes", async () => {
      hook = async name => { if (name === "before-public-request") await query(revocations[0][1]); };
      await assert.rejects(context.watermarkListingMedia(body(), session(2)), { statusCode: 403 });
      assert.equal(count("before-public-request"), 1); noMedia(); assert.deepEqual(timeoutValues, [20000]);
    });

    for (const [name, sql] of [...revocations, ["shop ownership", "UPDATE shops SET tenant_id=3 WHERE id=20"], ["shop deletion", "UPDATE shops SET status='deleted' WHERE id=20"]]) {
      await scenario(`${name} revoked while image bytes are read prevents rendering, writing and registration`, async () => {
        hook = async stage => { if (stage === "public-read") await query(sql); };
        await assert.rejects(context.watermarkListingMedia(body(), session(2)), error => [403, 404].includes(error.statusCode || error.status));
        assert.equal(count("public-read"), 1);
        for (const name of ["render", "write", "register"]) assert.equal(count(name), 0, name);
      });
    }

    await scenario("authority revoked during image optimization prevents durable writes", async () => {
      hook = async name => { if (name === "optimize") await query(revocations[0][1]); };
      await assert.rejects(context.watermarkListingMedia(body(), session(2)), { statusCode: 403 });
      assert.equal(count("render"), 1); assert.equal(count("write"), 0); assert.equal(count("register"), 0);
    });

    await scenario("authority revoked during storage prevents asset registration and the next image", async () => {
      hook = async name => { if (name === "write") await query(revocations[1][1]); };
      await assert.rejects(context.watermarkListingMedia(body(20, ["https://fixture.invalid/1.png", "https://fixture.invalid/2.png"]), session(2)), { statusCode: 403 });
      assert.equal(count("public-read"), 1, JSON.stringify(calls)); assert.equal(count("write"), 1, JSON.stringify(calls)); assert.equal(count("register"), 0);
    });

    await scenario("private AI/cropper image readers use actual SQL ownership before reading or public fallback", async () => {
      for (const url of ["/api/ai/file/task-enterprise-b/generated/result.png", "/api/tools/image-cropper/file/crop-enterprise-b/result.png", "https://erp.hjt888.xyz/api/ai/file/task-enterprise-b/generated/result.png", "https://erp.hjt888.xyz/api/tools/image-cropper/file/crop-enterprise-b/result.png"]) {
        await assert.rejects(context.watermarkListingMedia(body(20, [url]), session(2)), { statusCode: 404 });
      }
      await assert.rejects(context.watermarkListingMedia(body(10, ["/api/ai/file/task-enterprise-b/generated/result.png"]), session(1)), { statusCode: 404 });
      noMedia(); assert.equal(count("before-public-request"), 0);
      for (const [id, shop, url] of [[1, 10, "/api/ai/file/task-default/generated/result.png"], [2, 20, "/api/ai/file/task-enterprise-a/generated/result.png"], [2, 20, "/api/tools/image-cropper/file/crop-enterprise-a/result.png"]]) {
        assert.equal((await context.watermarkListingMedia(body(shop, [url]), session(id))).images.length, 1);
      }
      assert.equal(count("read"), 3); assert.equal(count("register"), 3); assert.equal(count("before-public-request"), 0);
    });

    await scenario("authority revoked while a local image is read prevents rendering and writes", async () => {
      hook = async name => { if (name === "read") await query(revocations[0][1]); };
      await assert.rejects(context.watermarkListingMedia(body(20, ["/uploads/listing-media/source.png"]), session(2)), { statusCode: 403 });
      assert.equal(count("read"), 1); assert.equal(count("render"), 0); assert.equal(count("write"), 0); assert.equal(count("register"), 0);
    });

    await scenario("local watermark images must be nonempty and at most 30 MB", async () => {
      for (const buffer of [Buffer.alloc(0), Buffer.alloc(30 * 1024 * 1024 + 1)]) {
        fileBytes = buffer;
        await assert.rejects(context.watermarkListingMedia(body(20, ["/uploads/listing-media/source.png"]), session(2)), /empty or exceeds 30MB/);
      }
      assert.equal(count("render"), 0); assert.equal(count("write"), 0); assert.equal(count("register"), 0);
    });
  } finally {
    try { if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``); }
    finally { await connection.end(); }
  }
});
