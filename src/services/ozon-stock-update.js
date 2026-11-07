// A successful HTTP response is not a successful inventory update. Ozon returns
// an independent updated/errors receipt for each product and warehouse.
export function ozonStockUpdateReceipts(targets = [], response = {}) {
  const rows = Array.isArray(response?.result) ? response.result : [];
  return targets.map(target => {
    const matches = rows.filter(row => {
      if (!row || typeof row !== "object") return false;
      if (String(row.warehouse_id || "") !== String(target.warehouse_id)) return false;
      const offerMatches = target.offer_id && String(row.offer_id || "") === String(target.offer_id);
      const productMatches = Number(target.product_id) > 0 && Number(row.product_id) === Number(target.product_id);
      if (!offerMatches && !productMatches) return false;
      if (target.offer_id && row.offer_id && !offerMatches) return false;
      if (Number(target.product_id) > 0 && row.product_id && !productMatches) return false;
      return true;
    });
    const row = matches.length === 1 ? matches[0] : null;
    const errors = Array.isArray(row?.errors) ? row.errors.map(error => ({
      code: String(error?.code || "OZON_STOCK_REJECTED"),
      message: String(error?.message || error?.description || "Ozon 拒绝了库存更新")
    })) : [];
    const accepted = row?.updated === true && Array.isArray(row.errors) && errors.length === 0;
    if (!accepted && !errors.length) errors.push({
      code: "STOCK_UPDATE_UNCONFIRMED",
      message: row ? "Ozon 未明确接受库存更新，请刷新库存后核对" : "Ozon 未返回唯一匹配的商品和仓库回执，请刷新库存后核对"
    });
    return { ...target, accepted, errors };
  });
}
