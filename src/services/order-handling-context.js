import {inventoryTenantSql} from './inventory-tenant-scope.js';

// Read-only enrichment for detail views; never changes allocation or demand.
export async function withOrderHandlingContext(rows, query, scope) {
  const ids=[...new Set(rows.map(row=>Number(row.order_id)).filter(id=>Number.isSafeInteger(id)&&id>0))];
  if(!ids.length)return rows;
  const byId=new Map();
  for(let offset=0;offset<ids.length;offset+=500){
    const batch=ids.slice(offset,offset+500);
    const records=await query(`SELECT o.id AS order_id,o.status AS order_status,o.tracking_stage,o.logistics_status,
      printed.printed_at,printed.print_batch_id,printed.print_sequence,mark.mark_type,mark.note AS mark_note
      FROM orders o JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
      LEFT JOIN order_label_prints printed ON printed.order_id=o.id
      LEFT JOIN order_marks mark ON mark.order_id=o.id
      WHERE o.id IN (${batch.map(()=>'?').join(',')})`,batch);
    for(const record of records)byId.set(Number(record.order_id),record);
  }
  return rows.map(row=>{
    const context=byId.get(Number(row.order_id));
    return context?{...row,...context}:row;
  });
}
