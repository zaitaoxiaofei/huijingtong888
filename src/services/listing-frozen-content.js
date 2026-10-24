import { createHash } from "node:crypto";

export const LISTING_FROZEN_CONTENT_SCHEMA = `CREATE TABLE IF NOT EXISTS listing_frozen_content (
  tenant_id VARCHAR(80) NOT NULL,
  content_kind VARCHAR(32) NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, content_kind, content_hash)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

const MARKER = "_listing_frozen_content_v1";
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const readScopes = new WeakMap();

// A full review may contain many children of the same immutable master. Cache
// verified versions only for that request, never across requests or tenants.
export function createListingFrozenReadScope(query) {
  const scoped = (sql,params) => query(sql,params);
  readScopes.set(scoped,new Map());
  return scoped;
}

function jsonValue(value, depth = 0) {
  if (depth > 64) throw new Error("Frozen listing content is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item === undefined ? null : item, depth + 1));
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]" || prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error("Frozen listing content must contain JSON values only");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (unsafeKeys.has(key)) throw new Error("Unsafe frozen listing content key");
    if (value[key] === undefined) continue; // Same persistence semantics as JSON.stringify.
    output[key] = jsonValue(value[key], depth + 1);
  }
  return output;
}

function canonical(value) {
  const text = JSON.stringify(jsonValue(value));
  if (Buffer.byteLength(text) > MAX_CONTENT_BYTES) throw new Error("Frozen listing content exceeds 8 MiB");
  return text;
}

function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function ownedTenant(value) {
  const id = String(value || "");
  if (!/^(?:admin|[1-9][0-9]*)$/.test(id)) throw new Error("Explicit enterprise storage ID required");
  return id;
}

export function listingFrozenDraftWriteTenants() {
  const tenants=String(process.env.LISTING_FROZEN_DRAFT_TENANTS || "").split(",").map(value=>value.trim()).filter(Boolean);
  if (tenants.some(value=>!/^(?:admin|[1-9][0-9]*)$/.test(value))) throw Object.assign(new Error("草稿冻结存储企业开通配置无效，请检查 LISTING_FROZEN_DRAFT_TENANTS"),{statusCode:503});
  return [...new Set(tenants)];
}

export async function assertListingFrozenContentReady(query, { required = listingFrozenDraftWriteTenants().length > 0 } = {}) {
  const refuse = (message) => { throw Object.assign(new Error(`草稿冻结存储结构未就绪：${message}。请运行 scripts/migrate-listing-frozen-content.mjs 检查后再开通新写入`),{statusCode:503}); };
  const [table]=await query("SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='listing_frozen_content'");
  if (!table) {
    if (required) refuse("缺少 listing_frozen_content");
    return {ready:true,exists:false,reader_version:1};
  }
  if (String(table.engine).toUpperCase()!=="INNODB") refuse("必须使用 InnoDB");
  const columns=await query("SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='listing_frozen_content'");
  for (const [name,type] of [["tenant_id","varchar(80)"],["content_kind","varchar(32)"],["content_hash","char(64)"],["payload_json","mediumtext"]]) {
    const column=columns.find(item=>item.name===name);
    if (!column || column.type.toLowerCase()!==type || column.nullable!=="NO") refuse(`${name} 类型或非空约束不匹配`);
    if (name==="content_hash" && (column.charset!=="ascii" || column.collation_name!=="ascii_bin")) refuse("内容哈希需要 ascii_bin");
  }
  const indexes=await query("SELECT INDEX_NAME AS name,COLUMN_NAME AS column_name,SUB_PART AS prefix_length,NON_UNIQUE AS non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='listing_frozen_content' ORDER BY INDEX_NAME,SEQ_IN_INDEX");
  const primary=indexes.filter(item=>item.name==="PRIMARY");
  if (primary.length!==3 || primary.some((item,index)=>item.column_name!==["tenant_id","content_kind","content_hash"][index] || item.prefix_length!=null)) refuse("需要企业、内容类型与哈希组成的主键");
  if (indexes.some(item=>item.name!=="PRIMARY" && Number(item.non_unique)===0)) refuse("不允许额外唯一约束限制不同企业或不同内容版本；请审阅异常索引");
  return {ready:true,exists:true,reader_version:1};
}
function contentHash(value) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw new Error("Invalid frozen listing content reference");
  return value;
}
function missingContent() { return Object.assign(new Error("Frozen listing content unavailable in this enterprise"), { statusCode: 404 }); }

function assertCategory(payload, category) {
  const editable = payload.editable_payload || {};
  const key = String(payload.ozon_category_id || editable.ozon_category_id || editable.category_id || "");
  const [keyCategory,keyType] = key.split(":").map(Number);
  const description = Number(payload.description_category_id || editable.description_category_id || keyCategory);
  const type = Number(payload.type_id || editable.type_id || keyType);
  if (description !== category.description_category_id || type !== category.type_id) throw new Error("Listing payload category differs from its frozen official definition");
}

async function readVersion(query, tenantId, kind, reference) {
  contentHash(reference);
  const cache=readScopes.get(query),key=`${tenantId}:${kind}:${reference}`;
  if (cache?.has(key)) return cache.get(key);
  const pending=(async()=>{
    const [row] = await query("SELECT payload_json FROM listing_frozen_content WHERE tenant_id = ? AND content_kind = ? AND content_hash = ?", [tenantId, kind, reference]);
    if (!row) throw missingContent();
    const payload = typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    if (hash(payload) !== reference) throw new Error("Frozen listing content checksum mismatch");
    return payload;
  })();
  cache?.set(key,pending);
  try { return await pending; } catch(error) { cache?.delete(key);throw error; }
}

async function insertVersion(query, tenantId, kind, payload) {
  const text = canonical(payload), reference = hash(payload);
  // Existing immutable content is never overwritten, even on a hash/key clash.
  await query("INSERT IGNORE INTO listing_frozen_content (tenant_id,content_kind,content_hash,payload_json) VALUES (?,?,?,?)", [tenantId,kind,reference,text]);
  if (canonical(await readVersion(query,tenantId,kind,reference)) !== text) throw new Error("Frozen listing content collision");
  return reference;
}

// The only public writer reads official platform metadata itself. It never
// accepts a product payload, title, selected values, images or enterprise notes.
export async function freezeListingCategoryDefinition(query, { descriptionCategoryId, typeId } = {}) {
  for (const id of [descriptionCategoryId,typeId]) if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Valid Ozon category and type IDs required");
  const attributes = await query(`SELECT attribute_id,name,name_zh,description,is_required,attribute_type,dictionary_id,is_collection,group_name,sort_order
    FROM ozon_category_attributes WHERE description_category_id = ? AND type_id = ? AND status = 'active' ORDER BY attribute_id`, [descriptionCategoryId,typeId]);
  if (!attributes.length) throw new Error("Official category definitions are not cached; synchronize the category before freezing it");
  const payload = { description_category_id: descriptionCategoryId, type_id: typeId, attributes: attributes.map((item) => ({
    attribute_id: Number(item.attribute_id), name: String(item.name || ""), name_zh: String(item.name_zh || ""),
    description: String(item.description || ""), required: Boolean(Number(item.is_required)), type: String(item.attribute_type || ""),
    dictionary_id: Number(item.dictionary_id || 0), collection: Boolean(Number(item.is_collection)), group_name: String(item.group_name || ""), sort_order: Number(item.sort_order || 0)
  })) };
  return { kind: "category_definition", hash: await insertVersion(query,"public","category_definition",payload) };
}

// This is an internal storage boundary. The calling business service must
// authorize its actor, source products and media before persisting a master.
export async function freezeEnterpriseListingMaster(query, { tenantId, categoryHash, payload } = {}) {
  const owner = ownedTenant(tenantId);
  const category = await readVersion(query,"public","category_definition",categoryHash);
  if (!payload || Array.isArray(payload) || typeof payload !== "object" || Object.hasOwn(payload,MARKER)) throw new Error("A complete private listing master payload is required");
  assertCategory(payload,category);
  const content = { category_hash: categoryHash, payload: jsonValue(payload) };
  return { kind: "product_master", hash: await insertVersion(query,owner,"product_master",content), category_hash: categoryHash };
}

function equal(a,b) { return canonical(a) === canonical(b); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function diff(base, desired, path = [], operations = []) {
  if (equal(base,desired)) return operations;
  if (Array.isArray(base) && Array.isArray(desired) && base.length === desired.length) {
    for (let index=0;index<base.length;index++) diff(base[index],desired[index],[...path,String(index)],operations);
  } else if (object(base) && object(desired)) {
    for (const key of Object.keys(base)) if (!Object.hasOwn(desired,key)) operations.push({ remove: [...path,key] });
    for (const key of Object.keys(desired)) {
      if (!Object.hasOwn(base,key)) operations.push({ set: [...path,key], value: desired[key] });
      else diff(base[key],desired[key],[...path,key],operations);
    }
  } else operations.push({ set: path, value: desired });
  return operations;
}

function patch(base, operations) {
  if (!Array.isArray(operations) || operations.length > 20000) throw new Error("Invalid frozen listing patch");
  let output = jsonValue(base);
  for (const operation of operations) {
    if (!object(operation)) throw new Error("Invalid frozen listing patch operation");
    const removing = Object.hasOwn(operation,"remove");
    const path = removing ? operation.remove : operation.set;
    if (!Array.isArray(path) || path.length > 64 || path.some((key) => typeof key !== "string" || unsafeKeys.has(key))) throw new Error("Invalid frozen listing patch path");
    if (!path.length) {
      if (removing) throw new Error("Cannot remove the listing payload root");
      output = jsonValue(operation.value);continue;
    }
    let parent = output;
    for (const key of path.slice(0,-1)) {
      if ((!object(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent,key)) throw new Error("Frozen listing patch parent is missing");
      parent = parent[key];
    }
    const last = path.at(-1);
    // Array resizing is one whole-array replacement; element edits may address
    // only an existing numeric index, never length/properties or sparse holes.
    if (Array.isArray(parent)) {
      if (removing || !/^(?:0|[1-9][0-9]*)$/.test(last) || Number(last) >= parent.length) throw new Error("Invalid frozen listing array patch");
    } else if (!object(parent)) throw new Error("Frozen listing patch parent is not an object");
    if (removing) delete parent[last]; else parent[last] = jsonValue(operation.value);
  }
  return output;
}

function projections(payload) {
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value || {},key)).map((key) => [key,value[key]]));
  const imageKeys = ["images","primary_image","cover_image","main_image"];
  const priceKeys = ["price","price_value","priceValue"];
  const result = pick(payload,[...imageKeys,...priceKeys,"category_name","template_name","ozon_category_id"]);
  if (Object.hasOwn(payload,"variants")) result.variants = Array.isArray(payload.variants) ? payload.variants.map((item) => pick(item,[...imageKeys,...priceKeys,"id","variant_id","images_manually_edited","image_edit_intent"])) : payload.variants;
  if (payload.editable_payload) {
    result.editable_payload = pick(payload.editable_payload,[...imageKeys,...priceKeys]);
    if (Object.hasOwn(payload.editable_payload,"variants")) result.editable_payload.variants = Array.isArray(payload.editable_payload.variants) ? payload.editable_payload.variants.map((item) => pick(item,[...imageKeys,...priceKeys,"id","variant_id","images_manually_edited","image_edit_intent"])) : payload.editable_payload.variants;
  }
  return jsonValue(result);
}

export async function encodeFrozenListingDraftPayload(query, { tenantId, masterHash, payload } = {}) {
  const owner = ownedTenant(tenantId), master = await readVersion(query,owner,"product_master",masterHash);
  const desired = jsonValue(payload);
  if (!object(desired) || Object.hasOwn(desired,MARKER)) throw new Error("A complete listing draft payload is required");
  assertCategory(desired,await readVersion(query,"public","category_definition",master.category_hash));
  const operations = diff(master.payload,desired);
  if (operations.length > 20000) throw new Error("Frozen listing patch exceeds the supported change count");
  return {
    // Keep this first in the LONGTEXT envelope. Overview label/filter SQL can
    // check the bounded prefix without JSON-parsing a large legacy snapshot.
    [MARKER]: { master_hash: masterHash, category_hash: master.category_hash, payload_hash: hash(desired), operations },
    ...projections(desired)
  };
}

export async function assembleFrozenListingDraftPayload(query, { tenantId, storedPayload } = {}) {
  const owner = ownedTenant(tenantId), stored = jsonValue(storedPayload);
  // Existing drafts do not depend on the new table or a live mutable template.
  if (!object(stored) || !Object.hasOwn(stored,MARKER)) return stored;
  const envelope = stored[MARKER], master = await readVersion(query,owner,"product_master",envelope.master_hash);
  if (master.category_hash !== envelope.category_hash) throw new Error("Frozen listing category reference mismatch");
  await readVersion(query,"public","category_definition",envelope.category_hash);
  const payload = patch(master.payload,envelope.operations);
  if (hash(payload) !== envelope.payload_hash || !equal(projections(payload),Object.fromEntries(Object.entries(stored).filter(([key]) => key !== MARKER)))) throw new Error("Frozen listing payload or media projection mismatch");
  return payload;
}

export async function assembleListingDraftStoredRow(query, { tenantId, row } = {}) {
  if (!row) return row;
  const owner=ownedTenant(tenantId);
  if (Object.hasOwn(row,"tenant_id") && String(row.tenant_id ?? "admin") !== owner) throw missingContent();
  const stored=typeof row.template_payload_json === "string" ? JSON.parse(row.template_payload_json || "null") : row.template_payload_json;
  if (!object(stored) || !Object.hasOwn(stored,MARKER)) return row;
  const payload=await assembleFrozenListingDraftPayload(query,{tenantId:owner,storedPayload:stored});
  // Display/search metadata belongs to the same immutable draft definition.
  // A later rename or deletion of the live local template must not relabel it.
  const labels=Object.fromEntries(["category_name","template_name","ozon_category_id"].map(key=>[key,payload[key] ?? ""]));
  return {...row,...labels,template_payload_json:JSON.stringify(payload),frozen_content_version:{master_hash:stored[MARKER].master_hash,category_hash:stored[MARKER].category_hash}};
}
