const parse=value=>typeof value==='string'?JSON.parse(value):value;
// Reconstruct each non-recipe root once, then allocate its physical finished
// units in FIFO order. Shared loose parts stay in the ordinary coverage pool.
export function allocateBundleFinishedDemands(demands, composition, stocks) {
 const pool=new Map(stocks.map(s=>[Number(s.product_id),Math.max(0,Number(s.ledger||0)+Number(s.open_deducted||0))]));
 const groups=new Map(),output=[];
 for(const row of demands){
  const root=Number(row.root_product_id);
  if(!Number(row.needs_fulfillment)||Number(row.entered_transport)||row.stock_location==='FBP'||row.recipe_id||!composition.isBundle(root)){output.push(row);continue;}
  const key=Number(row.order_item_id);
  if(!groups.has(key))groups.set(key,{...row,product_id:root,product_name:row.root_product_name,quantity:Number(row.root_quantity)});
 }
 for(const row of [...groups.values()].sort((a,b)=>Number(b.allocation_priority||0)-Number(a.allocation_priority||0)||new Date(a.ordered_at)-new Date(b.ordered_at)||a.order_item_id-b.order_item_id)){
  const id=Number(row.product_id),take=Math.min(Number(row.quantity),Math.floor(pool.get(id)||0));
  if(take){output.push({...row,quantity:take,finished_bundle:true});pool.set(id,(pool.get(id)||0)-take);}
  if(take<row.quantity)output.push({...row,quantity:row.quantity-take,assembly_required:true});
 }
 return output;
}

// The immutable assembly event is also the batch's original BOM/cost record.
// Disassembly explicitly references it; outbound consumption uses FIFO.
export function remainingAssemblyBatches(events,physical){
 const batches=events.filter(e=>e.action==='bundle_assembly').map(e=>({id:Number(e.id),created_at:e.created_at,...parse(e.detail_json),remaining:Number(parse(e.detail_json).quantity)}));
 for(const e of events.filter(e=>e.action==='bundle_disassembly')){const d=parse(e.detail_json),batch=batches.find(b=>b.id===Number(d.batch_id));if(batch)batch.remaining-=Number(d.quantity);}
 let consumed=Math.max(0,batches.reduce((n,b)=>n+Math.max(0,b.remaining),0)-Math.max(0,physical));
 for(const b of batches){const take=Math.min(consumed,Math.max(0,b.remaining));b.remaining-=take;consumed-=take;}
 return batches.filter(b=>b.remaining>0);
}

