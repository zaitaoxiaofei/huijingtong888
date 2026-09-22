import { hasPermission } from "../shared/permissions.js";
import { randomUUID } from "node:crypto";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { inventoryProductNamingOptions, validateVehicleBrand } from "./inventory-product-naming.js";
import { aiVehicleCatalog } from "./ai-vehicle-catalog.js";
import { bindOnlineProductMysql, createProductMysql, createProductFromOnlineProductMysql, normalizeStructuredNamingMysql, prepareInventoryProductCreationMysql } from "./mysql-cutover.js";

export function canReviewInventoryProductRequests(session = {}) {
  return hasPermission(session, "inventory.review");
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function applicantId(session) {
  const id = Number(session?.personId);
  if (!id) fail("请先登录后提交建品申请", 403);
  return id;
}

let ready;
async function ensureSchema() {
  if (!ready) ready = (async () => {
    await prepareInventoryProductCreationMysql();
    await inventoryProductNamingOptions({ type: "category" });
    await aiVehicleCatalog();
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS inventory_product_requests (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      request_key VARCHAR(64) NOT NULL,
      applicant_id BIGINT NOT NULL,
      applicant_name VARCHAR(255) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      payload_json LONGTEXT NOT NULL,
      new_options_json JSON NOT NULL,
      review_note VARCHAR(1000) NOT NULL DEFAULT '',
      reviewer_id BIGINT NULL,
      product_id BIGINT NULL,
      binding_status VARCHAR(16) NOT NULL DEFAULT 'none',
      binding_error VARCHAR(1000) NOT NULL DEFAULT '',
      revision INT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      UNIQUE KEY uk_inventory_request_key (applicant_id, request_key),
      KEY idx_inventory_request_status (status, id),
      KEY idx_inventory_request_applicant (applicant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  })().catch(error => { ready = null; throw error; });
  await ready;
}

function parseJson(value) { return typeof value === "string" ? JSON.parse(value) : value; }

export function normalizeInventoryRequestPayload(body, session) {
  const payload = { ...body, structured_naming: { ...(body.structured_naming || body.structuredNaming) } };
  if (payload.structured_naming.vehicle_brand) payload.structured_naming.vehicle_brand = validateVehicleBrand(payload.structured_naming.vehicle_brand);
  const naming = normalizeStructuredNamingMysql(payload);
  if (!naming) fail("缺少产品身份（structured_naming），请在创建库存中填写核心品名和规格");
  if (!Number(payload.owner_person_id)) fail("缺少商品负责人（owner_person_id），请在创建库存中选择负责人");
  delete payload.id;
  delete payload.request_id;
  delete payload.request_key;
  payload.name = naming.name;
  payload.product_type = "main";
  payload.selection_status = "listed";
  payload.created_by_person_id = applicantId(session);
  return { payload, naming };
}

export function inventoryRequestOptions(naming) {
  return [
    ["category", "核心品名", naming.category], ["brand", "汽车品牌", naming.vehicleBrand],
    ["accessory", "款式", naming.accessory],
    ...naming.colors.map(value => ["color", "颜色", value]),
    ...naming.materials.map(value => ["material", "材质", value]),
    ["process", "工艺", naming.surfaceProcess],
    ...naming.vehicleModels.map(value => ["vehicle_model", "车型", value])
  ].filter(([, , value]) => value).map(([type, label, value]) => ({ type, label, value }));
}

async function newOptions(naming) {
  const fields = { category: "inventory_category", brand: "vehicle_brand", accessory: "accessory_name", color: "color", material: "material", process: "surface_process" };
  const checks = inventoryRequestOptions(naming).map(async (option) => {
    if (option.type === "vehicle_model") {
      const models = await mysqlQuery("SELECT id FROM ai_vehicle_catalog WHERE enabled = 1 AND brand_name = ? AND model_name = ? LIMIT 1", [naming.vehicleBrand, option.value]);
      return models.length ? null : { ...option, brand: naming.vehicleBrand };
    }
    const dict = await mysqlQuery("SELECT id, status FROM inventory_product_naming_options WHERE option_type = ? AND value = ? LIMIT 1", [option.type, option.value]);
    if (dict[0]?.status === "active") return null;
    // A pending/archived dictionary entry must not be activated by historical product data.
    if (!dict.length) {
      if (option.type === "brand") {
        const brands = await mysqlQuery("SELECT id FROM ai_vehicle_catalog WHERE enabled = 1 AND brand_name = ? LIMIT 1", [option.value]);
        if (brands.length) return null;
      }
      const field = fields[option.type];
      const predicate = ["color", "material"].includes(option.type)
        ? `FIND_IN_SET(?, REPLACE(REPLACE(REPLACE(${field}, '/', ','), '，', ','), '、', ',')) > 0`
        : `${field} = ?`;
      const existing = await mysqlQuery(`SELECT id FROM products WHERE active = 1 AND (product_type <> 'selection' OR selection_status = 'listed') AND ${predicate} LIMIT 1`, [option.value]);
      if (existing.length) return null;
    }
    return option;
  });
  return (await Promise.all(checks)).filter(Boolean);
}

function requestResult(row) {
  return { status: row.status, request_id: Number(row.id), product_id: row.product_id ? Number(row.product_id) : null, binding_status: row.binding_status, binding_error: row.binding_error || "" };
}

export async function submitInventoryProductRequest(body = {}, session = {}) {
  await ensureSchema();
  const personId = applicantId(session);
  const key = String(body.request_key || randomUUID());
  if (key.length > 64) fail("建品提交标识无效，请重新打开创建窗口");
  const previous = await mysqlQuery("SELECT * FROM inventory_product_requests WHERE applicant_id = ? AND request_key = ?", [personId, key]);
  if (previous[0]) return requestResult(previous[0]);
  const { payload, naming } = normalizeInventoryRequestPayload(body, session);
  const options = await newOptions(naming);
  if (!options.length) {
    const created = payload.online_product_id ? await createProductFromOnlineProductMysql(payload) : await createProductMysql(payload);
    return created;
  }
  await mysqlExecute(`INSERT INTO inventory_product_requests
    (request_key, applicant_id, applicant_name, payload_json, new_options_json)
    VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
  [key, personId, String(session.name || ""), JSON.stringify(payload), JSON.stringify(options)]);
  const rows = await mysqlQuery("SELECT * FROM inventory_product_requests WHERE applicant_id = ? AND request_key = ?", [personId, key]);
  return requestResult(rows[0]);
}

export async function inventoryProductRequests(query = {}, session = {}) {
  await ensureSchema();
  const personId = applicantId(session);
  const where = [], params = [];
  if (!canReviewInventoryProductRequests(session)) { where.push("r.applicant_id = ?"); params.push(personId); }
  if (["pending", "returned", "approved"].includes(query.status)) { where.push("r.status = ?"); params.push(query.status); }
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = 20;
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totals = await mysqlQuery(`SELECT COUNT(*) AS total FROM inventory_product_requests r ${clause}`, params);
  const rows = await mysqlQuery(`SELECT r.id, r.applicant_id, r.applicant_name, r.status, r.new_options_json,
    r.review_note, r.product_id, r.binding_status, r.binding_error, r.revision, r.created_at, r.updated_at,
    JSON_UNQUOTE(JSON_EXTRACT(r.payload_json, '$.name')) AS name,
    JSON_UNQUOTE(JSON_EXTRACT(r.payload_json, '$.image_url')) AS image_url
    FROM inventory_product_requests r ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { rows: rows.map(row => ({ ...row, new_options: parseJson(row.new_options_json) })), total: Number(totals[0]?.total || 0), can_review: canReviewInventoryProductRequests(session) };
}

export async function inventoryProductRequestDetail(id, session = {}) {
  await ensureSchema();
  const rows = await mysqlQuery("SELECT * FROM inventory_product_requests WHERE id = ?", [Number(id)]);
  const row = rows[0];
  if (!row) fail("建品申请不存在", 404);
  if (!canReviewInventoryProductRequests(session) && Number(row.applicant_id) !== applicantId(session)) fail("只能查看自己的建品申请", 403);
  return { ...row, payload: parseJson(row.payload_json), new_options: parseJson(row.new_options_json) };
}

async function finishBinding(row) {
  if (row.binding_status === "none" || row.binding_status === "bound") return requestResult(row);
  const payload = parseJson(row.payload_json);
  try {
    const mappings = await mysqlQuery(`SELECT sm.product_id FROM sku_mappings sm
      JOIN online_products op ON op.shop_id = sm.shop_id
      WHERE op.id = ? AND sm.ozon_sku = COALESCE(NULLIF(?, ''), op.ozon_sku) AND sm.active = 1 AND sm.product_id IS NOT NULL`,
    [payload.online_product_id, payload.ozon_sku || ""]);
    if (mappings.some(item => Number(item.product_id) !== Number(row.product_id))) fail("该订单 SKU 已绑定其他库存，请在订单库存绑定处核对后重试");
    await bindOnlineProductMysql({ ...payload, product_id: row.product_id, person_id: payload.owner_person_id });
    await mysqlExecute("UPDATE inventory_product_requests SET binding_status = 'bound', binding_error = '' WHERE id = ?", [row.id]);
    return requestResult({ ...row, binding_status: "bound", binding_error: "" });
  } catch (error) {
    const message = String(error.message || "订单绑定失败").slice(0, 1000);
    await mysqlExecute("UPDATE inventory_product_requests SET binding_status = 'failed', binding_error = ? WHERE id = ?", [message, row.id]);
    return requestResult({ ...row, binding_status: "failed", binding_error: message });
  }
}

export async function reviewInventoryProductRequest(id, body = {}, session = {}) {
  await ensureSchema();
  const personId = applicantId(session);
  const action = body.action;
  if (!["approve", "return", "resubmit", "retry_binding"].includes(action)) fail("不支持的建品申请操作");
  if (action !== "resubmit" && !canReviewInventoryProductRequests(session)) fail("仅库存审批人员（经理或管理员）可以审核建品申请", 403);
  const result = await withMysqlTransaction(async connection => {
    const [rows] = await connection.query("SELECT * FROM inventory_product_requests WHERE id = ? FOR UPDATE", [Number(id)]);
    const row = rows[0];
    if (!row) fail("建品申请不存在", 404);
    if (action === "resubmit" && Number(row.applicant_id) !== personId) fail("只能修改自己的建品申请", 403);
    if (row.status === "approved" && ["approve", "retry_binding"].includes(action)) return row;
    if (action === "retry_binding") fail("只有已通过的建品申请可以重试订单绑定");
    if (action === "resubmit" ? row.status !== "returned" : row.status !== "pending") fail("申请状态已变化，请刷新后重试");
    if (Number(body.revision) !== Number(row.revision)) fail("申请内容已被修改，请刷新后重新审核", 409);
    const note = String(body.review_note || "").trim().slice(0, 1000);
    if (action === "return") {
      if (!note) fail("请填写退回原因，说明缺少的业务信息和修改位置");
      await connection.execute("UPDATE inventory_product_requests SET status = 'returned', review_note = ?, reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?", [note, personId, row.id]);
      return { ...row, status: "returned" };
    }
    const original = parseJson(row.payload_json);
    // Source order and applicant identity cannot be changed by editing the form.
    const candidate = { ...(body.payload || original), online_product_id: original.online_product_id, order_item_id: original.order_item_id, ozon_sku: original.ozon_sku };
    const { payload, naming } = normalizeInventoryRequestPayload(candidate, { personId: row.applicant_id });
    const options = await newOptions(naming);
    if (action === "resubmit") {
      await connection.execute("UPDATE inventory_product_requests SET status = 'pending', payload_json = ?, new_options_json = ?, revision = revision + 1 WHERE id = ?", [JSON.stringify(payload), JSON.stringify(options), row.id]);
      return { ...row, status: "pending" };
    }
    for (const option of inventoryRequestOptions(naming)) {
      if (option.type === "vehicle_model") {
        const key = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
        await connection.execute(`INSERT INTO ai_vehicle_catalog (brand_key, brand_name, model_key, model_name, source, created_by_person_id)
          VALUES (?, ?, ?, ?, 'user', ?) ON DUPLICATE KEY UPDATE enabled = 1, updated_at = CURRENT_TIMESTAMP`,
        [key(naming.vehicleBrand), naming.vehicleBrand, key(option.value), option.value, row.applicant_id]);
        continue;
      }
      await connection.execute(`INSERT INTO inventory_product_naming_options (option_type, value, label, status, reviewed_by_person_id, reviewed_at)
        VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE status = 'active', reviewed_by_person_id = VALUES(reviewed_by_person_id), reviewed_at = CURRENT_TIMESTAMP`, [option.type, option.value, option.value, personId]);
    }
    let product;
    // Savepoint allows an identical existing product to be selected without leaving a partial insert.
    await connection.query("SAVEPOINT inventory_request_product");
    try {
      product = await createProductMysql(payload, connection);
    } catch (error) {
      const duplicateId = Number(String(error.message).match(/已存在相同标准产品：[\s\S]*（#(\d+)）/)?.[1]);
      if (!duplicateId || Number(body.reuse_product_id) !== duplicateId) throw error;
      await connection.query("ROLLBACK TO SAVEPOINT inventory_request_product");
      const [products] = await connection.query("SELECT id FROM products WHERE id = ? AND active = 1 AND (product_type <> 'selection' OR selection_status = 'listed')", [duplicateId]);
      if (!products.length) fail("相同产品尚未进入正式库存，请先处理该产品");
      product = { id: duplicateId };
    }
    const bindingStatus = payload.online_product_id ? "pending" : "none";
    await connection.execute(`UPDATE inventory_product_requests SET status = 'approved', payload_json = ?, new_options_json = ?, product_id = ?, binding_status = ?,
      reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?`,
    [JSON.stringify(payload), JSON.stringify(options), product.id, bindingStatus, personId, note, row.id]);
    return { ...row, status: "approved", payload_json: JSON.stringify(payload), product_id: product.id, binding_status: bindingStatus };
  });
  return result.status === "approved" ? finishBinding(result) : requestResult(result);
}
