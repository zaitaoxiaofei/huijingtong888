// Keep writes to one physical inventory sequential; bound independent work to
// two lanes so large selections do not consume the whole database pool.
export async function runPurchaseBatchGroups(groups,operation,{isCurrent=()=>true}={}) {
 const byProduct=new Map();
 for(const group of groups){const id=Number(group.product_id||group.rows?.[0]?.product_id);if(!byProduct.has(id))byProduct.set(id,[]);byProduct.get(id).push(group);}
 const lanes=[...byProduct.values()];let next=0,firstError;
 async function worker(){
  while(isCurrent()){
   const lane=lanes[next++];if(!lane)return;
   for(const group of lane){if(!isCurrent())return;try{await operation(group);}catch(error){firstError??=error;}}
  }
 }
 await Promise.all(Array.from({length:Math.min(2,lanes.length)},worker));
 if(firstError)throw firstError;
}
