const OZON_API_BASE = "https://api-seller.ozon.ru";
const DAY_MS = 24 * 60 * 60 * 1000;
const OZON_REQUEST_TIMEOUT_MS = 45000;
const OZON_REQUEST_RETRIES = 2;

export async function fetchOzonPostings(shop, options = {}) {
  const legacySince = typeof options === "string" ? options : "";
  const params = typeof options === "string" ? { since: legacySince } : options || {};
  if (!hasRealOzonCredentials(shop)) {
    const postings = demoPostings(shop, params.since || params.from);
    return { postings, fetched: postings.length, requests: 0, ranges: 1 };
  }

  const since = normalizeIsoStart(params.from || params.since, 30);
  const to = normalizeIsoEnd(params.to, new Date());
  const limit = Math.min(Math.max(Number(params.limit || 1000), 1), 1000);
  const chunkDays = Math.min(Math.max(Number(params.chunkDays || 31), 1), 366);
  const statuses = normalizeStatusList(params.statuses || params.status);
  const postingsByNumber = new Map();
  let requests = 0;
  let ranges = 0;

  for (const status of statuses.length ? statuses : [""]) {
    for (const [rangeSince, rangeTo] of splitDateRange(since, to, chunkDays)) {
      throwIfAborted(params.signal);
      ranges += 1;
      let offset = 0;
      while (true) {
        throwIfAborted(params.signal);
        const filter = { since: rangeSince, to: rangeTo };
        if (status) filter.status = status;
        const data = await ozonRequest(shop, "/v3/posting/fbs/list", {
          dir: "DESC",
          filter,
          limit,
          offset,
          with: {
            analytics_data: true,
            barcodes: true,
            financial_data: true,
            translit: true
          }
        }, { signal: params.signal });
        requests += 1;
        const result = data.result || {};
        const items = result.postings || [];
        for (const item of items) {
          const normalized = normalizeOzonPosting(item);
          if (normalized.posting_number) postingsByNumber.set(normalized.posting_number, normalized);
        }
        if (!result.has_next || items.length < limit) break;
        if (!items.length) break;
        offset += limit;
      }
    }
  }

  const postings = [...postingsByNumber.values()];
  return { postings, fetched: postings.length, requests, ranges };
}

export async function fetchOzonPostingByNumber(shop, postingNumber, options = {}) {
  const posting = String(postingNumber || "").trim();
  if (!posting) throw new Error("Missing Ozon posting number");
  if (!hasRealOzonCredentials(shop)) {
    const demoMatch = demoPostings(shop, options.since || options.from).find((item) => String(item.posting_number || "") === posting);
    return demoMatch || null;
  }
  const data = await ozonRequest(shop, "/v3/posting/fbs/get", {
    posting_number: posting,
    with: {
      analytics_data: true,
      barcodes: true,
      financial_data: true,
      translit: true
    }
  }, options);
  const rawPosting = data.result?.posting || data.result || data.posting || data;
  const normalized = normalizeOzonPosting(rawPosting);
  return normalized?.posting_number ? normalized : null;
}

export async function fetchOzonProducts(shop) {
  if (!hasRealOzonCredentials(shop)) {
    return demoOnlineProducts(shop);
  }

  const productRefs = await fetchOzonProductIds(shop);
  const productIds = productRefs.map((item) => item.id);
  const visibilityById = new Map(productRefs.map((item) => [String(item.id), item.visibility]));

  const products = [];
  for (let index = 0; index < productIds.length; index += 1000) {
    const chunk = productIds.slice(index, index + 1000);
    const data = await ozonRequest(shop, "/v3/product/info/list", { product_id: chunk });
    const items = data.result?.items || data.items || [];
    for (const item of items) products.push(normalizeOzonProduct(item, visibilityById.get(String(item.id || item.product_id || ""))));
  }

  return products;
}

export async function fetchOzonProductsByIds(shop, productIds = []) {
  const ids = [...new Set((productIds || []).map((item) => Number(item)).filter(Boolean))];
  if (!ids.length) return [];
  if (!hasRealOzonCredentials(shop)) {
    return demoOnlineProducts(shop).filter((item) => ids.includes(Number(item.ozon_product_id || 0)));
  }

  const products = [];
  for (let index = 0; index < ids.length; index += 1000) {
    const chunk = ids.slice(index, index + 1000);
    const data = await ozonRequest(shop, "/v3/product/info/list", { product_id: chunk });
    const items = data.result?.items || data.items || [];
    for (const item of items) products.push(normalizeOzonProduct(item));
  }
  return products;
}

export async function fetchOzonProductStocks(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) {
    return demoStockRows(shop);
  }

  const filter = { visibility: "ALL" };
  const offerIds = (options.offerIds || []).map(String).filter(Boolean);
  const productIds = (options.productIds || []).map(Number).filter(Boolean);
  if (offerIds.length) filter.offer_id = offerIds;
  if (productIds.length) filter.product_id = productIds;

  const rows = [];
  let cursor = "";
  do {
    throwIfAborted(options.signal);
    const data = await ozonRequest(shop, "/v4/product/info/stocks", {
      cursor,
      filter,
      limit: Math.min(Math.max(Number(options.limit || 1000), 1), 1000)
    }, { signal: options.signal });
    const result = data.result || data;
    const items = result.items || result.products || [];
    for (const item of items) rows.push(...normalizeOzonStockItem(item));
    cursor = result.cursor || result.last_id || "";
  } while (cursor);

  return rows;
}

export async function fetchOzonStockTurnover(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) return [];
  const skus = [...new Set((options.skus || []).map((item) => Number(item)).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < Math.max(skus.length, 1); index += 1000) {
    const chunk = skus.length ? skus.slice(index, index + 1000) : [];
    let offset = 0;
    while (true) {
      throwIfAborted(options.signal);
      const payload = {
        limit: Math.min(Math.max(Number(options.limit || 1000), 1), 1000),
        offset
      };
      if (chunk.length) payload.sku = chunk;
      const data = await ozonRequest(shop, "/v1/analytics/turnover/stocks", payload, { signal: options.signal });
      const result = data.result || data;
      const items = result.items || result.products || result.rows || [];
      rows.push(...items.map(normalizeOzonStockTurnoverItem).filter((item) => item.ozon_sku));
      if (chunk.length || items.length < payload.limit) break;
      offset += payload.limit;
    }
    if (!skus.length) break;
  }
  return rows;
}

export async function fetchOzonManagedStocks(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) return [];
  const skus = [...new Set((options.skus || []).map((item) => Number(item)).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < Math.max(skus.length, 1); index += 1000) {
    const chunk = skus.length ? skus.slice(index, index + 1000) : [];
    let offset = 0;
    while (true) {
      throwIfAborted(options.signal);
      const payload = {
        filter: {},
        limit: Math.min(Math.max(Number(options.limit || 1000), 1), 1000),
        offset
      };
      if (chunk.length) payload.filter.sku = chunk;
      const data = await ozonRequest(shop, "/v1/analytics/manage/stocks", payload, { signal: options.signal });
      const result = data.result || data;
      const items = result.items || result.products || result.rows || [];
      rows.push(...items.map(normalizeOzonManagedStockItem).filter((item) => item.ozon_sku));
      if (chunk.length || items.length < payload.limit) break;
      offset += payload.limit;
    }
    if (!skus.length) break;
  }
  return rows;
}

export async function fetchOzonWarehouses(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) return demoWarehouses(shop);
  const errors = [];
  for (const path of ["/v1/warehouse/list", "/v2/warehouse/list"]) {
    try {
      const data = await ozonRequest(shop, path, {}, options);
      return normalizeOzonWarehouses(data);
    } catch (error) {
      errors.push(`${path}: ${error?.message || error}`);
      if (options.signal?.aborted) throwIfAborted(options.signal);
    }
  }
  throw new Error(`Ozon 仓库列表获取失败：${errors.join(" | ")}`);
}

export async function fetchOzonFboSupplyOrders(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) return [];
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 100);
  const maxPages = Math.max(1, Number(options.maxPages || 10));
  const errors = [];
  for (const path of ["/v3/supply-order/list", "/v2/supply-order/list", "/v1/supply-order/list", "/v1/fbo/supply-order/list"]) {
    try {
      const orders = [];
      let lastId = "";
      for (let page = 0; page < maxPages; page += 1) {
        throwIfAborted(options.signal);
        const payload = buildOzonSupplyOrderListPayload(path, { ...options, limit, lastId });
        const data = await ozonRequest(shop, path, payload, { signal: options.signal });
        const result = data.result || data;
        const items = result.items || result.supply_orders || result.orders || result.list || result.order_ids || [];
        for (const item of items) orders.push(normalizeOzonFboSupplyOrder(item, shop));
        lastId = result.last_id || result.lastId || result.cursor || "";
        if (!lastId || items.length < limit) break;
      }
      return orders.filter((item) => item.supply_order_id || item.supply_order_number);
    } catch (error) {
      errors.push(`${path}: ${error?.message || error}`);
      if (options.signal?.aborted) throwIfAborted(options.signal);
    }
  }
  throw new Error(`Ozon FBO supply-order list failed for ${shop.name || shop.id}: ${errors.join(" | ")}`);
}

function buildOzonSupplyOrderListPayload(path = "", options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 100);
  const lastId = String(options.lastId || "");
  if (path.includes("/v3/")) {
    const states = Array.isArray(options.states) && options.states.length
      ? options.states.map(Number).filter(Boolean)
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const payload = {
      filter: { states },
      limit,
      sort_by: Number(options.sortBy || options.sort_by || 1)
    };
    if (lastId) payload.last_id = lastId;
    return payload;
  }
  const payload = { limit };
  if (lastId) payload.last_id = lastId;
  if (options.status) payload.status = String(options.status);
  return payload;
}

export async function fetchOzonFboSupplyOrderItems(shop, supplyOrder = {}, options = {}) {
  if (!hasRealOzonCredentials(shop)) return [];
  const supplyOrderId = String(supplyOrder.supply_order_id || supplyOrder.id || "").trim();
  const supplyOrderNumber = String(supplyOrder.supply_order_number || supplyOrder.number || "").trim();
  if (!supplyOrderId && !supplyOrderNumber) return [];
  const errors = [];
  for (const path of ["/v3/supply-order/get", "/v1/supply-order/items", "/v1/supply-order/bundle", "/v2/supply-order/get", "/v1/supply-order/get", "/v1/fbo/supply-order/bundle", "/v1/fbo/supply-order/get"]) {
    try {
      const payload = buildOzonSupplyOrderDetailPayload(path, supplyOrderId || supplyOrderNumber);
      const data = await ozonRequest(shop, path, payload, { signal: options.signal });
      const result = data.result || data;
      const items = extractOzonSupplyOrderItems(result);
      return normalizeOzonFboSupplyOrderItems(items, supplyOrder, shop);
    } catch (error) {
      errors.push(`${path}: ${error?.message || error}`);
      if (options.signal?.aborted) throwIfAborted(options.signal);
    }
  }
  throw new Error(`Ozon FBO supply-order items failed for ${shop.name || shop.id}: ${errors.join(" | ")}`);
}

function normalizeOzonFboSupplyOrder(item = {}, shop = {}) {
  if (typeof item === "string" || typeof item === "number") {
    return {
      shop_id: shop.id,
      shop_name: shop.name || "",
      supply_order_id: String(item),
      supply_order_number: String(item),
      status: "",
      warehouse_name: "",
      created_at: "",
      updated_at: "",
      appointment_at: "",
      raw_json: stringify({ order_id: item })
    };
  }
  const raw = item.supply_order || item.order || item;
  return {
    shop_id: shop.id,
    shop_name: shop.name || "",
    supply_order_id: String(raw.supply_order_id || raw.id || raw.order_id || ""),
    supply_order_number: String(raw.supply_order_number || raw.order_number || raw.number || raw.name || ""),
    status: String(raw.status || raw.state || ""),
    warehouse_name: String(raw.warehouse_name || raw.warehouse?.name || raw.destination_warehouse_name || ""),
    created_at: String(raw.created_at || raw.createdAt || raw.created || ""),
    updated_at: String(raw.updated_at || raw.updatedAt || ""),
    appointment_at: String(raw.appointment_at || raw.appointment?.date || raw.timeslot?.from || raw.shipping_date || ""),
    raw_json: stringify(raw)
  };
}

function buildOzonSupplyOrderDetailPayload(path = "", orderId = "") {
  if (path.includes("/v3/")) return { order_ids: [String(orderId)] };
  if (path.includes("/bundle")) return { bundle_ids: [String(orderId)], limit: 100 };
  return {
    supply_order_id: String(orderId),
    supply_order_number: String(orderId)
  };
}

function extractOzonSupplyOrderItems(result = {}) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.products)) return result.products;
  if (Array.isArray(result.skus)) return result.skus;
  if (Array.isArray(result.bundles)) return result.bundles;
  if (Array.isArray(result.orders)) return result.orders.flatMap((order) => (
    order.items || order.products || order.skus || order.bundles || []
  ));
  if (Array.isArray(result.supply_orders)) return result.supply_orders.flatMap((order) => (
    order.items || order.products || order.skus || order.bundles || []
  ));
  if (Array.isArray(result.supply_order?.items)) return result.supply_order.items;
  return [];
}

function normalizeOzonFboSupplyOrderItems(items = [], supplyOrder = {}, shop = {}) {
  const list = Array.isArray(items) ? items : [items];
  return list.map((item = {}) => {
    const raw = item.product || item.item || item;
    return {
      shop_id: shop.id,
      shop_name: shop.name || "",
      supply_order_id: supplyOrder.supply_order_id || "",
      supply_order_number: supplyOrder.supply_order_number || "",
      status: supplyOrder.status || "",
      warehouse_name: supplyOrder.warehouse_name || "",
      appointment_at: supplyOrder.appointment_at || "",
      ozon_sku: String(raw.sku || raw.ozon_sku || raw.fbo_sku || ""),
      offer_id: String(raw.offer_id || raw.offerId || raw.vendor_code || ""),
      product_id: String(raw.product_id || raw.ozon_product_id || ""),
      quantity: stockNumber(raw.quantity || raw.count || raw.amount || raw.requested_quantity || raw.shipped_quantity),
      accepted_quantity: stockNumber(raw.accepted_quantity || raw.received_quantity || raw.placed_quantity || raw.fact_quantity),
      raw_json: stringify(raw)
    };
  }).filter((item) => item.ozon_sku || item.offer_id || item.product_id);
}

function normalizeOzonStockTurnoverItem(item = {}) {
  const sku = String(item.sku || item.ozon_sku || "");
  return {
    ozon_sku: sku,
    average_daily_sales: numberFromOzon(item.ads ?? item.average_daily_sales ?? item.avg_daily_sales),
    turnover_current_stock: stockNumber(item.current_stock ?? item.stock ?? item.stock_count),
    stock_days: numberFromOzon(item.idc ?? item.days_on_stock ?? item.stock_days ?? item.turnover_days),
    stock_level: String(item.idc_grade || item.stock_level || item.grade || ""),
    raw_json: stringify(item)
  };
}

function normalizeOzonManagedStockItem(item = {}) {
  const sku = String(item.sku || item.ozon_sku || "");
  return {
    ozon_sku: sku,
    offer_id: String(item.offer_id || ""),
    warehouse_name: String(item.warehouse_name || ""),
    valid_stock_count: stockNumber(item.valid_stock_count ?? item.valid_count ?? item.free_stock_count),
    expiring_stock_count: stockNumber(item.expiring_stock_count ?? item.expiring_count ?? item.waiting_payment_stock_count),
    waitingdocs_stock_count: stockNumber(item.waitingdocs_stock_count ?? item.waiting_docs_stock_count),
    paid_stock_count: stockNumber(item.paid_stock_count ?? item.charged_stock_count ?? item.tariff_stock_count),
    free_stock_count: stockNumber(item.free_stock_count ?? item.valid_stock_count),
    paid_storage_start_at: String(item.paid_storage_start_at || item.paid_storage_start_date || item.storage_tariff_start_date || item.tariff_start_date || ""),
    raw_json: stringify(item)
  };
}

export async function updateOzonProductStocks(shop, stocks = [], options = {}) {
  const payloadStocks = (stocks || []).map((item) => ({
    offer_id: String(item.offer_id || ""),
    product_id: Number(item.product_id || item.ozon_product_id || 0),
    stock: Math.max(0, Math.round(Number(item.stock || 0))),
    warehouse_id: Number(item.warehouse_id || 0)
  })).filter((item) => item.offer_id || item.product_id);
  if (!payloadStocks.length) throw new Error("缺少需要更新库存的 Ozon 商品");
  if (!hasRealOzonCredentials(shop)) {
    return { result: payloadStocks.map((item) => ({ ...item, updated: true })), demo: true };
  }
  return ozonRequest(shop, "/v2/products/stocks", { stocks: payloadStocks }, options);
}

export async function archiveOzonProducts(shop, productIds = [], options = {}) {
  const product_id = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!product_id.length) throw new Error("缺少需要归档的 Ozon 商品 ID");
  if (!hasRealOzonCredentials(shop)) {
    return { result: true, product_id, demo: true };
  }
  return ozonRequest(shop, "/v1/product/archive", { product_id }, options);
}

export async function generateOzonBarcodes(shop, productIds = [], options = {}) {
  const product_ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!product_ids.length) throw new Error("Missing Ozon product ids for barcode generation");
  if (!hasRealOzonCredentials(shop)) {
    return {
      result: product_ids.map((id) => ({
        product_id: id,
        barcode: `OZN${String(id).padStart(10, "0").slice(-10)}`
      })),
      demo: true
    };
  }
  return ozonRequest(shop, "/v1/barcode/generate", { product_ids }, options);
}

function normalizeOzonWarehouses(data = {}) {
  return normalizeOzonArrayPayload(data, ["warehouses", "items", "result"])
    .filter((item = {}) => !isArchivedOzonWarehouse(item))
    .map((item = {}) => ({
      warehouse_id: String(item.warehouse_id || item.id || item.source_id || ""),
      name: String(item.name || item.warehouse_name || item.title || item.source_name || ""),
      status: String(item.status || item.state || ""),
      is_rfbs: Boolean(item.is_rfbs || item.rfbs || item.delivery_schema === "rfbs"),
      delivery_schema: String(item.delivery_schema || item.type || ""),
      raw_json: stringify(item)
    }))
    .filter((item) => item.warehouse_id);
}

function isArchivedOzonWarehouse(item = {}) {
  if (item.is_archived === true || item.archived === true || item.is_deleted === true || item.deleted === true) return true;
  if (item.is_active === false || item.active === false || item.enabled === false) return true;
  const statusText = [
    item.status,
    item.state,
    item.warehouse_status,
    item.warehouseStatus,
    item.visibility,
    item.lifecycle_status,
    item.lifecycleStatus
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).join(" ");
  if (!statusText) return false;
  return [
    "archive",
    "archived",
    "inactive",
    "disabled",
    "deleted",
    "closed",
    "blocked",
    "removed"
  ].some((marker) => statusText.includes(marker));
}

export async function createOzonProductBySku(shop, item, options = {}) {
  if (!hasRealOzonCredentials(shop)) {
    return {
      result: {
        task_id: Math.floor(Date.now() / 1000),
        unmatched_sku_list: []
      },
      demo: true
    };
  }
  return ozonRequest(shop, "/v1/product/import-by-sku", {
    items: [{
      sku: Number(item.sku),
      name: String(item.name || `Copy ${item.sku}`),
      offer_id: String(item.offer_id || ""),
      currency_code: String(item.currency_code || "RUB"),
      old_price: String(item.old_price || item.price || "0"),
      price: String(item.price || "0"),
      vat: String(item.vat || "0")
    }]
  }, options);
}

export async function fetchOzonProductImportInfo(shop, taskId, options = {}) {
  if (!hasRealOzonCredentials(shop)) {
    return {
      result: {
        task_id: Number(taskId),
        status: "imported",
        items: [{
          offer_id: `DEMO-${taskId}`,
          product_id: Number(taskId),
          status: "imported"
        }]
      },
      demo: true
    };
  }
  return ozonRequest(shop, "/v1/product/import/info", { task_id: Number(taskId) }, options);
}

export async function importOzonProducts(shop, payload = {}, options = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("Ozon product/import 缺少 items");
  if (!hasRealOzonCredentials(shop)) {
    return {
      result: {
        task_id: Math.floor(Date.now() / 1000),
        total_items: items.length
      },
      demo: true
    };
  }
  return ozonRequest(shop, "/v3/product/import", { items }, options);
}

export async function fetchOzonProductInfoAttributes(shop, options = {}) {
  const productIds = [...new Set((options.productIds || options.product_id || []).map(Number).filter(Boolean))];
  const offerIds = [...new Set((options.offerIds || options.offer_id || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!productIds.length && !offerIds.length) return [];
  if (!hasRealOzonCredentials(shop)) {
    const productId = productIds[0] || Number(String(offerIds[0] || "").replace(/\D/g, "")) || Date.now();
    return [{
      id: productId,
      product_id: productId,
      offer_id: offerIds[0] || `DEMO-${productId}`,
      name: "Чехол брелка автосигнализации, 1 шт.",
      category_id: 971082,
      category_name: "汽车用品 / 汽车配件 / 汽车防盗器遥控器套",
      weight: 100,
      depth: 110,
      width: 41,
      height: 151,
      images: [],
      attributes: [
        { id: 85, name: "品牌", values: [{ value: "无品牌" }] },
        { id: 9048, name: "型号名称", values: [{ value: "KDS#35%-50%-0325-4" }] },
        { id: 10096, name: "主图标签", values: [{ value: "#tenet_t4" }, { value: "#tenet" }] }
      ]
    }];
  }

  const filter = {};
  if (productIds.length) filter.product_id = productIds;
  if (offerIds.length) filter.offer_id = offerIds;
  const payload = {
    filter,
    limit: Math.min(Math.max(Number(options.limit || 100), 1), 1000),
    sort_dir: "ASC"
  };
  let data;
  try {
    data = await ozonRequest(shop, "/v4/product/info/attributes", payload, options);
  } catch (error) {
    if (!String(error?.message || "").includes("/v4/product/info/attributes")) throw error;
    data = await ozonRequest(shop, "/v3/products/info/attributes", payload, options);
  }
  return data.result?.items || data.items || data.result || [];
}

export async function fetchOzonProductContentRating(shop, options = {}) {
  const skus = [...new Set((options.skus || options.sku || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
  if (!skus.length) return [];
  if (!hasRealOzonCredentials(shop)) {
    return skus.map((sku) => ({
      sku,
      rating: 92,
      groups: [
        { name: "media", rating: 30, max_rating: 30 },
        { name: "characteristics", rating: 35, max_rating: 35 },
        { name: "description", rating: 27, max_rating: 35 }
      ],
      demo: true
    }));
  }
  const data = await ozonRequest(shop, "/v1/product/rating-by-sku", { skus }, options);
  const result = data.result || data;
  return normalizeArray(result.products || result.items || result.ratings || result);
}

export async function fetchOzonCategoryAttributes(shop, options = {}) {
  const descriptionCategoryId = Number(options.descriptionCategoryId || options.description_category_id || 0);
  const typeId = Number(options.typeId || options.type_id || 0);
  const categoryId = Number(options.categoryId || options.category_id || 0);
  if (!descriptionCategoryId && !typeId && !categoryId) return [];
  if (!hasRealOzonCredentials(shop)) {
    return [
      { id: 85, name: "品牌", is_required: true, type: "String", dictionary_id: 971082, is_collection: false },
      { id: 9048, name: "型号名称", is_required: true, type: "String", dictionary_id: 0, is_collection: false },
      { id: 10096, name: "主图标签", is_required: false, type: "String", dictionary_id: 0, is_collection: true },
      { id: 8229, name: "颜色", is_required: false, type: "String", dictionary_id: 0, is_collection: false }
    ];
  }

  if (descriptionCategoryId && typeId) {
    const data = await ozonRequest(shop, "/v1/description-category/attribute", {
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      language: options.language || "DEFAULT"
    }, options);
    return normalizeOzonCategoryAttributeResponse(data);
  }

  const data = await ozonRequest(shop, "/v3/category/attribute", {
    attribute_type: "ALL",
    category_id: [categoryId],
    language: options.language || "DEFAULT"
  }, options);
  return normalizeOzonCategoryAttributeResponse(data);
}

export async function fetchOzonCategoryAttributeValues(shop, options = {}) {
  const descriptionCategoryId = Number(options.descriptionCategoryId || options.description_category_id || 0);
  const typeId = Number(options.typeId || options.type_id || 0);
  const attributeId = Number(options.attributeId || options.attribute_id || 0);
  if (!descriptionCategoryId || !typeId || !attributeId) return [];
  if (!hasRealOzonCredentials(shop)) {
    return [
      { id: 971082, dictionary_value_id: 971082, value: "无品牌" },
      { id: 1, dictionary_value_id: 1, value: "黑色" },
      { id: 2, dictionary_value_id: 2, value: "银色" }
    ];
  }

  const values = [];
  let lastValueId = Number(options.lastValueId || options.last_value_id || 0);
  const limit = Math.min(Math.max(Number(options.limit || 1000), 1), 5000);
  while (true) {
    const data = await ozonRequest(shop, "/v1/description-category/attribute/values", {
      attribute_id: attributeId,
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      limit,
      last_value_id: lastValueId,
      language: options.language || "ZH_HANS"
    }, options);
    const batch = normalizeOzonAttributeValuesResponse(data);
    values.push(...batch);
    const nextLastValueId = Number(data?.result?.last_value_id || data?.last_value_id || 0);
    if (!nextLastValueId || nextLastValueId === lastValueId || batch.length < limit) break;
    lastValueId = nextLastValueId;
  }
  return values;
}

export async function searchOzonCategoryAttributeValues(shop, options = {}) {
  const descriptionCategoryId = Number(options.descriptionCategoryId || options.description_category_id || 0);
  const typeId = Number(options.typeId || options.type_id || 0);
  const attributeId = Number(options.attributeId || options.attribute_id || 0);
  const value = String(options.value || options.keyword || "").trim();
  if (!descriptionCategoryId || !typeId || !attributeId || !value) return [];
  if (!hasRealOzonCredentials(shop)) {
    return (await fetchOzonCategoryAttributeValues(shop, options)).filter((item) => String(item.value || "").includes(value));
  }
  const data = await ozonRequest(shop, "/v1/description-category/attribute/values/search", {
    attribute_id: attributeId,
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    value,
    limit: Math.min(Math.max(Number(options.limit || 50), 1), 1000),
    language: options.language || "ZH_HANS"
  }, options);
  return normalizeOzonAttributeValuesResponse(data);
}

export async function fetchOzonDescriptionCategoryTree(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) {
    throw new Error("当前店铺没有真实 Ozon API 凭证，无法同步真实类目");
  }
  const data = await ozonRequest(shop, "/v1/description-category/tree", {
    language: options.language || "DEFAULT"
  }, options);
  return data.result || data.items || data;
}

function normalizeOzonCategoryAttributeResponse(data = {}) {
  const result = data.result || data.items || data;
  if (Array.isArray(result)) return result.flatMap((item) => Array.isArray(item?.attributes) ? item.attributes : [item]);
  if (Array.isArray(result.attributes)) return result.attributes;
  if (Array.isArray(result.items)) return result.items.flatMap((item) => Array.isArray(item?.attributes) ? item.attributes : [item]);
  return [];
}

function normalizeOzonAttributeValuesResponse(data = {}) {
  const result = data.result || data.items || data;
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.values)) return result.values;
  return [];
}

export async function fetchOzonPackageLabel(shop, postingNumbers = [], options = {}) {
  const postings = [...new Set((postingNumbers || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!postings.length) throw new Error("请选择需要打印面单的订单");
  if (postings.length > 20) throw new Error("Ozon 单次最多生成 20 个货件面单，请分批打印");
  if (!hasRealOzonCredentials(shop)) {
    return demoPdf(`Demo Ozon labels\\n${postings.join("\\n")}`);
  }
  return ozonBinaryRequest(shop, "/v2/posting/fbs/package-label", { posting_number: postings }, options);
}

export async function fetchOzonFinanceTransactions(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) {
    return { operations: [], fetched: 0, requests: 0 };
  }
  const from = normalizeIsoStart(options.from, 30);
  const to = normalizeIsoEnd(options.to, new Date());
  const pageSize = Math.min(Math.max(Number(options.pageSize || 1000), 1), 1000);
  const operations = [];
  let page = 1;
  let requests = 0;
  while (true) {
    throwIfAborted(options.signal);
    const data = await ozonRequest(shop, "/v3/finance/transaction/list", {
      filter: {
        date: { from, to },
        operation_type: [],
        posting_number: "",
        transaction_type: "all"
      },
      page,
      page_size: pageSize
    }, { signal: options.signal });
    requests += 1;
    const result = data.result || {};
    const batch = result.operations || result.items || [];
    for (const operation of batch) operations.push(normalizeFinanceOperation(operation));
    const pageCount = Number(result.page_count || result.pages_count || 0);
    if (!batch.length || (pageCount && page >= pageCount) || batch.length < pageSize) break;
    page += 1;
  }
  return { operations, fetched: operations.length, requests };
}

export async function shipOzonPosting(shop, postingNumber, products = [], options = {}) {
  const posting = String(postingNumber || "").trim();
  if (!posting) throw new Error("缺少需要备货的货件编号");
  const packageProducts = (products || [])
    .map((item) => ({
      product_id: Number(item.product_id || item.ozon_sku || item.sku),
      quantity: Number(item.quantity || 1)
    }))
    .filter((item) => Number.isFinite(item.product_id) && item.product_id > 0 && item.quantity > 0);
  if (!packageProducts.length) throw new Error(`${posting} 缺少可提交备货的 Ozon 商品 ID`);
  if (!hasRealOzonCredentials(shop)) {
    return { result: true, demo: true };
  }
  return ozonRequest(shop, "/v4/posting/fbs/ship", {
    posting_number: posting,
    packages: [{ products: packageProducts }]
  }, options);
}

export async function fetchOzonReviews(shop, options = {}) {
  if (!shop.ozon_client_id || !shop.api_key_hint || shop.api_key_hint.startsWith("demo")) {
    return { reviews: demoReviews(shop), total: 2, requests: 0 };
  }

  const reviews = [];
  let lastId = String(options.last_id || options.lastId || "");
  const limit = Math.min(Math.max(Number(options.limit || 100), 20), 100);
  const status = String(options.status || "").trim();
  let requests = 0;

  while (requests < Math.max(1, Number(options.maxPages || 3))) {
    const payload = { limit };
    if (lastId) payload.last_id = lastId;
    if (status && status !== "all") payload.status = status;
    const data = await ozonRequest(shop, "/v1/review/list", payload, options);
    requests += 1;
    const result = data.result || data;
    const items = result.reviews || result.items || [];
    for (const item of items) reviews.push(normalizeOzonReview(item));
    const total = Number(result.total || result.count || reviews.length);
    lastId = String(result.last_id || "");
    if (!result.has_next || !lastId || !items.length || reviews.length >= total || items.length < limit) return { reviews, total, requests };
  }

  return { reviews, total: reviews.length, requests };
}

export async function fetchOzonReviewComments(shop, reviewId, options = {}) {
  const review_id = String(reviewId || "").trim();
  if (!review_id) return [];
  if (!shop.ozon_client_id || !shop.api_key_hint || shop.api_key_hint.startsWith("demo")) {
    return demoReviews(shop).find((item) => item.review_id === review_id)?.comments || [];
  }
  const data = await ozonRequest(shop, "/v1/review/comment/list", { review_id }, options);
  const result = data.result || data;
  return (result.comments || result.items || []).map(normalizeOzonReviewComment);
}

export async function createOzonReviewComment(shop, reviewId, text, options = {}) {
  const review_id = String(reviewId || "").trim();
  const commentText = String(text || "").trim();
  if (!review_id) throw new Error("Missing Ozon review id");
  if (!commentText) throw new Error("Missing review reply text");
  if (!shop.ozon_client_id || !shop.api_key_hint || shop.api_key_hint.startsWith("demo")) {
    return { result: { comment_id: `demo-comment-${Date.now()}`, review_id, text: commentText }, demo: true };
  }
  return ozonRequest(shop, "/v1/review/comment/create", {
    mark_review_as_processed: true,
    review_id,
    text: commentText
  }, options);
}

export async function fetchOzonChatList(shop, options = {}) {
  if (!hasRealOzonCredentials(shop)) return { chats: [], endpoint: "", raw: null };
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
  const offset = Math.max(Number(options.offset || 0), 0);
  const basePayload = { limit, offset };
  const defaultFilter = { chat_status: options.chat_status || "Opened" };
  const candidates = [
    { path: "/v3/chat/list", payload: { ...basePayload, filter: options.filter || defaultFilter } },
    { path: "/v3/chat/list", payload: { ...basePayload, filter: options.filter || {} } },
    { path: "/v3/chat/list", payload: basePayload },
    { path: "/v2/chat/list", payload: { ...basePayload, filter: options.filter || defaultFilter } },
    { path: "/v2/chat/list", payload: { ...basePayload, filter: options.filter || {} } },
    { path: "/v1/chat/list", payload: { ...basePayload, filter: options.filter || defaultFilter } },
    { path: "/v1/chat/list", payload: basePayload }
  ];
  return firstSuccessfulOzonChatRequest(shop, candidates, (data, endpoint) => ({
    chats: normalizeOzonArrayPayload(data, ["chats", "items", "dialogs"]),
    endpoint,
    raw: data
  }), options);
}

export async function fetchOzonChatHistory(shop, chatId, options = {}) {
  if (!hasRealOzonCredentials(shop)) return { messages: [], endpoint: "", raw: null };
  const chat_id = String(chatId || "").trim();
  if (!chat_id) return { messages: [], endpoint: "", raw: null };
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
  const offset = Math.max(Number(options.offset || 0), 0);
  const fromMessageId = String(options.from_message_id || options.fromMessageId || "").trim();
  const candidates = [
    ...(fromMessageId ? [
      { path: "/v3/chat/history", payload: { chat_id, from_message_id: fromMessageId, direction: "Backward", limit } },
      { path: "/v3/chat/history", payload: { chat_id, from_message_id: fromMessageId, direction: "Forward", limit } }
    ] : []),
    { path: "/v3/chat/history", payload: { chat_id, direction: "Forward", limit } },
    { path: "/v3/chat/history", payload: { chat_id, direction: "Backward", limit } },
    { path: "/v2/chat/history", payload: { chat_id, limit, offset } },
    { path: "/v1/chat/history", payload: { chat_id, limit, offset } },
    { path: "/v2/chat/messages", payload: { chat_id, limit, offset } },
    { path: "/v1/chat/messages", payload: { chat_id, limit, offset } }
  ];
  return firstSuccessfulOzonChatRequest(shop, candidates, (data, endpoint) => ({
    messages: normalizeOzonArrayPayload(data, ["messages", "items"]),
    endpoint,
    raw: data
  }), options);
}

async function fetchOzonProductIds(shop) {
  const productIds = new Map();
  const visibilityFilters = [
    "ALL",
    "VISIBLE",
    "INVISIBLE",
    "EMPTY_STOCK",
    "NOT_MODERATED",
    "MODERATED",
    "DISABLED",
    "STATE_FAILED",
    "READY_TO_SUPPLY",
    "VALIDATION_STATE_PENDING",
    "VALIDATION_STATE_FAIL",
    "VALIDATION_STATE_SUCCESS",
    "TO_SUPPLY",
    "IN_SALE",
    "REMOVED_FROM_SALE",
    "BANNED",
    "OVERPRICED",
    "CRITICALLY_OVERPRICED",
    "EMPTY_BARCODE",
    "BARCODE_EXISTS",
    "QUARANTINE",
    "ARCHIVED"
  ];

  for (const visibility of visibilityFilters) {
    try {
      const ids = await fetchOzonProductIdsByVisibility(shop, visibility);
      for (const id of ids) if (!productIds.has(String(id))) productIds.set(String(id), { id, visibility });
    } catch (error) {
      if (visibility === "ALL") throw error;
    }
  }

  return [...productIds.values()];
}

async function fetchOzonProductIdsByVisibility(shop, visibility) {
  const productIds = [];
  let lastId = "";

  do {
    const payload = {
      filter: { visibility },
      limit: 1000,
      last_id: lastId
    };
    const data = await ozonRequest(shop, "/v3/product/list", payload);
    const result = data.result || {};
    const items = result.items || [];
    for (const item of items) {
      const id = item.product_id || item.id;
      if (id) productIds.push(Number(id));
    }
    lastId = result.last_id || "";
  } while (lastId);

  return productIds;
}

async function ozonRequest(shop, path, payload, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= OZON_REQUEST_RETRIES; attempt += 1) {
    try {
      return await ozonRequestOnce(shop, path, payload, options);
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      lastError = error;
      if (!isRetryableOzonError(error) || attempt >= OZON_REQUEST_RETRIES) break;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function ozonRequestOnce(shop, path, payload, options = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal.reason || new Error("本次拉取已取消"));
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), OZON_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${OZON_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Client-Id": String(shop.ozon_client_id),
        "Api-Key": ozonApiKey(shop),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throwIfAborted(options.signal);
    if (error.name === "AbortError") throw new Error(`Ozon ${path} timeout after ${Math.round(OZON_REQUEST_TIMEOUT_MS / 1000)}s`);
    throw new Error(`Ozon ${path} request failed for ${shop.name || shop.id}: ${networkErrorMessage(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data.message || data.error || text || `Ozon API ${response.status}`;
    const error = new Error(`Ozon ${path} failed: ${message}`);
    error.statusCode = response.status;
    error.path = path;
    throw error;
  }
  return data;
}

function isRetryableOzonError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.name === "TypeError" ||
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket") ||
    message.includes("network")
  );
}

function networkErrorMessage(error) {
  const cause = error?.cause;
  const parts = [
    error?.message,
    cause?.code,
    cause?.message
  ].filter(Boolean);
  return parts.join("; ") || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ozonApiKey(shop = {}) {
  return String(shop.ozon_api_key || shop.api_key || shop.api_key_hint || "").trim();
}

function hasRealOzonCredentials(shop = {}) {
  const apiKey = ozonApiKey(shop);
  return Boolean(shop.ozon_client_id && apiKey && !apiKey.startsWith("demo"));
}

async function firstSuccessfulOzonChatRequest(shop, candidates = [], normalize, options = {}) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      const data = await ozonRequest(shop, candidate.path, candidate.payload, options);
      return normalize(data, candidate.path);
    } catch (error) {
      errors.push(`${candidate.path}: ${error?.message || error}`);
      if (options.signal?.aborted) throwIfAborted(options.signal);
    }
  }
  const message = errors.join(" | ") || "Ozon chat endpoint unavailable";
  throw new Error(`Ozon chat request failed for ${shop.name || shop.id}: ${message}`);
}

function normalizeOzonArrayPayload(data = {}, keys = []) {
  const result = data?.result || data || {};
  for (const key of keys) {
    if (Array.isArray(result?.[key])) return result[key];
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.result)) return result.result;
  return [];
}

async function ozonBinaryRequest(shop, path, payload, options = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal.reason || new Error("本次请求已取消"));
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(`${OZON_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Client-Id": String(shop.ozon_client_id),
        "Api-Key": ozonApiKey(shop),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throwIfAborted(options.signal);
    if (error.name === "AbortError") throw new Error(`Ozon ${path} timeout after 45s`);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = buffer.toString("utf8");
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.error || text;
    } catch {}
    throw new Error(`Ozon ${path} failed: ${message}`);
  }
  return buffer;
}

function demoPdf(text) {
  const safe = String(text || "Demo PDF").replace(/[()\\]/g, "\\$&").replace(/\r?\n/g, ") Tj T* (");
  const body = `BT /F1 14 Tf 48 780 Td (${safe}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(body)} >> stream\n${body}\nendstream endobj`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${object}\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(reason || "本次拉取已取消");
}

function resolvedOzonSku(item = {}) {
  return String(
    item.sku
      || item.fbo_sku
      || item.fbs_sku
      || item.product_sku
      || item.productSku
      || item.ozon_sku
      || firstSourceSku(item.sources)
      || ""
  );
}

function normalizeOzonProduct(item, listVisibility = "") {
  const images = productImages(item);
  const primaryImage = imageUrl(item.primary_image || item.primary_image_url || item.image || item.main_image || item.color_image || images[0] || "");
  const price = numberFromOzon(item.price ?? item.marketing_price ?? item.old_price);
  const marketingPrice = numberFromOzon(item.marketing_price);
  const oldPrice = numberFromOzon(item.old_price);
  const sku = resolvedOzonSku(item);
  const archived = Boolean(item.archived || item.is_archived || item.is_autoarchived || listVisibility === "ARCHIVED");
  const visibility = item.visibility || listVisibility || (item.visibility_details?.has_price === false ? "limited" : (item.visible === false ? "hidden" : "visible"));
  const attributes = {
    type_id: item.type_id,
    category_id: item.category_id,
    description_category_id: item.description_category_id,
    volume_weight: item.volume_weight,
    weight: item.weight,
    weight_unit: item.weight_unit,
    height: item.height,
    depth: item.depth,
    width: item.width,
    dimension_unit: item.dimension_unit,
    vat: item.vat,
    sources: item.sources || []
  };
  return {
    ozon_product_id: String(item.product_id || item.id || ""),
    ozon_sku: String(sku || ""),
    offer_id: String(item.offer_id || ""),
    name: item.name || item.name_ru || item.offer_id || `Ozon product ${item.id || item.product_id || ""}`,
    image_url: primaryImage,
    primary_image: primaryImage,
    sale_price: price,
    currency_code: item.currency_code || item.currency || "RUB",
    marketing_price: marketingPrice,
    old_price: oldPrice,
    status: productStatusFromVisibility(visibility, archived),
    visibility,
    archived: archived ? 1 : 0,
    is_discounted: item.is_discounted ? 1 : 0,
    images_json: stringify([...new Set([primaryImage, ...images].filter(Boolean))]),
    barcodes_json: stringify(normalizeArray(item.barcodes || item.barcode)),
    stocks_json: stringify(item.stocks || item.stock || item.sources || []),
    commissions_json: stringify(item.commissions || item.commission || []),
    attributes_json: stringify(attributes),
    raw_json: stringify(item),
    published_at: item.published_at || item.created_at || item.date || "",
    ozon_updated_at: item.updated_at || item.updated_at_in_ozon || item.created_at || ""
  };
}

export function normalizeOzonProductForTest(item, listVisibility = "") {
  return normalizeOzonProduct(item, listVisibility);
}

export function normalizeOzonPostingForTest(item) {
  return normalizeOzonPosting(item);
}

function normalizeOzonReview(item = {}) {
  const comments = (item.comments || item.review_comments || []).map(normalizeOzonReviewComment);
  return {
    review_id: String(item.id || item.review_id || item.uuid || ""),
    ozon_sku: String(item.sku || item.ozon_sku || item.product_sku || ""),
    offer_id: String(item.offer_id || item.offer || ""),
    ozon_product_id: String(item.product_id || item.ozon_product_id || ""),
    product_name: String(item.product_name || item.name || item.item_name || ""),
    product_image: imageUrl(item.product_image || item.image || item.photos || item.images),
    rating: Number(item.rating || item.grade || item.star || 0),
    status: String(item.status || item.state || ""),
    text: String(item.text || item.review_text || item.content || ""),
    advantages: String(item.advantages || item.pros || ""),
    disadvantages: String(item.disadvantages || item.cons || ""),
    published_at: item.published_at || item.created_at || item.date || "",
    updated_at: item.updated_at || "",
    has_reply: Boolean(item.has_reply || item.is_commented || comments.length),
    comments,
    raw_json: stringify(item)
  };
}

function normalizeOzonReviewComment(item = {}) {
  return {
    comment_id: String(item.id || item.comment_id || item.uuid || ""),
    author: String(item.author || item.user || item.source || ""),
    text: String(item.text || item.comment || item.content || ""),
    created_at: item.created_at || item.date || "",
    raw_json: stringify(item)
  };
}

function normalizeOzonStockItem(item) {
  const productId = String(item.product_id || item.id || "");
  const offerId = String(item.offer_id || "");
  const sku = resolvedOzonSku(item);
  const stockRows = normalizeArray(item.stocks || item.stock || item.sources || item.warehouses || []);
  if (!stockRows.length) {
    return [{
      ozon_product_id: productId,
      offer_id: offerId,
      ozon_sku: sku,
      warehouse_id: "",
      warehouse_name: "Ozon",
      stock_type: classifyStockType(item),
      present: stockNumber(item.present ?? item.stock ?? item.available_stock ?? item.available),
      reserved: stockNumber(item.reserved),
      available: stockNumber(item.available ?? item.present ?? item.stock),
      raw_json: stringify(item)
    }];
  }
  return stockRows.map((stock, index) => {
    const warehouseName = String(stock.warehouse_name || stock.name || stock.source || stock.delivery_schema || stock.type || "");
    return {
      ozon_product_id: productId,
      offer_id: offerId,
      ozon_sku: String(stock.sku || sku),
      warehouse_id: String(stock.warehouse_id || stock.source_id || stock.id || stock.type || index),
      warehouse_name: warehouseName || "Ozon",
      stock_type: classifyStockType(stock, item),
      present: stockNumber(stock.present ?? stock.stock ?? stock.quantity ?? stock.available_stock ?? stock.available),
      reserved: stockNumber(stock.reserved ?? stock.reserved_stock),
      available: stockNumber(stock.available ?? stock.free_to_sell_amount ?? stock.present ?? stock.stock ?? stock.quantity),
      raw_json: stringify(stock)
    };
  });
}

function classifyStockType(stock = {}, parent = {}) {
  const text = `${stock.type || ""} ${stock.delivery_schema || ""} ${stock.source || ""} ${stock.warehouse_name || ""} ${stock.name || ""} ${parent.visibility || ""}`.toLowerCase();
  if (text.includes("fbo") || text.includes("fbp") || text.includes("cel") || text.includes("cl ") || text.includes("hunchun") || text.includes("хуньчун") || text.includes("混春") || text.includes("混川") || text.includes("陆-空") || text.includes("陆空")) return "fbp_real";
  if (text.includes("fbs") || text.includes("rfbs") || text.includes("seller") || text.includes("virtual") || text.includes("自发")) return "fbs_virtual";
  return "unknown";
}

function stockNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

function normalizeFinanceOperation(item) {
  const posting = item.posting || item.posting_number || {};
  const services = Array.isArray(item.services) ? item.services : [];
  const items = Array.isArray(item.items) ? item.items : [];
  return {
    operation_id: String(item.operation_id || item.id || item.operation_number || ""),
    operation_type: String(item.operation_type || item.type || ""),
    operation_type_name: String(item.operation_type_name || item.name || ""),
    operation_date: item.operation_date || item.date || item.created_at || "",
    posting_number: String(posting.posting_number || posting || ""),
    order_number: String(posting.order_number || item.order_number || ""),
    amount: numberFromOzon(item.amount || item.total || 0),
    accruals_for_sale: numberFromOzon(item.accruals_for_sale || 0),
    sale_commission: numberFromOzon(item.sale_commission || 0),
    delivery_charge: numberFromOzon(item.delivery_charge || 0),
    return_delivery_charge: numberFromOzon(item.return_delivery_charge || 0),
    currency_code: item.currency_code || item.currency || "",
    services: services.map((service) => ({
      name: String(service.name || service.service_name || service.type || ""),
      price: numberFromOzon(service.price || service.amount || service.value || 0)
    })),
    items: items.map((row) => ({
      sku: String(row.sku || row.ozon_sku || ""),
      name: String(row.name || ""),
      quantity: Number(row.quantity || 1)
    })),
    raw_json: stringify(item)
  };
}

function productImages(item) {
  return [
    item.primary_image,
    item.primary_image_url,
    item.image,
    item.main_image,
    item.color_image,
    item.images,
    item.images360,
    item.image_urls,
    item.pictures,
    item.media?.images,
    item.sources?.flatMap?.((source) => [source?.image, source?.image_url, source?.primary_image])
  ].flatMap(normalizeArray).map(imageUrl).filter(Boolean);
}

function normalizeOzonPosting(item) {
  const products = Array.isArray(item.products) ? item.products : [];
  const financialProducts = Array.isArray(item.financial_data?.products) ? item.financial_data.products : [];
  const cancellation = item.cancellation || item.cancel_reason || {};
  return {
    posting_number: String(item.posting_number || ""),
    order_number: String(item.order_number || item.order_id || item.posting_number || ""),
    order_id: String(item.order_id || ""),
    status: item.status || "",
    substatus: item.substatus || "",
    logistics_status: item.status || "",
    tracking_stage: item.substatus || item.status || "",
    ordered_at: item.in_process_at || item.created_at || item.shipment_date || new Date().toISOString(),
    delivered_at: item.delivered_at || null,
    buyer_region: item.analytics_data?.region || item.analytics_data?.city || "",
    tracking_number: item.tracking_number || "",
    external_tracking_url: item.external_tracking_url || "",
    cancel_reason_id: nullableNumber(cancellation.cancel_reason_id || item.cancel_reason_id),
    cancel_reason: cancellation.cancel_reason || cancellation.reason || item.cancel_reason || "",
    cancel_initiator: cancellation.cancellation_initiator || cancellation.initiator || item.cancellation_initiator || "",
    cancel_type: cancellation.cancellation_type || item.cancellation_type || "",
    cancelled_after_ship: cancellation.cancelled_after_ship ? 1 : 0,
    raw: item,
    items: products.map((product, index) => {
      const financialProduct = financialProducts[index] || {};
      const images = productImages(product);
      const primaryImage = imageUrl(
        product.image_url
        || product.picture
        || product.image
        || product.main_image
        || product.primary_image
        || product.primary_image_url
        || images[0]
        || ""
      );
      return {
        ozon_sku: resolvedOzonPostingSku(product),
        ozon_product_id: String(product.product_id || product.id || financialProduct.product_id || financialProduct.id || ""),
        offer_id: String(product.offer_id || ""),
        name: product.name || "",
        quantity: Number(product.quantity || 1),
        sale_price: numberFromOzon(product.price || product.financial_data?.price || 0),
        image_url: primaryImage
      };
    })
  };
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function productStatusFromVisibility(visibility, archived) {
  const value = String(visibility || "").toUpperCase();
  if (archived || value === "ARCHIVED") return "archived";
  if (["IN_SALE", "VISIBLE", "MODERATED", "VALIDATION_STATE_SUCCESS"].includes(value)) return "online";
  if (["READY_TO_SUPPLY", "TO_SUPPLY", "EMPTY_STOCK"].includes(value)) return "ready";
  if (["STATE_FAILED", "VALIDATION_STATE_FAIL", "BANNED", "OVERPRICED", "CRITICALLY_OVERPRICED", "EMPTY_BARCODE"].includes(value)) return "error";
  if (["NOT_MODERATED", "VALIDATION_STATE_PENDING", "QUARANTINE"].includes(value)) return "moderation";
  if (["INVISIBLE", "DISABLED", "REMOVED_FROM_SALE"].includes(value)) return "hidden";
  return "online";
}

function normalizeIsoStart(value, fallbackDays) {
  if (value) {
    const date = new Date(String(value).includes("T") ? value : `${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(Date.now() - DAY_MS * fallbackDays).toISOString();
}

function normalizeIsoEnd(value, fallbackDate) {
  if (value) {
    const raw = String(value);
    const date = new Date(raw.includes("T") ? raw : `${raw}T23:59:59.999Z`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallbackDate.toISOString();
}

function normalizeStatusList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function splitDateRange(sinceIso, toIso, chunkDays) {
  const ranges = [];
  const end = new Date(toIso);
  let cursor = new Date(sinceIso);
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + chunkDays * DAY_MS - 1, end.getTime()));
    ranges.push([cursor.toISOString(), chunkEnd.toISOString()]);
    cursor = new Date(chunkEnd.getTime() + 1);
  }
  return ranges;
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function imageUrl(value) {
  if (!value) return "";
  if (Array.isArray(value)) return imageUrl(value[0]);
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.url || value.file_name || value.src || value.image_url || value.link || value.href || "";
  return String(value);
}

function firstSourceSku(sources) {
  if (!Array.isArray(sources)) return "";
  return sources.find((source) => source?.sku)?.sku || "";
}

function resolvedOzonPostingSku(item = {}) {
  return String(
    item.sku
      || item.ozon_sku
      || item.product_sku
      || item.productSku
      || item.fbo_sku
      || item.fbs_sku
      || ""
  );
}

function numberFromOzon(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object") return numberFromOzon(value.price || value.value || value.amount);
  const normalized = String(value).replace(",", ".").replace(/[^\d.-]/g, "");
  return Number(normalized || 0);
}

function stringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}

function demoPostings(shop) {
  const now = new Date();
  const suffix = `${shop.id}-${now.getMinutes()}`;
  const catalog = {
    1: ["SKU-A-BOX-01", "SKU-A-MAT-11"],
    2: ["SKU-B-BOX-77", "SKU-B-COMB-18"],
    3: ["SKU-C-BOX-22"]
  };
  const skus = catalog[shop.id] || ["SKU-A-BOX-01"];
  const statusPool = ["awaiting_deliver", "delivering", "customs", "delivered"];
  const status = statusPool[(now.getMinutes() + shop.id) % statusPool.length];
  const stageMap = {
    awaiting_deliver: "等待备货",
    delivering: "已备货，正在前往转运点",
    customs: "俄罗斯清关中",
    delivered: "买家已签收"
  };

  return [
    {
      posting_number: `DEMO-${suffix}`,
      order_number: `ORDER-${suffix}`,
      status,
      logistics_status: stageMap[status],
      tracking_stage: stageMap[status],
      ordered_at: new Date(now.getTime() - 1000 * 60 * 12).toISOString(),
      delivered_at: status === "delivered" ? now.toISOString() : null,
      buyer_region: "Moscow",
      tracking_number: `TRACK-${suffix}`,
      external_tracking_url: `https://www.ozon.ru/my/orderlist/?posting=${encodeURIComponent(`DEMO-${suffix}`)}`,
      items: skus.slice(0, 1).map((sku, index) => ({
        ozon_sku: sku,
        quantity: 1,
        sale_price: index === 0 ? 1890 : 990
      }))
    }
  ];
}

function demoOnlineProducts(shop) {
  const catalog = {
    1: [
      { ozon_sku: "SKU-A-BOX-01", offer_id: "A-BOX-01", name: "A store storage box main image", sale_price: 32 },
      { ozon_sku: "SKU-A-MAT-11", offer_id: "A-MAT-11", name: "Kitchen silicone mat", sale_price: 58 }
    ],
    2: [
      { ozon_sku: "SKU-B-BOX-77", offer_id: "B-BOX-77", name: "B store storage box white background", sale_price: 32 },
      { ozon_sku: "SKU-B-COMB-18", offer_id: "B-COMB-18", name: "Pet grooming comb", sale_price: 89 }
    ],
    3: [
      { ozon_sku: "SKU-C-BOX-22", offer_id: "C-BOX-22", name: "C store storage box video listing", sale_price: 32 }
    ]
  };
  return (catalog[shop.id] || []).map((item, index) => ({
    ozon_product_id: `demo-${shop.id}-${index + 1}`,
    image_url: "",
    primary_image: "",
    currency_code: "RUB",
    marketing_price: item.sale_price,
    old_price: 0,
    visibility: "visible",
    archived: 0,
    is_discounted: 0,
    images_json: "[]",
    barcodes_json: "[]",
    stocks_json: "[]",
    commissions_json: "[]",
    attributes_json: "{}",
    raw_json: JSON.stringify(item),
    ozon_updated_at: "",
    status: "online",
    ...item
  }));
}

function demoReviews(shop) {
  const products = demoOnlineProducts(shop);
  const now = new Date();
  return products.slice(0, 2).map((product, index) => ({
    review_id: `demo-review-${shop.id}-${index + 1}`,
    ozon_sku: product.ozon_sku,
    offer_id: product.offer_id,
    ozon_product_id: product.ozon_product_id,
    product_name: product.name,
    product_image: product.primary_image || "",
    rating: index === 0 ? 5 : 3,
    status: index === 0 ? "UNPROCESSED" : "PROCESSED",
    text: index === 0 ? "Good quality, fast delivery." : "Product is OK, packaging could be better.",
    advantages: index === 0 ? "Quality" : "",
    disadvantages: index === 0 ? "" : "Packaging",
    published_at: new Date(now.getTime() - (index + 1) * DAY_MS).toISOString(),
    updated_at: "",
    has_reply: index > 0,
    comments: index > 0 ? [{
      comment_id: `demo-comment-${shop.id}-${index + 1}`,
      author: "seller",
      text: "Thank you for your feedback. We will improve the packaging.",
      created_at: new Date(now.getTime() - index * DAY_MS).toISOString(),
      raw_json: "{}"
    }] : [],
    raw_json: "{}"
  }));
}

function demoStockRows(shop) {
  return demoOnlineProducts(shop).flatMap((item, index) => ([
    {
      ozon_product_id: item.ozon_product_id || "",
      offer_id: item.offer_id || "",
      ozon_sku: item.ozon_sku,
      warehouse_id: `demo-fbs-${index}`,
      warehouse_name: "Demo FBS 虚拟仓",
      stock_type: "fbs_virtual",
      present: 30 + index * 5,
      reserved: 0,
      available: 30 + index * 5,
      raw_json: JSON.stringify(item)
    },
    {
      ozon_product_id: item.ozon_product_id || "",
      offer_id: item.offer_id || "",
      ozon_sku: item.ozon_sku,
      warehouse_id: `demo-fbp-${index}`,
      warehouse_name: "Demo FBP 合作仓",
      stock_type: "fbp_real",
      present: index === 0 ? 2 : 0,
      reserved: 0,
      available: index === 0 ? 2 : 0,
      raw_json: JSON.stringify(item)
    }
  ]));
}

function demoWarehouses(shop) {
  return [
    {
      warehouse_id: `100${Number(shop?.id || 0) || 1}`,
      name: "Demo FBS 仓库",
      status: "active",
      is_rfbs: false,
      delivery_schema: "fbs",
      raw_json: "{}"
    }
  ];
}
