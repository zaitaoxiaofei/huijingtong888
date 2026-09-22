import { normalizeVehicleBrand, vehicleBrandAliases, VEHICLE_BRAND_CHINESE } from "../src/shared/vehicle-brand.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function catalogHarness(existing = null) {
  let row = existing; const writes = [];
  const context = vm.createContext({ normalizeVehicleBrand, vehicleBrandAliases, VEHICLE_BRAND_CHINESE,
    mysqlExecute: async (sql, params) => {
      writes.push({sql,params});
      if (!row) row = { id: 91, brand_name: params[1], model_name: params[3], tags_json: params[4], enabled: 1 };
      return { insertId: row.id };
    },
    mysqlQuery: async () => row ? [row] : []
  });
  const source = fs.readFileSync(new URL('../src/services/ai-vehicle-catalog.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('export async function','async function');
  vm.runInContext(`${source}\nschemaReady=true;`,context);
  return {context,writes,get row(){return row;}};
}

test('new brand uses uppercase English and adding a model returns its persistent ID',async()=>{
  const h=catalogHarness();
  const saved=await h.context.addAiVehicleCatalogEntry({brand:'  proton ',model:'X70'},{personId:7});
  assert.equal(saved.brand,'PROTON');assert.equal(saved.model,'X70');assert.equal(saved.id,91);
  assert.equal(h.writes[0].params[0],'proton');assert.equal(h.writes[0].params.at(-1),7);
});

test('duplicate catalog additions preserve original model ID, spelling, tags and metadata',async()=>{
  const existing={id:12,brand_name:'TOYOTA',model_name:'Camry',tags_json:'["hot_used"]',enabled:1,supply_anchor:'existing'};
  const h=catalogHarness(existing);
  const saved=await h.context.addAiVehicleCatalogEntry({brand:'toyota',model:'CAMRY'});
  assert.equal(saved.id,12);assert.equal(saved.model,'Camry');assert.deepEqual(Array.from(saved.tags),['hot_used']);
  assert.match(h.writes[0].sql,/ON DUPLICATE KEY UPDATE[\s\S]*id = LAST_INSERT_ID\(id\)/);
  assert.doesNotMatch(h.writes[0].sql,/tags_json\s*=|enabled\s*=|model_name\s*=/);
  assert.equal(existing.supply_anchor,'existing');
});

test('invalid brands do not write; duplicate adds cannot reactivate disabled catalog entries',async()=>{
  const h=catalogHarness();
  for(const brand of ['中文品牌','', 'A'.repeat(129)]) await assert.rejects(h.context.addAiVehicleCatalogEntry({brand,model:'T1'}),/汽车品牌/);
  assert.equal(h.writes.length,0);
  const disabled=catalogHarness({id:9,brand_name:'TENET',model_name:'T4',tags_json:'[]',enabled:0});
  await assert.rejects(disabled.context.addAiVehicleCatalogEntry({brand:'tenet',model:'T4'}),/已停用/);
  assert.equal(disabled.row.enabled,0);
});

test('adding an existing category returns its real approval state without relabeling or reapproving',async()=>{
  const writes=[];let saved={id:8,option_type:'category',value:'门槛条',label:'门槛条',status:'active'};
  const context=vm.createContext({ normalizeVehicleBrand, vehicleBrandAliases, VEHICLE_BRAND_CHINESE,hasPermission:()=>false,mysqlQuery:async()=>[saved],mysqlExecute:async(sql,params)=>{writes.push({sql,params});return{insertId:8};}});
  const source=fs.readFileSync(new URL('../src/services/inventory-product-naming.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('export async function','async function').replaceAll('export function','function');
  vm.runInContext(`${source}\nschemaReady=true;`,context);
  const result=await context.createInventoryProductNamingOption({option_type:'category',value:'门槛条',label:'另一个名字'});
  assert.equal(result.status,'active');assert.equal(result.label,'门槛条');
  assert.match(writes[0].sql,/ON DUPLICATE KEY UPDATE[\s\S]*id = LAST_INSERT_ID\(id\)/);
  saved={...saved,status:'pending'};
  assert.equal((await context.createInventoryProductNamingOption({option_type:'category',value:'门槛条'})).status,'pending');
  saved={...saved,status:'archived'};
  await assert.rejects(context.createInventoryProductNamingOption({option_type:'category',value:'门槛条'}),/已归档/);
});
