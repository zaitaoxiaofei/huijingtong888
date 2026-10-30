export const fbpStatusTabs = [
  { label:'待审核', status:'applying' }, { label:'待发货', status:'pending_dispatch' },
  { label:'待入仓', status:'pending_receipt' }, { label:'已入仓', status:'completed' },
  { label:'已取消', status:'cancelled' }, { label:'全部', status:'all' }
];
export function fbpRouteStatus(query = {}) {
  if (Number(query.orderId) > 0) return 'all';
  const legacy = { draft:'applying', pending_review:'applying', rejected:'all', approved:'pending_dispatch', ozon_created:'pending_dispatch', sent:'pending_receipt' };
  const status = legacy[query.status] || query.status;
  return fbpStatusTabs.some(tab=>tab.status===status) ? status : 'applying';
}
export const inventoryModules = [
  { label: '商品库存', tabs: [{ label:'全部商品', path:'/inventory/products' },{ label:'库存预警', path:'/inventory/alerts' }] },
  { label: '收货入库', tabs: [{ label:'待入库', path:'/purchase-list' },{ label:'已入库', path:'/purchase-history' }] },
  { label: 'FBP', tabs: [{ label:'官方库存', path:'/inventory/fbp' },{ label:'备货建议', path:'/inventory/fbp-opportunities' }, ...fbpStatusTabs.map(tab=>({...tab,path:'/inventory/fbp-replenishment'}))] },
  { label: '库存管理', tabs: [{ label:'SKU绑定', path:'/inventory/mappings' },{ label:'已删除商品', path:'/inventory/hidden' }] },
  { label: '采购核对', tabs: [{ label:'平台订单', path:'/procurement/platform-orders' },{ label:'支付对账', path:'/procurement/reconciliation' }] }
];
export const inventoryModule = path => inventoryModules.find(group => group.tabs.some(tab => tab.path === path || (tab.path==='/inventory/products' && path.startsWith('/inventory/products/'))));
export const inventoryTabKey = tab => tab.status ? `${tab.path}?status=${tab.status}` : tab.path;
export function inventoryRouteTab(route) {
  if (route.path==='/inventory/fbp-replenishment') return inventoryTabKey({path:route.path,status:fbpRouteStatus(route.query)});
  return route.path.startsWith('/inventory/products/') ? '/inventory/products' : route.path;
}
