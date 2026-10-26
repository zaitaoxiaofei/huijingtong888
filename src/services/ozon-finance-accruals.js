import { createHash } from "node:crypto";

export const OZON_DAILY_ACCRUAL_ENDPOINT = "/v1/finance/accrual/by-day";
export const OZON_ACCRUAL_TYPES_ENDPOINT = "/v1/finance/accrual/types";
const SCALE = 10n ** 12n;
const own = (value, key) => value && Object.hasOwn(value, key);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash("sha256").update(value).digest("hex").slice(0, 20);
const supportedCurrencies = new Set(["CNY", "RUB"]);

function identifier(value) {
  if ((typeof value === "number" && !Number.isSafeInteger(value)) || !/^[1-9]\d*$/.test(String(value))) {
    throw error("OZON_ACCRUAL_ID_INVALID", "Official accrual IDs must be lossless positive integers");
  }
  return String(value);
}

function day(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error("OZON_ACCRUAL_DATE_INVALID", "Official accrual date is missing or invalid");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw error("OZON_ACCRUAL_DATE_INVALID", "Official accrual date is invalid");
  return value;
}

function monetary(value) {
  if (!object(value) || !["number", "string"].includes(typeof value.amount) || typeof value.currency !== "string") return null;
  const text = String(value.amount).trim();
  const currency = value.currency.trim().toUpperCase();
  if (!/^-?\d+(?:\.\d{1,12})?$/.test(text) || !/^[A-Z]{3}$/.test(currency)) return null;
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const scaled = (BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, "0"))) * (negative ? -1n : 1n);
  const amount = Number(text);
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) return null;
  return { amount, currency, scaled, source_amount: text };
}
const asNumber = value => Number(value) / Number(SCALE);

export function normalizeOzonAccrualTypes(payload) {
  const rows = payload instanceof Map ? [...payload.values()] : Array.isArray(payload) ? payload : payload?.accrual_types;
  if (!Array.isArray(rows)) throw error("OZON_ACCRUAL_TYPES_INVALID", "Official accrual type dictionary is missing");
  const result = new Map();
  for (const row of rows) {
    const id = identifier(row?.id);
    if (typeof row.name !== "string" || !row.name.trim()) throw error("OZON_ACCRUAL_TYPES_INVALID", "Accrual type has no official name");
    const entry = { id, name: row.name.trim(), description: String(row.description || "") };
    const before = result.get(id);
    if (before && (before.name !== entry.name || before.description !== entry.description)) throw error("OZON_ACCRUAL_TYPES_CONFLICT", "Official accrual type ID has conflicting definitions");
    result.set(id, entry);
  }
  return result;
}

// Names come from /types. Numeric IDs never define fee semantics in this adapter.
export function ozonAccrualCategory(typeName) {
  if (typeName === "Acquiring") return "collecting_fee";
  if (typeName === "SaleCommission") return "commission";
  if (["RfbsGlobalDelivery", "RfbsGlobalIntermediaryService", "RfbsGlobalPlatformConnectionService", "RfbsGlobalAgentFee", "RfbsServiceFee",
    "InternationalLogisticDelta", "OzonGlobalLogisticsDelivery"].includes(typeName)) return "international_transport";
  if (["LastMile", "LastMileCourier", "LastMilePickUpPoint", "Logistic", "Shipment", "RfbsDomesticDelivery", "DeliveryToHandoverPlaceByOzon"].includes(typeName)) return "platform_delivery";
  if (["BackwardShipment", "ReturnFlowLogistic", "ClientReturn", "SellerReturns", "RfbsEasyReturn"].includes(typeName)) return "aftersale_loss";
  return "other";
}

function association(accrual) {
  const unit = typeof accrual.unit_number === "string" ? accrual.unit_number.trim() : "";
  const category = String(accrual.accrued_category || "");
  const explicit = typeof accrual.posting?.posting_number === "string" ? accrual.posting.posting_number.trim() : "";
  const knownUnit = ["POSTING", "ITEM", "NON_ITEM"].includes(category) && /^\d+-\d+(?:-\d+)?$/.test(unit);
  const posting = knownUnit ? unit : "";
  return { unit_number: unit, posting_number: posting,
    order_number: /^\d+-\d+-\d+$/.test(posting) ? posting.replace(/-\d+$/, "") : posting,
    unit_scope: !posting ? "unallocated" : /^\d+-\d+$/.test(posting) ? "parent_order" : "posting",
    conflict: Boolean(explicit && explicit !== posting) };
}

/**
 * Normalize one official daily accrual without performing any FX conversion.
 * Original total is the net amount; rows contain one gross income anchor and
 * signed fees. They must never include that net again as an additional row.
 */
export function normalizeOzonFinanceAccrual(accrual, { types, sourceEndpoint = OZON_DAILY_ACCRUAL_ENDPOINT } = {}) {
  if (sourceEndpoint !== OZON_DAILY_ACCRUAL_ENDPOINT) throw error("OZON_ACCRUAL_SOURCE_INVALID", "Daily-accrual semantics require the exact official source endpoint");
  const id = identifier(accrual?.accrual_id), operationDate = day(accrual.date);
  const dictionary = normalizeOzonAccrualTypes(types);
  const total = monetary(accrual.total_amount);
  const relation = association(accrual);
  const issues = [], consumed = new Set(["total_amount"]), components = [], references = [], items = [];
  if (!total) issues.push({ code: "TOTAL_MONEY_INVALID", path: "total_amount" });
  if (total && !supportedCurrencies.has(total.currency)) issues.push({ code: "CURRENCY_UNSUPPORTED", path: "total_amount", currency: total.currency });
  if (relation.conflict) issues.push({ code: "UNIT_POSTING_CONFLICT", path: "unit_number" });
  let gross = 0n;
  const readMoney = (value, path) => {
    consumed.add(path);
    const parsed = monetary(value);
    if (!parsed) issues.push({ code: "COMPONENT_MONEY_INVALID", path });
    else if (total && parsed.currency !== total.currency) issues.push({ code: "COMPONENT_CURRENCY_CONFLICT", path, currency: parsed.currency });
    return parsed;
  };
  const addComponent = (money, category, semanticId, meta) => {
    if (money) components.push({ ...meta, category, semantic_id: semanticId, amount: money.amount, currency_code: money.currency, scaled: money.scaled });
  };
  for (const [index, product] of (Array.isArray(accrual.posting?.products) ? accrual.posting.products : []).entries()) {
    const path = `posting.products[${index}].commission`, commission = product.commission;
    const sku = String(product.sku || ""), quantity = Number(product.quantity);
    items.push({ sku, quantity: Number.isFinite(quantity) ? quantity : null });
    if (!object(commission)) continue;
    if (own(commission, "sale_amount")) {
      const amount = readMoney(commission.sale_amount, `${path}.sale_amount`);
      if (amount && total && amount.currency === total.currency) gross += amount.scaled;
    }
    const commissionFields = ["sale_commission", "commission"].filter(field => own(commission, field) && commission[field] !== null);
    const parsed = commissionFields.map(field => ({ field, value: readMoney(commission[field], `${path}.${field}`) }));
    const first = parsed[0]?.value;
    if (first && parsed.some(item => !item.value || item.value.currency !== first.currency || item.value.scaled !== first.scaled)) {
      issues.push({ code: "COMMISSION_ALIASES_CONFLICT", path });
    } else if (first) addComponent(first, "commission", `posting_commission:${sku}`, { name: "SaleCommission", source_group: "posting_commission", sku, paths: parsed.map(item => `${path}.${item.field}`) });
    // These describe prices/funding, not additional income on top of sale_amount.
    for (const field of ["seller_price", "sale_price", "coinvestment", "bonus"]) if (own(commission, field) && commission[field] !== null) {
      consumed.add(`${path}.${field}`);
      references.push({ path: `${path}.${field}`, monetary: commission[field] });
    }
  }
  const walkFees = (value, path, group, inheritedSku = "") => {
    if (Array.isArray(value)) { value.forEach((item, index) => walkFees(item, `${path}[${index}]`, group, inheritedSku)); return; }
    if (!object(value)) return;
    const sku = value.sku === undefined ? inheritedSku : String(value.sku);
    if (value.sku !== undefined && !items.some(item => item.sku === sku)) {
      const quantity = Number(value.quantity);
      items.push({ sku, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null });
    }
    if (own(value, "type_id") && own(value, "accrued")) {
      let typeId;
      try { typeId = identifier(value.type_id); } catch { issues.push({ code: "FEE_TYPE_INVALID", path }); }
      const type = dictionary.get(typeId);
      if (!type) issues.push({ code: "FEE_TYPE_UNKNOWN", path, type_id: typeId || String(value.type_id) });
      const money = readMoney(value.accrued, `${path}.accrued`);
      const category = type ? ozonAccrualCategory(type.name) : "other";
      if (money?.scaled > 0n && category === "other") issues.push({ code: "POSITIVE_ADJUSTMENT_UNCLASSIFIED", path: `${path}.accrued`, type_id: typeId || null });
      addComponent(money, category, `${group}:${typeId || "unknown"}:${sku}`, {
        type_id: typeId || null, name: type?.name || "UnknownAccrualType", description: type?.description || "", source_group: group, sku, paths: [`${path}.accrued`] });
      return;
    }
    for (const [field, item] of Object.entries(value)) walkFees(item, `${path}.${field}`, group, sku);
  };
  for (const field of ["item_fees", "non_item_fee", "container_fees"]) walkFees(accrual[field], field, field);
  // Preserve unfamiliar monetary shapes instead of silently dropping amounts.
  const unrecognizedMoney = [];
  const inspect = (value, path = "") => {
    if (Array.isArray(value)) { value.forEach((item, index) => inspect(item, `${path}[${index}]`)); return; }
    if (!object(value)) return;
    if (own(value, "amount") && own(value, "currency")) {
      if (!consumed.has(path)) { unrecognizedMoney.push({ path, monetary: value }); issues.push({ code: "MONEY_COMPONENT_UNRECOGNIZED", path }); }
      return;
    }
    for (const [field, item] of Object.entries(value)) inspect(item, path ? `${path}.${field}` : field);
  };
  inspect(accrual);
  const grouped = new Map();
  for (const component of components) {
    const key = `${component.semantic_id}:${component.currency_code}`;
    const previous = grouped.get(key);
    if (previous) { previous.scaled += component.scaled; previous.paths.push(...component.paths); }
    else grouped.set(key, { ...component, paths: [...component.paths] });
  }
  const sameCurrency = [...grouped.values()].filter(item => item.currency_code === total?.currency);
  const explicit = sameCurrency.reduce((sum, component) => sum + component.scaled, 0n);
  const residual = total ? total.scaled - gross - explicit : null;
  if (residual !== null && residual !== 0n) issues.push({ code: "NET_COMPONENTS_UNRECONCILED", residual: asNumber(residual), currency: total.currency });
  const rows = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([semanticId, component]) => ({
    service_type: `accrual:${component.category}:${digest(semanticId)}`, service_name: component.name,
    normalized_category: component.category, amount: asNumber(component.scaled), currency_code: component.currency_code,
    accruals_for_sale: 0, source_type_id: component.type_id || null, source_sku: component.sku || null, source_paths: component.paths
  }));
  if (gross !== 0n || !rows.length) rows.unshift({ service_type: `accrual:income:${digest("gross")}`, service_name: "SaleAccrual",
    normalized_category: "income", amount: asNumber(gross), currency_code: total?.currency || "", accruals_for_sale: asNumber(gross), source_paths: ["posting.products[].commission.sale_amount"] });
  if (residual !== null && residual !== 0n) rows.push({ service_type: `accrual:other:${digest("unreconciled_residual")}`, service_name: "UnreconciledAccrualResidual",
    normalized_category: "other", amount: asNumber(residual), currency_code: total.currency, accruals_for_sale: 0, source_paths: ["total_amount"], requires_review: true });
  const reconciliation = { ok: issues.length === 0, currency: total?.currency || "", total_amount: total?.amount ?? null,
    gross_amount: asNumber(gross), explicit_fees_amount: asNumber(explicit), residual: residual === null ? null : asNumber(residual), issues };
  const rawEnvelope = { _source_endpoint: sourceEndpoint, _normalization: { reconciliation, unit_scope: relation.unit_scope }, raw: accrual };
  const fee = category => rows.filter(row => row.normalized_category === category && row.currency_code === total?.currency).reduce((sum, row) => sum + row.amount, 0);
  return { operation_id: `accrual_by_day:${id}`, source_accrual_id: id, source_endpoint: sourceEndpoint,
    operation_date: operationDate, operation_date_precision: "day", posting_number: relation.posting_number,
    order_number: relation.order_number, unit_number: relation.unit_number, unit_scope: relation.unit_scope,
    unallocated_unit_number: relation.unit_scope === "parent_order" || relation.unit_scope === "unallocated" ? relation.unit_number : null,
    accrued_category: String(accrual.accrued_category || ""), operation_type: `OzonDailyAccrual:${String(accrual.accrued_category || "UNKNOWN")}`,
    operation_type_name: "Ozon daily accrual", currency_code: total?.currency || "", amount: total?.amount ?? null,
    accruals_for_sale: asNumber(gross), sale_commission: fee("commission"), delivery_charge: fee("platform_delivery"), return_delivery_charge: fee("aftersale_loss"),
    rows, services: rows.filter(row => !["commission", "platform_delivery", "aftersale_loss", "income"].includes(row.normalized_category)).map(row => ({ name: row.service_name, price: row.amount, currency_code: row.currency_code })),
    items, reconciliation, monetary_references: references, unrecognized_money: unrecognizedMoney, raw_json: JSON.stringify(rawEnvelope) };
}

export function normalizeOzonFinanceAccrualPage(payload, options) {
  const result = object(payload?.result) ? payload.result : payload;
  if (!Array.isArray(result?.accruals) || typeof result.last_id !== "string") throw error("OZON_ACCRUAL_PAGE_INVALID", "Official daily-accrual page must contain accruals and an explicit last_id");
  return { operations: result.accruals.map(accrual => normalizeOzonFinanceAccrual(accrual, options)), last_id: result.last_id, has_more: result.last_id !== "", source_endpoint: OZON_DAILY_ACCRUAL_ENDPOINT };
}
