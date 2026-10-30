// Keep exact filtering/counts: compute one coverage snapshot for the whole
// requested inventory set, not one full order-history scan per forty products.
export function createInventoryWorkspaceReader({batch,coverage,revision,now=Date.now}) {
  const entries=new Map();
  return async function read(ids,tenantId,{fresh=false}={}) {
    const products=[...new Set(ids.map(Number))].sort((a,b)=>a-b);
    if(!products.length)return [];
    const epoch=revision(),key=`${tenantId}:${products.join(',')}`;
    const previous=entries.get(key);
    if(previous?.epoch===epoch){
      if(previous.pending)return previous.pending;
      if(!fresh&&previous.expires>now())return previous.value;
    }
    // Bound cache memory across tenants/searches; eviction never affects correctness.
    if(entries.size>=8)entries.delete(entries.keys().next().value);
    const entry={epoch};entries.set(key,entry);
    entry.pending=(async()=>{
      const snapshot=await coverage(products,tenantId),values=[];
      // Bound SQL parameter lists and forecast payloads without rescanning history.
      for(let i=0;i<products.length;i+=200)values.push(...await batch(products.slice(i,i+200),tenantId,{coverage:snapshot,fresh:true,cache:false}));
      entry.value=values;entry.expires=now()+20000;return values;
    })();
    try{return await entry.pending;}
    catch(error){if(entries.get(key)===entry)entries.delete(key);throw error;}
    finally{entry.pending=null;}
  };
}
