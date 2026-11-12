export const demoShops = [
  { id: 'ozon-demo', platform: 'ozon', name: 'Ozon 汽配店（示例）' },
  { id: 'wb-demo', platform: 'wb', name: 'WB 汽配店（示例）' }
];
export const demoProducts = [
  { sku: 'BP-001', name: '前轮刹车片套装', platforms: ['ozon', 'wb'], local: 100, ozonReserved: 10, wbReserved: 5, transferReserved: 20, safety: 5, ozonFbp: 30, wbWarehouse: 0 },
  { sku: 'AF-002', name: '发动机空气滤芯', platforms: ['ozon', 'wb'], local: 40, ozonReserved: 3, wbReserved: 2, transferReserved: 0, safety: 5, ozonFbp: 12, wbWarehouse: 0 }
];
export function sharedAvailable(product) {
  return Math.max(0, product.local - product.ozonReserved - product.wbReserved - product.transferReserved - product.safety);
}
export function filterMarketplaceRows(rows, { platform = '', shop = '', search = '' } = {}) {
  const keyword = String(search).trim().toLowerCase();
  return rows.filter(row => (!platform || (row.platform ? [row.platform] : row.platforms || []).includes(platform))
    && (!shop || row.shopId === shop)
    && (!keyword || [row.number, row.sku, row.name, row.shopName].some(value => String(value || '').toLowerCase().includes(keyword))));
}
export function createDemoOrders() {
  return demoShops.flatMap((shop, index) => demoProducts.map((product, productIndex) => ({
    id: `${shop.id}-${product.sku}`, platform: shop.platform, shopId: shop.id, shopName: shop.name,
    number: `${shop.platform.toUpperCase()}-DEMO-${index + 1}${productIndex + 1}01`, sku: product.sku, name: product.name,
    quantity: 1, status: '待处理', warehouse: '本地共用仓', fulfillment: 'FBS'
  })));
}
export const demoListings = demoShops.flatMap(shop => demoProducts.map((product, index) => ({
  ...product, id: `${shop.id}-${product.sku}`, platform: shop.platform, shopId: shop.id, shopName: shop.name,
  number: `${shop.platform.toUpperCase()}-ITEM-${index + 1}`, status: index ? '草稿' : '已上架', price: index ? 800 : 2400
})));
export const demoPromotions = demoShops.map(shop => ({
  id: shop.id, platform: shop.platform, shopId: shop.id, shopName: shop.name,
  name: '汽配优惠活动（示例）', sku: 'BP-001', number: `${shop.platform.toUpperCase()}-PROMO-DEMO`, status: '待报名'
}));
