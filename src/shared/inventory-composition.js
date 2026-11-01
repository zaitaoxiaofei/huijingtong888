const fail = message => Object.assign(new Error(message), { statusCode: 409 });

// Inventory units are physical product records. A product's descriptive pack
// size is not another multiplier; only the saved composition supplies ratios.
export function createPhysicalInventoryReader(products, edges) {
  const byId = new Map(products.map(p => [Number(p.id), p]));
  const children = new Map();
  for (const edge of edges) {
    const id = Number(edge.product_id);
    if (!children.has(id)) children.set(id, []);
    children.get(id).push(edge);
  }
  const cache = new Map();
  return function components(productId) {
    const key=Number(productId);
    if(cache.has(key)){const value=cache.get(key);if(value instanceof Error)throw value;return value;}
    const leaves = new Map();
    function visit(id, quantity, path) {
      const product = byId.get(id);
      if (!product || product.active === 0) throw fail('套装组成包含缺失、停用或不可访问的库存，请先核对组成');
      if (path.has(id) || path.size >= 12) throw fail('套装组成存在循环或层级过深，请先修复库存组成');
      const parts = children.get(id) || [];
      if (!parts.length) {
        const before = leaves.get(id);
        if ((before?.per_set_quantity || 0) + quantity > 1000000) throw fail('套装合并后的配件数量过大，请核对组成');
        leaves.set(id, { ...product, product_id: id, per_set_quantity: (before?.per_set_quantity || 0) + quantity });
        return;
      }
      const next = new Set([...path, id]);
      for (const part of parts) {
        const ratio = Number(part.quantity), amount = quantity * ratio;
        if (!Number.isSafeInteger(ratio) || ratio <= 0 || !Number.isSafeInteger(amount) || amount > 1000000) throw fail('套装配件数量无效，请先核对组成及计量单位');
        visit(Number(part.component_product_id), amount, next);
      }
    }
    try{
      visit(key, 1, new Set());
      const value=[...leaves.values()];cache.set(key,value);return value;
    }catch(error){cache.set(key,error);throw error;}
  };
}

export function physicalInventoryComponents(productId, products, edges) {
  return createPhysicalInventoryReader(products, edges)(productId);
}
