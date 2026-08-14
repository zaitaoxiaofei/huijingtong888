export function buildSplitShippingPackagesMysql(items = [], packages = []) {
  if (!Array.isArray(packages) || packages.length < 2) throw new Error("拆分备货至少需要两个包裹");
  const itemById = new Map(items.map((item) => [Number(item.id), item]));
  const assignedByItem = new Map(items.map((item) => [Number(item.id), 0]));
  const result = packages.map((entry, packageIndex) => {
    const productRows = Array.isArray(entry?.products) ? entry.products : [];
    const combined = new Map();
    for (const product of productRows) {
      const orderItemId = Number(product?.order_item_id || product?.orderItemId || 0);
      const quantity = Number(product?.quantity || 0);
      const orderItem = itemById.get(orderItemId);
      if (!orderItem) throw new Error(`包裹 ${packageIndex + 1} 包含不属于当前订单的商品`);
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`包裹 ${packageIndex + 1} 的商品数量必须为正整数`);
      combined.set(orderItemId, Number(combined.get(orderItemId) || 0) + quantity);
      assignedByItem.set(orderItemId, Number(assignedByItem.get(orderItemId) || 0) + quantity);
    }
    if (!combined.size) throw new Error(`包裹 ${packageIndex + 1} 不能为空`);
    return {
      products: [...combined.entries()].map(([orderItemId, quantity]) => ({
        product_id: Number(itemById.get(orderItemId).product_id),
        quantity
      }))
    };
  });
  for (const item of items) {
    const expected = Number(item.quantity || 0);
    const assigned = Number(assignedByItem.get(Number(item.id)) || 0);
    if (assigned !== expected) throw new Error(`SKU ${item.ozon_sku} 分配数量为 ${assigned}，必须等于订单数量 ${expected}`);
  }
  return result;
}
