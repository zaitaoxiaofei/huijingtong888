// Bound independent display reads. Transactional conversion reads remain serial.
export async function mapBundleReads(items,read,limit=2){
 const results=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(next<items.length){const index=next++;results[index]=await read(items[index]);}
 }));
 return results;
}
