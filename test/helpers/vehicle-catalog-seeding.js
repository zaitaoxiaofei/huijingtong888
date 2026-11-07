import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeVehicleBrand,VEHICLE_BRAND_CHINESE} from '../../src/shared/vehicle-brand.js';
import {legacyInitializeVehicleCatalogSchema,legacySeedRow,legacySeedAnchoredRow} from '../fixtures/vehicle-catalog-row-seeding.js';

export function vehicleCatalogSeedingContext(options={}) {
  let source=readFileSync(new URL('../../src/services/ai-vehicle-catalog.js',import.meta.url),'utf8');
  if(options.legacy)for(const [name,fn]of [['initializeVehicleCatalogSchema',legacyInitializeVehicleCatalogSchema],['seedRow',legacySeedRow],['seedAnchoredRow',legacySeedAnchoredRow]]){
    const pattern=new RegExp(`^async function ${name}\\([^]*?^}`,'m');
    if(!pattern.test(source))throw Error('Catalog seeding function missing: '+name);
    source=source.replace(pattern,fn.toString().replace(fn.name,name));
  }
  const context=vm.createContext({console,Date,Map,Set,Number,String,Object,Array,JSON,Promise,normalizeVehicleBrand,VEHICLE_BRAND_CHINESE,
    mysqlQuery:options.query||(async()=>[{present:1}]),mysqlExecute:options.execute||(async()=>({})),
    withMysqlTransaction:options.transaction||(async action=>action({})),migrateAiVehicleCatalogSchema:options.migrate||(async()=>({}))});
  vm.runInContext(source.replace(/^import[^;]*;\r?\n/gm,'').replaceAll('export ',''),context,{filename:'src/services/ai-vehicle-catalog.js'});
  return context;
}

export const seedWrite=sql=>/INSERT INTO ai_vehicle_catalog\s/i.test(sql);
export const native=value=>JSON.parse(JSON.stringify(value));
export function flattenSeedWrites(calls){
  return calls.flatMap(({sql,params})=>{
    const anchored=sql.includes('aliases_json'),width=anchored?11:5;
    if(params.length%width)throw Error('Unexpected seed parameter width');
    return Array.from({length:params.length/width},(_,index)=>({shape:anchored?'anchored':'basic',values:Array.from(params.slice(index*width,(index+1)*width))}));
  });
}
