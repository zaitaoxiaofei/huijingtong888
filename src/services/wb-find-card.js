const fail=message=>Object.assign(new Error(message),{statusCode:502});
// WB search can lag behind the card list. An empty search is not proof that
// creating this vendor code is safe. Verify the paginated list before returning null.
export async function findWbCard(request,account,vendorCode,{nmId,maxPages=20,trash=false,matchById=false}={}){
 const read=async(filter,cursor={limit:100})=>{
  const result=await request(account,'content',trash?'/content/v2/get/cards/trash':'/content/v2/get/cards/list',{method:'POST',query:{locale:'zh'},body:{settings:{cursor,sort:{ascending:true},filter:{...(!trash?{withPhoto:-1}:{}),...filter}}}});
  if(!Array.isArray(result.cards))throw fail('WB 未返回有效商品卡列表，请稍后核对。');return result;
 };
 const match=cards=>{const found=cards.filter(c=>matchById&&nmId?Number(c.nmID)===Number(nmId):c.vendorCode===vendorCode);if(found.length>1)throw fail('WB 返回多个相同货号商品，请人工核对。');return found[0]||null;};
 const searched=await read({textSearch:String(nmId||vendorCode)}),direct=match(searched.cards);if(direct)return direct;
 let cursor={limit:100};const seen=new Set();
 for(let page=0;page<maxPages;page++){
  const result=await read({},cursor),card=match(result.cards);if(card)return card;
  if(result.cards.length<100&&Number(result.cursor?.total??result.cards.length)<100)return null;
  const next=result.cursor,dateKey=trash?'trashedAt':'updatedAt',key=JSON.stringify([next?.[dateKey],next?.nmID]);
  if(!next?.[dateKey]||!Number.isSafeInteger(Number(next.nmID))||seen.has(key))throw fail('WB 商品列表分页未完成，不能确认货号是否已存在；已停止创建，请稍后核对。');
  seen.add(key);cursor={limit:100,[dateKey]:next[dateKey],nmID:Number(next.nmID)};
 }
 throw fail('WB 商品列表尚未核对完，已停止创建以避免重复商品；请稍后核对。');
}
