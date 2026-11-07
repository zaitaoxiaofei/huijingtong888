function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const moneyFields = ["price", "action_price", "max_action_price", "alert_max_action_price", "marketplace_seller_price", "price_min_elastic", "price_max_elastic", "min_seller_price"];

function validMoney(value) {
  if (!value || typeof value !== "object" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(String(value.amount ?? "")) || !["CNY", "RUB"].includes(value.currency)) return null;
  return { amount: String(value.amount), currency: value.currency };
}

function verifiedCurrency(row) {
  const present = moneyFields.filter(key => row[key] !== null && row[key] !== undefined);
  const values = present.map(key => validMoney(row[key]));
  if (!values.length || values.some(value => !value) || new Set(values.map(value => value.currency)).size !== 1) return "";
  const currency = values[0].currency;
  return row.currency && row.currency !== currency ? "" : currency;
}

export function normalizePromotionProductPage(rows) {
  return rows.map(row => {
    const currency = verifiedCurrency(row);
    const product = { ...row, currency, price_money_verified: Boolean(currency) };
    for (const key of moneyFields) {
      if (row[key] !== undefined && row[key] !== null) product[key] = validMoney(row[key]) ? Number(row[key].amount) : null;
    }
    // price is the product's base price. Shared action_price and the seller's
    // discounted marketplace price must never become the next half-price base.
    product.enrollment_base_price = currency && validMoney(row.price) && Number(row.price.amount) > 0 ? Number(row.price.amount) : null;
    return product;
  });
}

export function validatePromotionEnrollmentFacts(products, currentRows, action) {
  const byId = new Map(currentRows.map(row => [Number(row.product_id ?? row.id), row]));
  const valid = [], failures = [];
  for (const product of products) {
    const current = byId.get(product.product_id);
    let reason = "";
    if (!current) reason = "该商品不在本店当前活动的候选或已参加列表，请重新拉取后核对";
    else if (!verifiedCurrency(current) || verifiedCurrency(current) !== product.action_price.currency) reason = "Ozon 当前商品价格币种不完整或已变化，请重新拉取活动商品后确认币种";
    else if (!validMoney(current.max_action_price) || Number(product.action_price.amount) > Number(current.max_action_price.amount)) reason = "填写的活动限价高于当前入围上限（max_action_price），不会加入活动；请刷新后调整价格";
    else if (current.min_seller_price != null && Number(product.action_price.amount) < Number(current.min_seller_price.amount)) reason = "填写的活动限价低于当前最低卖家价格（min_seller_price），请在 Ozon 核对最低价格后重试";
    else if (product.stock !== undefined && !action.isVoucher) reason = "该活动不支持设置活动库存，请清空活动库存；实际销售库存请到批量改库存页面更新";
    if (reason) failures.push({ product_id: product.product_id, reason });
    else valid.push(product);
  }
  return { products: valid, failures };
}

export function normalizePromotionEnrollment(actionId, products) {
  const id = Number(actionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid("活动编号无效，请刷新活动列表后重试");
  if (!Array.isArray(products) || !products.length || products.length > 1000) throw invalid("每次请选择 1 至 1000 个商品报名");
  const seen = new Set();
  return { action_id: id, products: products.map(row => {
    const product_id = Number(row.product_id ?? row.id);
    if (!Number.isSafeInteger(product_id) || product_id <= 0 || seen.has(product_id)) throw invalid("商品编号无效或重复，请刷新商品列表后重试");
    seen.add(product_id);
    const value = row.action_price;
    const amount = String(value && typeof value === "object" ? value.amount ?? "" : value ?? "");
    const currency = String(value && typeof value === "object" ? value.currency ?? "" : row.currency ?? "");
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw invalid(`商品 ${product_id} 缺少有效活动价，请在活动商品行填写大于零、最多两位小数的价格`);
    if (!["RUB", "CNY"].includes(currency)) throw invalid(`商品 ${product_id} 缺少有效价格币种，请重新拉取活动商品，确认人民币或卢布价格后提交`);
    const product = { product_id, action_price: { amount, currency } };
    if (row.stock !== undefined && row.stock !== null && row.stock !== "") {
      const stock = String(row.stock);
      if (!/^\d+$/.test(stock) || !Number.isSafeInteger(Number(stock))) throw invalid(`商品 ${product_id} 活动库存无效，请填写非负整数`);
      product.stock = stock;
    }
    return product;
  }) };
}

export function promotionEnrollmentOutcome(products, receipt, joined = [], verificationError = "", preflightFailures = []) {
  const active = new Set((Array.isArray(receipt?.active_product_ids) ? receipt.active_product_ids : []).map(String));
  const deactivated = new Set((Array.isArray(receipt?.deactivated_product_ids) ? receipt.deactivated_product_ids : []).map(String));
  const rejected = new Map((Array.isArray(receipt?.rejected) ? receipt.rejected : []).map(row => [String(row.product_id ?? row.id), String(row.reason || "Ozon 拒绝报名")]));
  const current = new Map(joined.map(row => [String(row.product_id ?? row.id), row]));
  const confirmedProductIds = [], failures = [];
  const blocked = new Map(preflightFailures.map(row => [String(row.product_id), row.reason]));
  for (const product of products) {
    const id = String(product.product_id), row = current.get(id);
    let reason = blocked.get(id) || rejected.get(id);
    if (!reason && deactivated.has(id)) reason = "Ozon 回执显示商品被退出，请核对活动限价";
    if (!reason && !active.has(id)) reason = "Ozon 未明确确认商品报名，请核对后再决定是否重试";
    if (!reason && verificationError) reason = `收到报名回执，但回读未完成：${verificationError}`;
    if (!reason && (!row || String(row.action_price?.currency) !== product.action_price.currency || Number(row.action_price?.amount) !== Number(product.action_price.amount))) reason = "回读尚未确认商品已参加且活动价及币种一致，请稍后刷新核对";
    if (reason) failures.push({ product_id: product.product_id, reason });
    else confirmedProductIds.push(product.product_id);
  }
  const warnings = (Array.isArray(receipt?.warnings) ? receipt.warnings : []).map(row => `商品 ${row.product_id || ""}：${row.reason || "Ozon 返回活动提示"}`);
  return { success: failures.length === 0, count: confirmedProductIds.length, confirmedProductIds, failures, warnings, result: receipt, apiVersion: "update" };
}
