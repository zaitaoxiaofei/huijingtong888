// Cache only within one display request; return independent rows because ledger
// projections may annotate results. Never use this wrapper for writes.
export function bundleReadQuery(query){
 const pending=new Map();
 return async(sql,args=[])=>{
  const key=JSON.stringify([sql,args]);
  if(!pending.has(key))pending.set(key,Promise.resolve().then(()=>query(sql,args)));
  return structuredClone(await pending.get(key));
 };
}
