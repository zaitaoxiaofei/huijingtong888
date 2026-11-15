import {inventoryTenantSql} from './inventory-tenant-scope.js';
import {summarizeOzonReturns} from './ozon-return-state.js';
const decode=value=>typeof value==='string'?JSON.parse(value):value;
export async function enrichOrdersWithOzonReturns(rows,scope,query) {
  const ids=[...new Set(rows.map(r=>Number(r.order_id??r.id)).filter(Number.isSafeInteger))];if(!ids.length)return rows;
  const groups=new Map();
  for(let offset=0;offset<ids.length;offset+=500){const batch=ids.slice(offset,offset+500);
    const observations=await query(`SELECT r.order_id,r.state_json,r.observed_at FROM ozon_return_observations r JOIN shops s ON s.id=r.shop_id
      JOIN orders o ON o.id=r.order_id AND o.shop_id=r.shop_id AND BINARY o.posting_number=BINARY r.posting_number
      WHERE r.tenant_id=? AND ${inventoryTenantSql(scope,'s')} AND r.order_id IN (${batch.map(()=>'?').join(',')})`,[scope.id,...batch]);
    for(const row of observations){if(!groups.has(Number(row.order_id)))groups.set(Number(row.order_id),[]);groups.get(Number(row.order_id)).push({...decode(row.state_json),observed_at:row.observed_at});}
  }
  return rows.map(row=>{const records=groups.get(Number(row.order_id??row.id));return records?{...row,aftersale:summarizeOzonReturns(records)}:row;});
}
