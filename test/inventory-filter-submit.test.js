import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../frontend/admin/views/inventory/InventoryProductsPage.vue',import.meta.url),'utf8');
test('query submits both search rows including multiple models and materials',async()=>{
 let request;
 const filters={query:'1-23',searchMode:'inventory_id',inventoryCategory:'钥匙壳',vehicleBrand:'TENET',vehicleModel:['T4','T7'],material:['ABS','TPU'],color:'黑色',process:'碳纤纹',accessoryName:'带扣',productName:'钥匙',fitmentType:'specific',page:1,pageSize:20};
 const context=vm.createContext({URLSearchParams,Date,Map,Math,Number,String,Array,
 state:{filters,shops:[]},loading:{value:false},selectedRows:{value:[]},dictionaryLoaded:true,
 listRequestGate:{next:()=>1,isLatest:()=>true},inventoryListCache:new Map(),INVENTORY_LIST_CACHE_TTL_MS:30000,
 apiClient:{get:async url=>{request=url;return {rows:[],total:0};}},cacheInventoryList(){},ElMessage:{error:message=>{throw new Error(message);}}
 });
 vm.runInContext(source.slice(source.indexOf('async function loadPageData()'),source.indexOf('watch(() => route.query')),context);
 await context.loadPageData();
 const params=new URL(request,'https://test.local').searchParams;
 for(const [key,value]of Object.entries(filters))assert.equal(params.get(key),String(value),key);
});
test('route restore retains multi-select values as arrays',()=>{
 const context=vm.createContext({state:{filters:{}},route:{query:{vehicleModel:'T4,T7',material:'ABS,TPU'}},filterDefaults:{},syncingRoute:false,
 applyFilterQuery:(route,filters)=>Object.assign(filters,route.query)});
 const start=source.indexOf('function applyRouteState()');
 vm.runInContext(source.slice(start,source.indexOf('const syncRouteQuery',start)),context);
 context.applyRouteState();
 assert.deepEqual(Array.from(context.state.filters.vehicleModel),['T4','T7']);
 assert.deepEqual(Array.from(context.state.filters.material),['ABS','TPU']);
});
test('batch deletion clears cached rows and reports partial failures',async()=>{
 const deleted=[],errors=[];
 const cache=new Map([['old',{}]]);
 const context=vm.createContext({selectedRows:{value:[{id:1},{id:2}]},deletingProducts:{value:false},
 ElMessageBox:{confirm:async()=>{}},apiClient:{post:async url=>{if(url.includes('/2/'))throw new Error('失败');deleted.push(url);}},
 inventoryListCache:cache,loadPageData:async()=>{},ElMessage:{error:m=>errors.push(m),success:()=>{throw new Error('unexpected success');}}});
 const start=source.indexOf('async function removeSelectedProducts()');
 vm.runInContext(source.slice(start,source.indexOf('function handleSearch()',start)),context);
 await context.removeSelectedProducts();
 assert.equal(deleted.length,1);assert.equal(cache.size,0);assert.equal(context.deletingProducts.value,false);
 assert.match(errors[0],/已删除 1 个，1 个失败/);
});
