import {findWbCard} from './wb-find-card.js';
import {resolveInventoryTenantScope,inventoryTenantSql} from './inventory-tenant-scope.js';

const parse=value=>typeof value==='string'?JSON.parse(value):value;
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const id=value=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<=0)throw fail('请选择有效的 WB 店铺、商品和规格。');return number;};
const amount=value=>['number','string'].includes(typeof value)&&(typeof value!=='string'||value.trim()!=='')&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const time=value=>value&&Number.isFinite(Date.parse(value))?value:null;

export function wbProductView(row,account={}){
 const card={...parse(row.raw_json||row.card||{})},snapshot=card._erp_snapshot||{};delete card._erp_snapshot;
 const stock=snapshot.stock_info||null,currentWarehouse=Number(account.wb_warehouse_id)||null,warehouseMatches=stock&&(Number(stock.warehouse_id)||null)===currentWarehouse;
 const sizes=card.sizes||[],stockSizes=warehouseMatches?sizes.map(size=>stock.sizes?.find(value=>Number(value.chrt_id)===Number(size.chrtID))):[];
 const complete=warehouseMatches&&currentWarehouse!==null&&sizes.length>0&&stockSizes.every(size=>amount(size?.amount)!==null);
 return {...row,raw_json:undefined,card,shop_name:account.name||row.shop_name||'',online_status:card._wb_archived?'archived':'in_catalog',
  published_at:time(card.createdAt),price_info:snapshot.price_info||null,price_error:snapshot.price_error||'',
  stock_info:warehouseMatches?stock:null,fbs_stock:complete?stockSizes.reduce((sum,size)=>sum+Number(size.amount),0):null,
  stock_synced_at:warehouseMatches?stock.synced_at:null,stock_error:stock&&!warehouseMatches?'卖家仓绑定已变化，请重新同步库存。':stock?.error||'',rating:null};
}

export async function saveWbProductCard(query,a,card){
 const clean={...card};delete clean._erp_snapshot;
 await query(`INSERT INTO wb_product_cards (tenant_id,shop_id,nm_id,vendor_code,title,raw_json,synced_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())
  ON DUPLICATE KEY UPDATE vendor_code=VALUES(vendor_code),title=VALUES(title),raw_json=JSON_SET(VALUES(raw_json),'$._erp_snapshot',COALESCE(JSON_EXTRACT(raw_json,'$._erp_snapshot'),JSON_OBJECT())),synced_at=VALUES(synced_at)`,
 [a.tenant_id,a.shop_id,id(card.nmID),String(card.vendorCode||''),String(card.title||''),JSON.stringify(clean)]);
}

export function createWbProductWorkspace({query,transaction,request,account,syncProducts,products,createInventoryProduct,prepareInventoryProduct=async()=>{},actorId}){
 async function refreshProducts(tenantId,body){
  const a=await account(tenantId,body.shop_id),nm=body.nm_id?id(body.nm_id):null;
  if(nm){
   const [owned]=await query('SELECT * FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=?',[a.tenant_id,a.shop_id,nm]);
   if(!owned)throw fail('商品不属于当前企业和店铺，请先同步商品。',404);
   const archived=Boolean(parse(owned.raw_json)._wb_archived),card=await findWbCard(request,a,owned.vendor_code,{nmId:nm,matchById:true,trash:archived});
   if(!card)throw fail('WB 商品库暂未返回此商品，请核对店铺及商品状态。',409);
   await saveWbProductCard(query,a,archived?{...card,_wb_archived:true}:card);
  }else await syncProducts(tenantId,body);
  return refreshProductSnapshots(tenantId,body);
 }
 async function refreshProductSnapshots(tenantId,body){
  const a=await account(tenantId,body.shop_id),nm=body.nm_id?id(body.nm_id):null;
  const rows=await query(`SELECT * FROM wb_product_cards WHERE tenant_id=? AND shop_id=?${nm?' AND nm_id=?':''}`,[a.tenant_id,a.shop_id,...(nm?[nm]:[])]);
  const now=new Date().toISOString(),warnings=[],prices=new Map(),stocks=new Map();let priceError='',stockError='';
  if(!rows.length)return {ok:true,rows:[],warnings};
  try{
   let finished=false;
   for(let offset=0;offset<100000;offset+=1000){
    const result=await request(a,'prices','/api/v2/list/goods/filter',{query:{limit:1000,offset,filterNmID:nm||undefined}}),goods=result.data?.listGoods;
    if(!Array.isArray(goods))throw fail('WB 未返回有效价格列表。',502);
    for(const item of goods)prices.set(Number(item.nmID),item);
    if(nm||!goods.length){finished=true;break;}
   }
   if(!finished)throw fail('WB 价格分页未完成，请稍后分批同步。',502);
  }catch(error){priceError=error.message;warnings.push('价格同步未完成：'+priceError);}
  try{
   if(!a.wb_warehouse_id)throw fail('请由企业管理员在企业店铺绑定 WB 卖家仓，再同步 FBS 库存。',409);
   const ids=[...new Set(rows.flatMap(row=>(parse(row.raw_json).sizes||[]).map(size=>id(size.chrtID))))];
   for(let offset=0;offset<ids.length;offset+=1000){
    const chunk=ids.slice(offset,offset+1000),result=await request(a,'marketplace',`/api/v3/stocks/${a.wb_warehouse_id}`,{method:'POST',body:{chrtIds:chunk}});
    if(!Array.isArray(result.stocks))throw fail('WB 未返回有效库存列表。',502);
    for(const stock of result.stocks)if(chunk.includes(Number(stock.chrtId))&&Number.isInteger(amount(stock.amount)))stocks.set(Number(stock.chrtId),Number(stock.amount));
   }
  }catch(error){stockError=error.message;warnings.push('库存同步未完成：'+stockError);}
  for(const row of rows){
   const card=parse(row.raw_json),sizes=card.sizes||[],snapshot={...(card._erp_snapshot||{})},price=prices.get(Number(row.nm_id));
   if(!priceError){
    if(price&&typeof price.currencyIsoCode4217==='string'&&price.currencyIsoCode4217&&Array.isArray(price.sizes))snapshot.price_info={currency:price.currencyIsoCode4217,discount:price.discount,sizes:price.sizes.map(size=>({chrt_id:Number(size.sizeID),price:amount(size.discountedPrice),original_price:amount(size.price)})),synced_at:now};
    else snapshot.price_info=null;
   }
   snapshot.price_error=priceError||(!snapshot.price_info?'WB 暂未返回此商品价格，请稍后同步。':'');
   const stockSizes=sizes.map(size=>({chrt_id:Number(size.chrtID),amount:stockError?null:stocks.get(Number(size.chrtID))??null}));
   snapshot.stock_info={warehouse_id:a.wb_warehouse_id||null,sizes:stockSizes,synced_at:stockError?null:now,error:stockError||(stockSizes.some(size=>size.amount===null)?'WB 未返回部分规格的库存，请重新同步核对。':'')};
   await query("UPDATE wb_product_cards SET raw_json=JSON_SET(raw_json,'$._erp_snapshot',CAST(? AS JSON)) WHERE id=? AND tenant_id=? AND shop_id=?",[JSON.stringify(snapshot),row.id,a.tenant_id,a.shop_id]);
  }
  const result=await products(tenantId,{shop_id:a.shop_id});
  return {ok:true,rows:nm?result.rows.filter(row=>Number(row.nm_id)===nm):result.rows,warnings};
 }
 async function createProductInventory(tenantId,body){
  const a=await account(tenantId,body.shop_id),nm=id(body.nm_id),chrt=id(body.chrt_id),actor=id(actorId);
  if(!createInventoryProduct)throw fail('本地库存创建暂不可用，请稍后重试。',503);
  const scope=await resolveInventoryTenantScope(a.tenant_id,query);
  // Shared inventory preparation can run DDL on another connection. Complete it
  // before taking the shop/card/mapping locks used by atomic product creation.
  await prepareInventoryProduct();
  return transaction(async connection=>{
   const q=async(sql,args)=>{const [rows]=await connection.execute(sql,args);return rows;};
   await q('SELECT id FROM shops WHERE id=? AND tenant_id=? FOR UPDATE',[a.shop_id,a.tenant_id]);
   const [owned]=await q('SELECT * FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=? FOR UPDATE',[a.tenant_id,a.shop_id,nm]);
   const card=owned&&parse(owned.raw_json),size=card?.sizes?.find(size=>Number(size.chrtID)===chrt);
   if(!size)throw fail('WB 商品规格不属于当前店铺，请同步商品后重新选择。',404);
   const sku=`WB-${chrt}`,[existing]=await q(`SELECT sm.product_id,p.code,p.active FROM sku_mappings sm LEFT JOIN products p ON p.id=sm.product_id AND ${inventoryTenantSql(scope,'p')} WHERE sm.tenant_id=? AND sm.shop_id=? AND sm.ozon_sku=? FOR UPDATE`,[a.tenant_id,a.shop_id,sku]);
   if(existing){if(!existing.active)throw fail('此规格已绑定停用库存产品，请先核对原库存绑定。',409);return {ok:true,product_id:existing.product_id,code:existing.code,reused:true};}
   const dimensions={length:body.length_cm??card.dimensions?.length,width:body.width_cm??card.dimensions?.width,height:body.height_cm??card.dimensions?.height,weightBrutto:body.package_weight_g!==undefined?Number(body.package_weight_g)/1000:card.dimensions?.weightBrutto},name=String(body.name||card.title||'').trim();
   if(!name||name.length>255)throw fail('库存产品名称：请填写 1–255 个字符。');
   if(['length','width','height','weightBrutto'].some(key=>!(amount(dimensions[key])>0)))throw fail('本地库存包装尺寸和重量缺失，请在“创建库存”中填写包装长、宽、高（cm）及重量（g）；也可先同步 WB 包装资料。',409);
   const photos=(card.photos||[]).map(photo=>photo.big||photo.c516x688).filter(Boolean);
   const product=await createInventoryProduct({name,image_url:photos[0]||'',detail_image_urls:photos.slice(1),source_platform:'wb',supplier_note:`WB ${nm} / ${card.vendorCode||''} / ${sku}`,package_weight_g:Number(dimensions.weightBrutto)*1000,length_cm:Number(dimensions.length),width_cm:Number(dimensions.width),height_cm:Number(dimensions.height),owner_person_id:actor,created_by_person_id:actor,product_type:'main',stock_unit:'个'},connection,scope.id);
   await q('INSERT INTO sku_mappings (tenant_id,shop_id,product_id,ozon_sku,offer_id,commission_low,commission_high) VALUES (?,?,?,?,?,0,0)',[a.tenant_id,a.shop_id,product.id,sku,String(card.vendorCode||'')]);
   return {ok:true,product_id:product.id,code:product.code,reused:false};
  });
 }
 return {refreshProducts,refreshProductSnapshots,createProductInventory};
}
