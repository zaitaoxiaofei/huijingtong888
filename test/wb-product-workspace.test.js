import test from 'node:test';
import assert from 'node:assert/strict';
import {createWbProductWorkspace,wbProductView,saveWbProductCard} from '../src/services/wb-product-workspace.js';

const card=(nmID=100,sizes=[200])=>({nmID,vendorCode:`ITEM-${nmID}`,title:`Product ${nmID}`,createdAt:'2026-11-12T01:00:00Z',brand:'Brand',dimensions:{length:12,width:8,height:4,weightBrutto:.22},photos:[{big:'https://example.test/main.jpg'},{big:'https://example.test/detail.jpg'}],sizes:sizes.map(chrtID=>({chrtID,skus:[`barcode-${chrtID}`]}))});
const stored=(value,tenant=2,shop=20)=>({id:value.nmID,tenant_id:tenant,shop_id:shop,nm_id:value.nmID,vendor_code:value.vendorCode,title:value.title,raw_json:JSON.stringify(value),synced_at:'2026-11-13 01:00:00'});
const clone=value=>structuredClone(value);

function fixture({cards=[stored(card())],warehouse=55,priceReply,stockReply,mappingFailure=false,creatorFailure=false,prepareFailure=false,actor=7}={}){
 let state={cards:clone(cards),products:[],mappings:[]},queue=Promise.resolve();
 const connectionStates=new WeakMap(),calls=[],remote=[],creations=[],accounts=[];
 const a={tenant_id:2,shop_id:20,name:'Current WB shop',wb_warehouse_id:warehouse,environment:'production'};
 async function execute(db,sql,args){
  calls.push({sql,args:clone(args)});
  if(sql.startsWith('SELECT id, slug FROM tenants'))return args[0]===2?[{id:2,slug:'customer-a'}]:[];
  if(sql.startsWith('SELECT id FROM shops')){assert.match(sql,/FOR UPDATE$/);assert.deepEqual(args,[20,2]);return [{id:20}];}
  if(sql.startsWith('SELECT * FROM wb_product_cards'))return db.cards.filter(row=>row.tenant_id===args[0]&&row.shop_id===args[1]&&(args.length<3||row.nm_id===args[2]));
  if(sql.startsWith('UPDATE wb_product_cards SET raw_json=')){
   const row=db.cards.find(row=>row.id===args[1]&&row.tenant_id===args[2]&&row.shop_id===args[3]);
   if(!row)return {affectedRows:0};const value=JSON.parse(row.raw_json);value._erp_snapshot=JSON.parse(args[0]);row.raw_json=JSON.stringify(value);return {affectedRows:1};
  }
  if(sql.startsWith('INSERT INTO wb_product_cards')){
   const value=JSON.parse(args[5]),old=db.cards.find(row=>row.tenant_id===args[0]&&row.shop_id===args[1]&&row.nm_id===args[2]);
   if(old){const snapshot=JSON.parse(old.raw_json)._erp_snapshot;if(snapshot)value._erp_snapshot=snapshot;Object.assign(old,{vendor_code:args[3],title:args[4],raw_json:JSON.stringify(value)});}
   else db.cards.push(stored(value,args[0],args[1]));return {affectedRows:1};
  }
  if(sql.startsWith('SELECT sm.product_id')){
   assert.ok(sql.includes('(p.tenant_id = 2)'));assert.match(sql,/FOR UPDATE$/);
   const mapping=db.mappings.find(row=>row.tenant_id===args[0]&&row.shop_id===args[1]&&row.ozon_sku===args[2]),product=mapping&&db.products.find(row=>row.id===mapping.product_id&&row.tenant_id===2);
   return product?[{product_id:product.id,code:product.code,active:product.active}]:[];
  }
  if(sql.startsWith('INSERT INTO sku_mappings')){
   if(mappingFailure)throw Object.assign(Error('simulated mapping insert failure'),{code:'ER_DUP_ENTRY'});
   db.mappings.push({tenant_id:args[0],shop_id:args[1],product_id:args[2],ozon_sku:args[3],offer_id:args[4]});return {affectedRows:1};
  }
  throw Error('Unexpected query: '+sql);
 }
 const query=async(sql,args)=>clone(await execute(state,sql,args));
 const account=async(tenant,shop)=>{accounts.push([tenant,shop]);if(Number(tenant)!==2||Number(shop)!==20)throw Object.assign(Error('Shop does not belong to current tenant'),{statusCode:404});return a;};
 const dependencies={query,account,actorId:actor,
  prepareInventoryProduct:async()=>{calls.push({sql:'[prepare]',args:[]});if(prepareFailure)throw Error('simulated preparation failure');},
  transaction:work=>{
   calls.push({sql:'[transaction]',args:[]});
   const task=queue.then(async()=>{const pending=clone(state),connection={execute:async(sql,args)=>[clone(await execute(pending,sql,args))]};connectionStates.set(connection,pending);const result=await work(connection);state=pending;return result;});
   queue=task.catch(()=>{});return task;
  },
  request:async(account,service,path,options={})=>{
   assert.equal(account,a);remote.push({tenant:account.tenant_id,shop:account.shop_id,service,path,options:clone(options)});
   if(path==='/content/v2/get/cards/list'){assert.equal(options.method,'POST');return {cards:[card()]};}
   if(path==='/api/v2/list/goods/filter')return priceReply?priceReply(options):{data:{listGoods:options.query.offset?[]:[{nmID:100,currencyIsoCode4217:'CNY',discount:0,sizes:[{sizeID:200,price:258,discountedPrice:258}]}]}};
   if(path.startsWith('/api/v3/stocks/'))return stockReply?stockReply(options):{stocks:options.body.chrtIds.map(chrtId=>({chrtId,amount:0}))};
   throw Error('Unexpected remote operation: '+path);
  },
  syncProducts:async(tenant,body)=>{assert.equal(tenant,2);assert.equal(Number(body.shop_id),20);},
  products:async(tenant,body)=>{assert.equal(tenant,2);assert.equal(Number(body.shop_id),20);return {rows:state.cards.filter(row=>row.tenant_id===2&&row.shop_id===20).map(row=>wbProductView(row,a))};},
  createInventoryProduct:async(payload,connection,tenant)=>{
   assert.equal(tenant,2);const pending=connectionStates.get(connection);assert.ok(pending,'product writer must use the active transaction connection');
   creations.push({payload:clone(payload),tenant});const product={id:500+pending.products.length,tenant_id:tenant,code:`LOCAL-${pending.products.length+1}`,active:1,...payload};pending.products.push(product);
   if(creatorFailure)throw Error('simulated product writer failure');return {id:product.id,code:product.code};
  }
 };
 return {service:createWbProductWorkspace(dependencies),query,remote,calls,creations,accounts,state:()=>clone(state),setState:value=>{state=clone(value);}};
}

test('WB cached product projection distinguishes zero, unknown, partial stock and warehouse changes',()=>{
 const value=card(100,[200,201]);value._erp_snapshot={price_info:{currency:'CNY',sizes:[{chrt_id:200,price:0}]},stock_info:{warehouse_id:55,synced_at:'2026-11-13T01:00:00Z',sizes:[{chrt_id:200,amount:0},{chrt_id:201,amount:'0'}],error:''}};
 const source=stored(value),before=clone(source),a={name:'WB shop',wb_warehouse_id:55};
 const zero=wbProductView(source,a);assert.equal(zero.fbs_stock,0);assert.equal(zero.stock_synced_at,value._erp_snapshot.stock_info.synced_at);assert.equal(zero.price_info.sizes[0].price,0);assert.equal(zero.card._erp_snapshot,undefined);assert.equal(zero.shop_name,'WB shop');assert.equal(zero.published_at,value.createdAt);assert.equal(zero.rating,null);assert.equal(zero.online_status,'in_catalog');assert.deepEqual(source,before);
 assert.equal(wbProductView(stored(card()),a).fbs_stock,null);
 value._erp_snapshot.stock_info.sizes.pop();assert.equal(wbProductView(stored(value),a).fbs_stock,null);
 const changed=wbProductView(source,{...a,wb_warehouse_id:99});assert.equal(changed.fbs_stock,null);assert.equal(changed.stock_info,null);assert.equal(changed.stock_synced_at,null);assert.match(changed.stock_error,/卖家仓绑定已变化/);
 const archived=card();archived._wb_archived=true;archived.createdAt='bad timestamp';assert.equal(wbProductView(stored(archived),a).online_status,'archived');assert.equal(wbProductView(stored(archived),a).published_at,null);
});

test('WB cached stock rejects malformed quantities instead of claiming known zero',()=>{
 for(const amount of [null,undefined,'',' ',-1,'not-a-number',false,true]){
  const value=card();value._erp_snapshot={stock_info:{warehouse_id:55,sizes:[{chrt_id:200,amount}]}};
  assert.equal(wbProductView(stored(value),{wb_warehouse_id:55}).fbs_stock,null);
 }
});

test('a card with missing WB size identities cannot display an earlier size snapshot as current stock',async()=>{
 const value=card();value._erp_snapshot={stock_info:{warehouse_id:55,synced_at:'earlier',sizes:[{chrt_id:200,amount:0}]}};
 value.sizes=[{skus:['barcode-200']}];
 assert.equal(wbProductView(stored(value),{wb_warehouse_id:55}).fbs_stock,null);
 const f=fixture({cards:[stored(value)]}),result=await f.service.refreshProductSnapshots(2,{shop_id:20});
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].fbs_stock,null);assert.equal(result.rows[0].stock_synced_at,null);
 assert.ok(result.rows[0].stock_error);assert.ok(!f.remote.some(call=>call.path.includes('/stocks/')),'invalid size identities are never sent to the platform');
});

test('WB snapshot refresh uses only authenticated-shop reads and modern chrtIds stock batches',async()=>{
 const value=card(100,Array.from({length:1002},(_,index)=>index+1)),foreign=stored(card(999,[9999]),3,30),f=fixture({cards:[stored(value),foreign]});
 const result=await f.service.refreshProductSnapshots(2,{shop_id:20,tenant_id:3});
 assert.equal(result.ok,true);assert.equal(result.rows.length,1);assert.equal(result.rows[0].fbs_stock,0);assert.ok(result.rows[0].stock_synced_at);
 const stockCalls=f.remote.filter(call=>call.path.includes('/stocks/'));assert.equal(stockCalls.length,2);assert.deepEqual(stockCalls.map(call=>call.options.body.chrtIds.length),[1000,2]);
 assert.ok(stockCalls.every(call=>call.service==='marketplace'&&call.path==='/api/v3/stocks/55'&&call.options.method==='POST'&&Object.keys(call.options.body).join()==='chrtIds'));
 assert.ok(f.remote.every(call=>call.tenant===2&&call.shop===20));assert.ok(!f.remote.some(call=>/upload|media|barcodes|\/task|\/stocks.*\/(?:set|delete)/.test(call.path)));
 assert.deepEqual(f.state().cards.find(row=>row.tenant_id===3),foreign);
 await assert.rejects(f.service.refreshProductSnapshots(3,{shop_id:20}),error=>error.statusCode===404);
 await assert.rejects(f.service.refreshProductSnapshots(2,{shop_id:30}),error=>error.statusCode===404);
});

test('WB missing prices or transient service errors preserve products and never turn missing stock into zero',async()=>{
 const value=card();value._erp_snapshot={price_info:{currency:'CNY',sizes:[{chrt_id:200,price:258}],synced_at:'earlier'}};
 const failed=fixture({cards:[stored(value)],priceReply:()=>{throw Error('prices unavailable');},stockReply:()=>{throw Error('stocks unavailable');}});
 const result=await failed.service.refreshProductSnapshots(2,{shop_id:20,nm_id:100});
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].price_info.sizes[0].price,258);assert.match(result.rows[0].price_error,/prices unavailable/);assert.equal(result.rows[0].fbs_stock,null);assert.equal(result.rows[0].stock_synced_at,null);assert.match(result.rows[0].stock_error,/stocks unavailable/);assert.equal(result.warnings.length,2);
 const missing=fixture({priceReply:()=>({data:{listGoods:[]}}),stockReply:()=>({stocks:[]})});
 const absent=await missing.service.refreshProductSnapshots(2,{shop_id:20,nm_id:100});assert.equal(absent.rows.length,1);assert.equal(absent.rows[0].price_info,null);assert.match(absent.rows[0].price_error,/未返回.*价格/);assert.equal(absent.rows[0].fbs_stock,null);assert.match(absent.rows[0].stock_error,/部分规格/);
 const noWarehouse=fixture({warehouse:null});const unbound=await noWarehouse.service.refreshProductSnapshots(2,{shop_id:20});assert.equal(unbound.rows[0].fbs_stock,null);assert.match(unbound.rows[0].stock_error,/绑定 WB 卖家仓/);assert.ok(!noWarehouse.remote.some(call=>call.path.includes('/stocks/')));
});

test('WB refreshing one product verifies ownership before remote calls and preserves existing cached snapshots',async()=>{
 const value=card();value._erp_snapshot={price_info:{currency:'CNY',sizes:[{chrt_id:200,price:258}]}};
 const foreign=stored(card(999),3,30),f=fixture({cards:[stored(value),foreign]});
 await assert.rejects(f.service.refreshProducts(2,{shop_id:20,nm_id:999}),error=>error.statusCode===404);assert.equal(f.remote.length,0);
 const refreshed=await f.service.refreshProducts(2,{shop_id:20,nm_id:100});assert.equal(refreshed.rows.length,1);assert.equal(refreshed.rows[0].nm_id,100);assert.equal(refreshed.rows[0].fbs_stock,0);assert.deepEqual(f.state().cards.find(row=>row.tenant_id===3),foreign);
 const calls=[];await saveWbProductCard(async(sql,args)=>{calls.push({sql,args});return {affectedRows:1};},{tenant_id:2,shop_id:20},{...card(),_erp_snapshot:{untrusted:'must not overwrite cache'}});
 assert.ok(calls[0].sql.includes("COALESCE(JSON_EXTRACT(raw_json,'$._erp_snapshot'),JSON_OBJECT())"));assert.equal(JSON.parse(calls[0].args[5])._erp_snapshot,undefined);assert.deepEqual(calls[0].args.slice(0,3),[2,20,100]);
});

test('creating WB local inventory is idempotent and atomically binds only the owned current-tenant size',async()=>{
 const f=fixture(),input={shop_id:20,nm_id:100,chrt_id:200,tenant_id:3};
 const [first,second]=await Promise.all([f.service.createProductInventory(2,input),f.service.createProductInventory(2,input)]);
 assert.equal(first.reused,false);assert.equal(second.reused,true);assert.equal(first.product_id,second.product_id);assert.equal(f.creations.length,1);
 const saved=f.state();assert.equal(saved.products.length,1);assert.equal(saved.mappings.length,1);assert.deepEqual(saved.mappings[0],{tenant_id:2,shop_id:20,product_id:first.product_id,ozon_sku:'WB-200',offer_id:'ITEM-100'});
 const payload=f.creations[0].payload;assert.equal(payload.name,'Product 100');assert.equal(payload.package_weight_g,220);assert.equal(payload.length_cm,12);assert.equal(payload.width_cm,8);assert.equal(payload.height_cm,4);assert.equal(payload.owner_person_id,7);assert.equal(payload.created_by_person_id,7);assert.equal(payload.source_platform,'wb');assert.equal(payload.image_url,'https://example.test/main.jpg');assert.deepEqual(payload.detail_image_urls,['https://example.test/detail.jpg']);
 assert.equal(f.remote.length,0,'creating local inventory never calls WB');
 await assert.rejects(f.service.createProductInventory(3,input),error=>error.statusCode===404);
 await assert.rejects(f.service.createProductInventory(2,{...input,shop_id:30}),error=>error.statusCode===404);
 await assert.rejects(f.service.createProductInventory(2,{...input,chrt_id:999}),error=>error.statusCode===404);assert.deepEqual(f.state(),saved);
});

test('WB local inventory failures roll back both product creation and mapping instead of leaving orphans',async()=>{
 for(const options of [{mappingFailure:true},{creatorFailure:true}]){
  const f=fixture(options),before=f.state();
  await assert.rejects(f.service.createProductInventory(2,{shop_id:20,nm_id:100,chrt_id:200}),/simulated/);
  assert.deepEqual(f.state(),before);assert.equal(f.remote.length,0);
 }
 const noPackage=card();noPackage.dimensions.weightBrutto=null;const invalid=fixture({cards:[stored(noPackage)]});
 await assert.rejects(invalid.service.createProductInventory(2,{shop_id:20,nm_id:100,chrt_id:200}),error=>error.statusCode===409&&error.message.includes('包装'));assert.equal(invalid.creations.length,0);
 const inactive=fixture(),state=inactive.state();state.products.push({id:500,tenant_id:2,code:'OLD',active:0});state.mappings.push({tenant_id:2,shop_id:20,product_id:500,ozon_sku:'WB-200'});inactive.setState(state);
 await assert.rejects(inactive.service.createProductInventory(2,{shop_id:20,nm_id:100,chrt_id:200}),error=>error.statusCode===409&&error.message.includes('停用'));assert.equal(inactive.creations.length,0);assert.deepEqual(inactive.state(),state);
});


test('WB local creation completes shared schema preparation before the transaction and any row locks',async()=>{
 const f=fixture();await f.service.createProductInventory(2,{shop_id:20,nm_id:100,chrt_id:200});
 const prepare=f.calls.findIndex(call=>call.sql==='[prepare]'),transaction=f.calls.findIndex(call=>call.sql==='[transaction]'),firstLock=f.calls.findIndex(call=>call.sql.includes('FOR UPDATE'));
 assert.ok(prepare>=0&&prepare<transaction&&transaction<firstLock);
 const failed=fixture({prepareFailure:true});await assert.rejects(failed.service.createProductInventory(2,{shop_id:20,nm_id:100,chrt_id:200}),/preparation failure/);
 assert.equal(failed.creations.length,0);assert.ok(!failed.calls.some(call=>call.sql==='[transaction]'||call.sql.includes('FOR UPDATE')));
});

test('WB local package overrides recover missing platform dimensions without changing the source card',async()=>{
 const value=card();value.dimensions={length:null,width:null,height:null,weightBrutto:null};const f=fixture({cards:[stored(value)]}),before=f.state().cards;
 await f.service.createProductInventory(2,{shop_id:20,nm_id:100,chrt_id:200,length_cm:15,width_cm:9,height_cm:5,package_weight_g:330,name:'Local custom name'});
 const product=f.creations[0].payload;assert.equal(product.name,'Local custom name');assert.equal(product.package_weight_g,330);assert.equal(product.length_cm,15);assert.equal(product.width_cm,9);assert.equal(product.height_cm,5);assert.deepEqual(f.state().cards,before);assert.equal(f.remote.length,0);
});
