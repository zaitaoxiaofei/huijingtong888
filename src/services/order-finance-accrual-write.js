import { getOrderProfitDailyFxById } from "./order-profit-daily-fx.js";
import { moneyToCny, validateDailyFxSnapshot } from "./profit-formulas/v2/fx.js";
import { OZON_DAILY_ACCRUAL_ENDPOINT } from "./ozon-finance-accruals.js";

const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });
const rowsOf = value => Array.isArray(value?.[0]) ? value[0] : value;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const moneyFields = ["amount", "accruals_for_sale", "sale_commission", "delivery_charge", "return_delivery_charge"];
const columns = ["shop_id", "operation_id", "posting_number", "order_number", "operation_type", "operation_type_name", "operation_date",
  "service_type", "service_name", ...moneyFields, "currency_code", "raw_json", ...moneyFields.map(field => `${field}_cny`), "exchange_rate"];
const numericColumns = new Set([...moneyFields, ...moneyFields.map(field => `${field}_cny`), "exchange_rate"]);

function number(value, label) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(Number(value)) || Math.abs(Number(value)) >= 1e14) {
    throw fail("ORDER_FINANCE_ACCRUAL_AMOUNT_INVALID", `${label}金额缺失或超出台账精度，停止导入该计提记录`);
  }
  return Number(value);
}
const fixed = value => number(value, "财务").toFixed(4);
function tenant(value) {
  if (value === null || value === 0 || value === "0") return "admin";
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw fail("ORDER_FINANCE_SHOP_SCOPE_INVALID", "店铺企业归属缺失或无效，停止财务写入");
  return String(Number(value));
}
function text(value, max, label) {
  const result = String(value ?? "");
  if (result.length > max) throw fail("ORDER_FINANCE_ACCRUAL_FIELD_INVALID", `${label}超出台账字段长度，停止导入该计提记录`);
  return result;
}
function rawEnvelope(operation) {
  let raw;
  try { raw = typeof operation.raw_json === "string" ? JSON.parse(operation.raw_json) : operation.raw_json; } catch { /* Refuse unusable evidence. */ }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.raw || typeof raw.raw !== "object"
    || operation.source_endpoint !== OZON_DAILY_ACCRUAL_ENDPOINT || raw._source_endpoint !== OZON_DAILY_ACCRUAL_ENDPOINT) {
    throw fail("ORDER_FINANCE_ACCRUAL_SOURCE_INVALID", "财务计提来源或完整原始记录不匹配，不能按新接口入账");
  }
  const reconciliation = operation.reconciliation || raw._normalization?.reconciliation;
  if (!reconciliation || typeof reconciliation.ok !== "boolean"
    || (raw._normalization?.reconciliation && canonical(raw._normalization.reconciliation) !== canonical(reconciliation))) {
    throw fail("ORDER_FINANCE_ACCRUAL_RECONCILIATION_INVALID", "财务计提缺少一致的原始金额核对结果，停止导入");
  }
  return { ...raw, _normalization: { ...raw._normalization, reconciliation } };
}
function comparable(row, excluded = new Set()) {
  return canonical(Object.fromEntries(columns.filter(key => !excluded.has(key)).map(key => [key,
    numericColumns.has(key) ? fixed(row[key]) : key === "raw_json" ? canonical(JSON.parse(row[key])) : String(row[key] ?? "")])));
}

/** Replace one normalized official operation in its authorized shop only.
 * Network fetch/archive preparation happens before this transaction. Stable
 * service identities retain their primary keys, including monetary corrections.
 */
export async function writeOrderFinanceAccrual({ transaction, shop, operation, fx, assertAuthorized }) {
  if (typeof transaction !== "function" || typeof assertAuthorized !== "function") throw new Error("Finance accrual writes require a transaction and authorization callback");
  if (!shop || !Object.hasOwn(shop, "tenant_id") || !Number.isSafeInteger(Number(shop.id)) || Number(shop.id) <= 0) {
    throw fail("ORDER_FINANCE_SHOP_SCOPE_INVALID", "财务写入需要明确店铺及企业归属");
  }
  const shopId = Number(shop.id), tenantKey = tenant(shop.tenant_id);
  if (!/^accrual_by_day:[1-9]\d*$/.test(String(operation?.operation_id)) || String(operation.operation_id).length > 128) {
    throw fail("ORDER_FINANCE_ACCRUAL_ID_INVALID", "财务计提编号不属于新接口命名空间，停止导入");
  }
  const pinned = validateDailyFxSnapshot(fx, { businessDate: operation.operation_date });
  const envelope = rawEnvelope(operation);
  if (!Array.isArray(operation.rows) || !operation.rows.length) throw fail("ORDER_FINANCE_ACCRUAL_EMPTY", "财务计提没有可保存的原币行，不能清空已有记录");
  const seen = new Set();
  const sourceRows = operation.rows.map(row => {
    const match = /^accrual:(income|commission|collecting_fee|international_transport|platform_delivery|aftersale_loss|other):[a-f0-9]{20}$/.exec(row.service_type || "");
    if (!match || match[1] !== row.normalized_category || seen.has(row.service_type)) throw fail("ORDER_FINANCE_ACCRUAL_ROW_INVALID", "财务计提费用身份缺失、重复或与类别不一致");
    seen.add(row.service_type);
    const amount = number(row.amount, "原币"), gross = number(row.accruals_for_sale, "销售总额");
    if (Number(amount.toFixed(4)) !== amount || Number(gross.toFixed(4)) !== gross) {
      throw fail("ORDER_FINANCE_ACCRUAL_PRECISION_UNSUPPORTED", "原币金额超过现有财务台账四位小数精度，请先核对，未截断原始金额");
    }
    if (row.currency_code !== "CNY" && row.currency_code !== "RUB") throw fail("ORDER_FINANCE_ACCRUAL_CURRENCY_UNKNOWN", `计提 ${operation.operation_id} 的币种未明确为 CNY 或 RUB，停止入账`);
    if ((match[1] !== "income" && gross !== 0) || (match[1] === "income" && gross !== amount)) throw fail("ORDER_FINANCE_ACCRUAL_GROSS_REPEATED", "销售总额只能由收入行保存一次，不能重复附在费用行");
    return { ...row, amount, accruals_for_sale: gross, sale_commission: match[1] === "commission" ? amount : 0,
      delivery_charge: ["platform_delivery", "international_transport"].includes(match[1]) ? amount : 0, return_delivery_charge: match[1] === "aftersale_loss" ? amount : 0 };
  });
  if (sourceRows.filter(row => row.normalized_category === "income").length > 1) throw fail("ORDER_FINANCE_ACCRUAL_GROSS_REPEATED", "一笔计提不能保存多个销售总额收入行");
  if (envelope._normalization.reconciliation.ok && (sourceRows.some(row => row.currency_code !== operation.currency_code)
    || fixed(sourceRows.reduce((sum, row) => sum + row.amount, 0)) !== fixed(operation.amount))) {
    throw fail("ORDER_FINANCE_ACCRUAL_RECONCILIATION_INVALID", "计提拆行与官方净额不一致，不能保存为已核对账单");
  }
  return transaction(async connection => {
    const [lockedShop] = rowsOf(await connection.query("SELECT id, tenant_id, status FROM shops WHERE id = ? FOR UPDATE", [shopId]));
    if (!lockedShop || tenant(lockedShop.tenant_id) !== tenantKey || lockedShop.status !== "active") {
      throw fail("ORDER_FINANCE_SHOP_SCOPE_INVALID", "店铺不存在、已停用或企业归属已改变，停止财务写入");
    }
    await assertAuthorized({ connection, shop: lockedShop });
    const [legacyDay] = rowsOf(await connection.query(`SELECT id FROM ozon_finance_items
      WHERE shop_id=? AND operation_date>=? AND operation_date<DATE_ADD(?, INTERVAL 1 DAY)
        AND LEFT(operation_id,15)<>'accrual_by_day:' LIMIT 1 FOR UPDATE`,
    [shopId, `${pinned.business_date} 00:00:00`, `${pinned.business_date} 00:00:00`]));
    if (legacyDay) throw fail("ORDER_FINANCE_ACCRUAL_LEGACY_DAY_CONFLICT", "该店铺同一财务日期已有旧接口记录，请先核对跨接口重复，未导入新计提或删除旧记录");
    const storedFx = await getOrderProfitDailyFxById(connection, pinned.id);
    if (!storedFx || ["id", "business_date", "source_date", "currency_from", "currency_to", "source"].some(key => String(storedFx[key]) !== String(pinned[key]))
      || Number(storedFx.rate) !== pinned.rate) throw fail("ORDER_FINANCE_FX_ARCHIVE_MISMATCH", "财务操作日汇率与已存档记录不一致，停止入账");
    const rawJson = canonical({ ...envelope, _erp_fx_archive: storedFx, _erp_source_endpoint: OZON_DAILY_ACCRUAL_ENDPOINT });
    const desired = sourceRows.map(row => ({
      shop_id: shopId, operation_id: operation.operation_id, posting_number: text(operation.posting_number, 128, "货件号"),
      order_number: text(operation.order_number, 128, "订单号"), operation_type: text(operation.operation_type, 128, "操作类型"),
      operation_type_name: text(operation.operation_type_name, 255, "操作名称"), operation_date: `${pinned.business_date} 00:00:00`,
      service_type: row.service_type, service_name: text(row.service_name, 255, "费用名称"),
      ...Object.fromEntries(moneyFields.map(field => [field, fixed(row[field])])), currency_code: row.currency_code, raw_json: rawJson,
      ...Object.fromEntries(moneyFields.map(field => [`${field}_cny`, fixed(moneyToCny(row[field], row.currency_code, storedFx, { businessDate: pinned.business_date }))])),
      exchange_rate: fixed(row.currency_code === "RUB" ? storedFx.rate : 1)
    }));
    const existing = rowsOf(await connection.query(`SELECT id, ${columns.filter(key => key !== "operation_date").join(",")},
      DATE_FORMAT(operation_date,'%Y-%m-%d %H:%i:%s') operation_date FROM ozon_finance_items
      WHERE shop_id = ? AND operation_id = ? ORDER BY service_type FOR UPDATE`, [shopId, operation.operation_id]));
    const wanted = new Map(desired.map(row => [row.service_type, row]));
    const old = new Map(existing.map(row => [row.service_type, row]));
    const obsolete = existing.filter(row => !wanted.has(row.service_type));
    const updates = desired.filter(row => old.has(row.service_type) && comparable(old.get(row.service_type)) !== comparable(row));
    const changing = updates.filter(row => comparable(old.get(row.service_type), new Set(["raw_json"])) !== comparable(row, new Set(["raw_json"])));
    const protectedIds = [...new Set([...obsolete.map(row => String(row.id)), ...changing.map(row => String(old.get(row.service_type).id))])];
    const [voucherTable] = protectedIds.length ? rowsOf(await connection.query(`SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='finance_vouchers'`)) : [];
    const references = voucherTable ? rowsOf(await connection.query(`SELECT id, finance_item_id FROM finance_vouchers
      WHERE finance_item_id IN (${protectedIds.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`, protectedIds)) : [];
    const referenced = new Set(references.map(row => String(row.finance_item_id)));
    if (obsolete.some(row => referenced.has(String(row.id))) || updates.some(row => referenced.has(String(old.get(row.service_type).id))
      && comparable(old.get(row.service_type), new Set(["raw_json"])) !== comparable(row, new Set(["raw_json"])))) {
      throw fail("ORDER_FINANCE_VOUCHER_REVIEW_REQUIRED", "计提修订影响已关联凭证的财务行，请先核对凭证，未删除或修改原记录");
    }
    await assertAuthorized({ connection, shop: lockedShop });
    for (const row of obsolete) await connection.query("DELETE FROM ozon_finance_items WHERE id = ? AND shop_id = ? AND operation_id = ?", [row.id, shopId, operation.operation_id]);
    const updateColumns = columns.filter(key => !["shop_id", "operation_id", "service_type"].includes(key));
    for (const row of updates) await connection.query(`UPDATE ozon_finance_items SET ${updateColumns.map(key => `${key}=?`).join(",")},
      synced_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND operation_id=?`, [...updateColumns.map(key => row[key]), old.get(row.service_type).id, shopId, operation.operation_id]);
    const added = desired.filter(row => !old.has(row.service_type));
    for (const row of added) await connection.query(`INSERT INTO ozon_finance_items (${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")})`, columns.map(key => row[key]));
    return { operation_id: operation.operation_id, rows: desired.length, inserted: added.length, updated: updates.length,
      deleted: obsolete.length, unchanged: desired.length - added.length - updates.length, reconciled: envelope._normalization.reconciliation.ok };
  });
}
