// V2 reads original finance amounts. Legacy amount_cny values retain V1 meaning.
// The caller has already authorized the tenant's shop and supplies its own DB connection.
import { resolveOzonSellerMoney } from "./ozon-seller-money.js";

const currencies = new Set(["CNY", "RUB"]);
const originalMoneyFields = ["amount", "accruals_for_sale", "sale_commission", "delivery_charge", "return_delivery_charge"];
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
const parse = (value) => { try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; } };
const code = (value) => typeof value === "string" ? value.trim().toUpperCase() : "";
const rowsOf = (value) => Array.isArray(value?.[0]) ? value[0] : value;
const key = (row) => `${row.service_type || ""}||${row.service_name || ""}`;
const operationKey = (row) => String(row.operation_id || `row:${row.id}`);
const failure = (reason, unknownRows = []) => ({ ok: false, code: reason, reason, rows: [], sale_accrual_cny: null,
  allocation: null, unknown_rows: unknownRows, source_rows: [] });

function positiveRate(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error("A positive RUB-per-CNY frozen exchange rate is required");
  return result;
}

function requiredShop(order) {
  const shopId = Number(order?.shop_id);
  if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new Error("An authorized shop_id is required for finance reads");
  if (!String(order.posting_number || "").trim()) throw new Error("A posting_number is required for finance reads");
  return shopId;
}

function verifiedCurrencyEvidence(evidence, shopId) {
  if (!evidence) return null;
  if (Number(evidence.shop_id) !== shopId || evidence.verified !== true || !String(evidence.source || "").trim()
    || !String(evidence.reference || "").trim() || !currencies.has(code(evidence.currency_code))) {
    throw new Error("Finance currency evidence must identify the verified shop, currency, source and reference");
  }
  return { currency: code(evidence.currency_code), source: String(evidence.source), reference: String(evidence.reference) };
}

export function resolveFxFinanceCurrency(row, { shopId, currencyEvidence = null } = {}) {
  const raw = parse(row.raw_json);
  const candidates = [
    [code(row.currency_code), "ozon_finance_items.currency_code"],
    [code(raw.currency_code), "raw.currency_code"],
    [code(raw.currency), "raw.currency"]
  ].filter(([value]) => value);
  const values = [...new Set(candidates.map(([value]) => value))];
  if (values.length > 1) return { ok: false, code: "FX_FINANCE_CURRENCY_CONFLICT" };
  if (values.length) {
    if (!currencies.has(values[0])) return { ok: false, code: "FX_FINANCE_CURRENCY_UNSUPPORTED" };
    return { ok: true, currency: values[0], source: candidates[0][1] };
  }
  const evidence = verifiedCurrencyEvidence(currencyEvidence, Number(shopId));
  return evidence ? { ok: true, ...evidence } : { ok: false, code: "FX_FINANCE_CURRENCY_UNKNOWN" };
}

// Never infer seller currency from customer_currency_code, a product listing,
// legacy converted columns, the currency of another operation, or account locale.
export function convertFxFinanceRows(sourceRows, { shopId, rateRubPerCny, currencyEvidence = null } = {}) {
  const rate = positiveRate(rateRubPerCny);
  verifiedCurrencyEvidence(currencyEvidence, Number(shopId));
  const converted = [];
  const blocked = [];
  for (const original of sourceRows) {
    if (Number(original.shop_id) !== Number(shopId)) throw new Error("Finance rows do not belong to the authorized shop");
    const rawEnvelope = parse(original.raw_json);
    if (String(original.operation_id || "").startsWith("accrual_by_day:")
      && (rawEnvelope._source_endpoint !== "/v1/finance/accrual/by-day" || rawEnvelope._normalization?.reconciliation?.ok !== true)) {
      blocked.push({ id: original.id ?? null, operation_id: original.operation_id || "", code: "FX_FINANCE_NORMALIZATION_PENDING" });
      continue;
    }
    const currency = resolveFxFinanceCurrency(original, { shopId, currencyEvidence });
    if (!currency.ok) {
      blocked.push({ id: original.id ?? null, operation_id: original.operation_id || "", code: currency.code });
      continue;
    }
    const row = { ...original, currency_code: currency.currency, currency_source: currency.source,
      currency_reference: currency.reference || null, exchange_rate: currency.currency === "RUB" ? rate : 1 };
    let invalid = false;
    for (const field of originalMoneyFields) {
      const number = Number(original[field] ?? 0);
      if (!Number.isFinite(number)) { invalid = true; break; }
      row[field] = number;
      row[`${field}_cny`] = round(currency.currency === "RUB" ? number / rate : number);
    }
    if (invalid) {
      blocked.push({ id: original.id ?? null, operation_id: original.operation_id || "", code: "FX_FINANCE_AMOUNT_INVALID" });
      continue;
    }
    row.fee_amount = Math.max(0, -row.amount);
    row.fee_amount_cny = Math.max(0, -row.amount_cny);
    converted.push(row);
  }
  if (blocked.length) return failure(blocked[0].code, blocked);
  return { ok: true, rows: converted, unknown_rows: [], source_rows: sourceRows.map((row, index) => ({
    id: row.id ?? null, operation_id: row.operation_id || "", posting_number: row.posting_number,
    currency_code: converted[index].currency_code, currency_source: converted[index].currency_source,
    amount: row.amount, accruals_for_sale: row.accruals_for_sale
  })) };
}

function parentPostingNumber(order) {
  const posting = String(order.posting_number || "").trim();
  const explicit = String(order.order_number || "").trim();
  return explicit && explicit !== posting ? explicit : posting.replace(/-\d+$/, "");
}

function normalizedSellerMoney(item, path) {
  const currencyValues = [item.sale_currency_code, item.sale_currency, item.currency_code].map(code).filter(Boolean);
  if (new Set(currencyValues).size > 1 || item.sale_price_verified === false) return { verified: false };
  return resolveOzonSellerMoney({ sale_price: item.sale_price, currency_code: currencyValues[0] }, path, "sale_price");
}

function itemOriginalSale(row, suppliedItems, rate) {
  const sku = String(row.ozon_sku || "");
  const matchesSku = item => String(item?.ozon_sku || item?.sku || "") === sku;
  let money = null;
  // A pinned original definition wins over a later posting refresh, including
  // a changed amount/currency. A corrupt pinned definition cannot be guessed.
  if (row.fx_prices_json !== null && row.fx_prices_json !== undefined) {
    const frozenPrices = parse(row.fx_prices_json);
    if (!Array.isArray(frozenPrices)) return null;
    const matchingPrices = frozenPrices.filter(matchesSku);
    if (matchingPrices.length > 1) return null;
    const frozen = matchingPrices[0];
    if (frozen) money = resolveOzonSellerMoney({ price: frozen.amount, currency_code: frozen.currency }, "order_profit_fx_state.prices_json");
  }
  const supplied = suppliedItems.find(matchesSku);
  if (!money && supplied) money = normalizedSellerMoney(supplied, "frozen_order_prices");
  if (!money) {
    const wrapper = parse(row.ozon_raw_json);
    const raw = wrapper.raw || wrapper.result || wrapper;
    const product = Array.isArray(raw.products) ? raw.products.find(matchesSku) : null;
    if (product) {
      const hasPrice = product.price !== undefined && product.price !== null && product.price !== "";
      const owner = hasPrice ? product : product.financial_data || product;
      money = resolveOzonSellerMoney(owner, hasPrice ? "posting.products" : "posting.products.financial_data");
    } else {
      const normalized = Array.isArray(wrapper.items) ? wrapper.items.find(matchesSku) : null;
      if (normalized) money = normalizedSellerMoney(normalized, "posting.items");
    }
  }
  const quantity = Number(row.quantity);
  if (!money?.verified || !currencies.has(money.currency) || !Number.isFinite(quantity) || quantity <= 0) return null;
  return money.amount * quantity / (money.currency === "RUB" ? rate : 1);
}

function maskRepeatedAccruals(rows) {
  const seen = new Map();
  return rows.map((source) => {
    const row = { ...source };
    const operation = `${row.posting_number}||${operationKey(row)}`;
    const previous = seen.get(operation);
    const dailyAccrual = String(row.operation_id || "").startsWith("accrual_by_day:") && String(row.service_type || "").startsWith("accrual:");
    if (dailyAccrual) {
      const amount = Number(row.accruals_for_sale || 0);
      const income = String(row.service_type).startsWith("accrual:income:");
      if ((income && Number(row.amount) !== amount) || (!income && amount !== 0)
        || (previous && (row.currency_code !== previous.currency || (income && previous.income)))) throw new Error("Daily accrual gross income must occur exactly once");
      seen.set(operation, { currency: row.currency_code, amount: amount || previous?.amount || 0, income: income || previous?.income || false });
      return row;
    }
    // In the normalized finance table every fee line repeats its operation's
    // gross accrual. Carry it on one line only; fees themselves remain distinct.
    if (previous !== undefined) {
      if (row.currency_code !== previous.currency || Math.abs(Number(row.accruals_for_sale || 0) - previous.amount) > 1e-6) throw new Error("Conflicting sale accrual within one finance operation");
      row.accruals_for_sale = 0;
      row.accruals_for_sale_cny = 0;
    } else seen.set(operation, { currency: row.currency_code, amount: Number(row.accruals_for_sale || 0) });
    return row;
  });
}

/**
 * Read the complete posting finance history for V2, using original amounts.
 * Do not pass a sync date window: a partial window is not a complete final bill.
 * Revaluation at two dates must use the same allocationRateRubPerCny (order day).
 * This routine proves conversion/allocation only, not financial completeness.
 */
export async function readOrderFxFinanceRows({ query, order, items = [], rateRubPerCny,
  allocationRateRubPerCny = rateRubPerCny, classifyCategory = (row) => row.service_type || "other", currencyEvidence = null, lockForSettlement = false }) {
  const shopId = requiredShop(order);
  const rate = positiveRate(rateRubPerCny);
  const allocationRate = positiveRate(allocationRateRubPerCny);
  if (typeof query !== "function") throw new Error("A finance query function is required");
  const posting = String(order.posting_number).trim();
  const parent = parentPostingNumber(order);
  const postings = [...new Set([posting, ...(parent && parent !== posting ? [parent] : [])])];
  const source = rowsOf(await query(`SELECT id, shop_id, operation_id, posting_number, order_number,
    operation_type, operation_type_name, operation_date, service_type, service_name,
    amount, accruals_for_sale, sale_commission, delivery_charge, return_delivery_charge,
    currency_code, raw_json
    FROM ozon_finance_items WHERE shop_id = ? AND posting_number IN (${postings.map(() => "?").join(",")})
    ORDER BY operation_date, id${lockForSettlement ? " FOR SHARE" : ""}`, [shopId, ...postings]));
  for (const row of source) {
    if (Number(row.shop_id) !== shopId || !postings.includes(String(row.posting_number))) throw new Error("Finance query returned rows outside the authorized posting scope");
  }
  const directOriginal = source.filter((row) => row.posting_number === posting);
  const directKeys = new Set(directOriginal.map(key));
  const hasDaily = source.some(row => String(row.operation_id || "").startsWith("accrual_by_day:"));
  // Legacy parent rows are a fallback representation of child services. New
  // accrual IDs are independent ledger events even when their fee names match.
  const parentOriginal = source.filter((row) => row.posting_number === parent && (hasDaily || !directKeys.has(key(row))));
  const applicable = [...directOriginal, ...parentOriginal];
  if (hasDaily && applicable.some(row => !String(row.operation_id || "").startsWith("accrual_by_day:"))) return failure("FX_FINANCE_SOURCE_MIXED");
  if (hasDaily) {
    const directEvents = new Set(directOriginal.map(row => String(row.operation_id)));
    if (parentOriginal.some(row => directEvents.has(String(row.operation_id)))) return failure("FX_FINANCE_ACCRUAL_SCOPE_CONFLICT");
  }
  const direct = convertFxFinanceRows(directOriginal, { shopId, rateRubPerCny: rate, currencyEvidence });
  if (!direct.ok) return direct;
  const allocated = convertFxFinanceRows(parentOriginal, { shopId, rateRubPerCny: rate, currencyEvidence });
  if (!allocated.ok) return allocated;
  let allocation = null;
  let parentRows = allocated.rows;
  if (parentRows.length) {
    const pattern = `${parent.replace(/[=%_]/g, (char) => `=${char}`)}-%`;
    const siblings = rowsOf(await query(`SELECT o.id AS order_id, o.shop_id, o.posting_number,
      oi.id AS order_item_id, oi.ozon_sku, oi.quantity, oi.sale_price, raw.raw_json AS ozon_raw_json,
      frozen.prices_json AS fx_prices_json
      FROM orders o JOIN shops owned_shop ON owned_shop.id = o.shop_id JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      LEFT JOIN order_profit_fx_state frozen ON frozen.order_id = o.id
        AND frozen.tenant_key = (CASE WHEN owned_shop.tenant_id > 0 THEN CAST(owned_shop.tenant_id AS CHAR) ELSE 'admin' END) COLLATE utf8mb4_0900_ai_ci
      WHERE o.shop_id = ? AND (o.order_number = ? OR o.posting_number LIKE ? ESCAPE '=')
      ORDER BY o.id, oi.id${lockForSettlement ? " FOR SHARE" : ""}`, [shopId, parent, pattern]));
    const weights = new Map();
    const seenItems = new Set();
    for (const row of siblings) {
      if (Number(row.shop_id) !== shopId) throw new Error("Sibling orders do not belong to the authorized shop");
      const siblingPosting = String(row.posting_number || "");
      if (!(siblingPosting === posting || siblingPosting.startsWith(`${parent}-`))) return failure("FX_FINANCE_PARENT_SCOPE_INVALID");
      if (seenItems.has(Number(row.order_item_id))) return failure("FX_FINANCE_PARENT_WEIGHT_DUPLICATE");
      seenItems.add(Number(row.order_item_id));
      const weight = itemOriginalSale(row, siblingPosting === posting ? items : [], allocationRate);
      if (weight === null) return failure("FX_FINANCE_PARENT_WEIGHT_UNKNOWN", [{ order_item_id: row.order_item_id, code: "FX_FINANCE_PARENT_WEIGHT_UNKNOWN" }]);
      weights.set(siblingPosting, (weights.get(siblingPosting) || 0) + weight);
    }
    const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
    const currentWeight = weights.get(posting);
    if (!(totalWeight > 0) || currentWeight === undefined || currentWeight < 0) return failure("FX_FINANCE_PARENT_WEIGHT_UNKNOWN");
    const share = currentWeight / totalWeight;
    const hasDirectSale = direct.rows.some((row) => Math.abs(row.accruals_for_sale) > 1e-6);
    parentRows = parentRows.map((row) => {
      const result = { ...row, derived_from_parent_posting: 1, parent_allocation_share: share };
      for (const field of [...originalMoneyFields, "fee_amount"]) {
        result[field] = round(row[field] * share);
        result[`${field}_cny`] = round(row[`${field}_cny`] * share);
      }
      // A parent's operation also repeats gross revenue on each service row.
      // Direct child revenue is authoritative even when parent fees supplement it.
      if (!hasDaily && hasDirectSale) { result.accruals_for_sale = 0; result.accruals_for_sale_cny = 0; }
      return result;
    });
    allocation = { parent_posting_number: parent, share, allocation_rate_rub_per_cny: allocationRate,
      sibling_weights_cny: Object.fromEntries(weights), income_from_parent: hasDaily || !hasDirectSale };
  }
  let rows;
  try { rows = maskRepeatedAccruals([...direct.rows, ...parentRows]); }
  catch { return failure("FX_FINANCE_ACCRUAL_CONFLICT"); }
  const categoryTotals = rows.reduce((total, row) => {
    const category = classifyCategory(row);
    total[category] = round((total[category] || 0) + row.amount_cny);
    return total;
  }, {});
  const incomeRows = hasDaily ? rows.filter(row => String(row.service_type).startsWith("accrual:income:")) : [];
  return { ok: true, code: null, reason: null, rows, allocation, unknown_rows: [],
    // Each new accrual ID is an independent signed ledger fact. Legacy rows
    // repeat a gross basis on fees and must retain their historical MAX rule.
    income_mode: hasDaily ? "signed_accruals" : "legacy_max",
    income_rows: incomeRows,
    sale_accrual_cny: hasDaily ? round(incomeRows.reduce((sum, row) => sum + row.accruals_for_sale_cny, 0))
      : rows.reduce((max, row) => Math.max(max, Math.abs(row.accruals_for_sale_cny)), 0),
    category_signed_totals_cny: categoryTotals,
    source_rows: [...direct.source_rows, ...allocated.source_rows] };
}
