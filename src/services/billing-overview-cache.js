// Bounded, process-local snapshots. Out-of-process writes are bounded by a
// short TTL; mutations in this process invalidate immediately after commit.
export function createBillingOverviewCache({now=Date.now,ttlMs=15000,maxEntries=40}={}) {
 const values=new Map(),pending=new Map();let revision=0;
 return {
 invalidate(){revision++;values.clear();pending.clear();},
 async read(key,loader,{force=false}={}){
  if(force){revision++;values.clear();pending.clear();}
  const generation=revision,found=values.get(key);
  if(found&&found.until>now())return {...structuredClone(found.value),overview_cache:{hit:true,calculated_at:found.at}};
  if(pending.has(key))return structuredClone(await pending.get(key));
  const work=Promise.resolve().then(loader).then(value=>{
   const at=new Date(now()).toISOString();
   if(generation===revision&&pending.get(key)===work){
    values.set(key,{value:structuredClone(value),until:now()+ttlMs,at});
    while(values.size>maxEntries)values.delete(values.keys().next().value);
   }
   return {...value,overview_cache:{hit:false,calculated_at:at}};
  }).finally(()=>{if(pending.get(key)===work)pending.delete(key);});
  pending.set(key,work);return structuredClone(await work);
 }
 };
}
export const billingOverviewCache=createBillingOverviewCache();
export function billingSourceMutation(sql,result={}) {
 if(result.affectedRows===0)return false;
 if(!/^\s*(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE)\b/i.test(sql))return false;
 return /\b(orders|order_items|order_profit\w*|ozon_finance\w*|ozon_return\w*|finance_\w*|ai_image_usage_events|ai_variant_lab_\w*|shops|products|sku_mappings|tenant_members|tenants)\b/i.test(sql);
}
export function noteBillingSourceMutation(sql,result){if(billingSourceMutation(sql,result))billingOverviewCache.invalidate();}
