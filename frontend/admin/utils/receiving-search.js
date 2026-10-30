import {inventorySearchDefaults,appendInventorySearch} from '../../../src/shared/inventory-search-fields.js';
import {applyFilterQuery} from '../views/inventory/inventory-utils.js';
export const receivingFilters = status => ({...inventorySearchDefaults(),searchMode:'inventory_id',query:'',inventoryType:'all',demandType:'all',productId:'',status,page:1,pageSize:20});
export function restoreReceivingFilters(query,filters,status) {
  const source={...query,productName:query.filterProductName || (query.orderId?'':query.productName)};
  applyFilterQuery({query:source},filters,receivingFilters(status));
  filters.status=status;
}
export function receivingParams(filters,status) {
  const params=appendInventorySearch(new URLSearchParams({paged:'1',page:String(filters.page),pageSize:String(filters.pageSize),status}),filters);
  for(const key of ['query','productId','inventoryType','demandType'])if(filters[key] && filters[key]!=='all')params.set(key,String(filters[key]).trim());
  return params.toString();
}
export function receivingRouteQuery(current,filters) {
  const next={...current};
  for(const key of ['status','personId','supplierId','sourceType','startDate','endDate','dateFrom','dateTo','purchaseDateRange'])delete next[key];
  const defaults=receivingFilters(filters.status);
  for(const key of Object.keys(defaults)) {
    if(key==='status')continue;
    const target=key==='productName' && current.orderId?'filterProductName':key;
    const value=Array.isArray(filters[key])?filters[key].join(','):String(filters[key]??'');
    if(value && value!==String(defaults[key]??''))next[target]=value;else delete next[target];
  }
  return next;
}
