export const inventoryModules = [
  { label: '商品库存', tabs: [{ label:'全部商品', path:'/inventory/products' },{ label:'库存预警', path:'/inventory/alerts' }] },
  { label: '收货入库', tabs: [{ label:'待入库', path:'/purchase-list' },{ label:'入库记录', path:'/purchase-history' }] },
  { label: 'FBP', tabs: [{ label:'官方库存', path:'/inventory/fbp' },{ label:'备货建议', path:'/inventory/fbp-opportunities' },{ label:'备货单／发仓记录', path:'/inventory/fbp-replenishment' }] },
  { label: '库存管理', tabs: [{ label:'SKU绑定', path:'/inventory/mappings' },{ label:'已删除商品', path:'/inventory/hidden' }] },
  { label: '采购核对', tabs: [{ label:'平台订单', path:'/procurement/platform-orders' },{ label:'支付对账', path:'/procurement/reconciliation' }] }
];
export const inventoryModule = path => inventoryModules.find(group => group.tabs.some(tab => tab.path === path || (tab.path==='/inventory/products' && path.startsWith('/inventory/products/'))));
