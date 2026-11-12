import test from 'node:test';
import assert from 'node:assert/strict';
import {retargetVariantVehicleAttributes} from '../src/shared/variant-vehicle-attributes.js';
const attr=id=>({attribute_id:id,value:['Tenet'],values:[{dictionary_value_id:1,value:'Tenet'}],selected_values:[{dictionary_value_id:1,value:'Tenet'}],raw:{values:[{dictionary_value_id:1,value:'Tenet'}]}});
test('compatibility follows exact platform options across every inherited owner without mutating original facts',()=>{
 const input={price:{value:456},images:['original.png'],attributes:[attr(7204),attr(85)],variants:[{dynamic_attributes:{7204:attr(7204)},attributes:[attr(7212)]}],user_facts:{attributes:[attr(7204)]}};
 const before=structuredClone(input),vehicle={vehicle_brand:'VOLKSWAGEN',vehicle_model:'Golf'};
 const out=retargetVariantVehicleAttributes(input,vehicle,{7204:[{dictionary_value_id:42,value:'Volkswagen',label:'大众'}],7212:[{dictionary_value_id:43,value:'Golf'}]});
 assert.deepEqual(input,before);assert.equal(out.attributes[0].values[0].dictionary_value_id,42);assert.equal(out.variants[0].dynamic_attributes[7204].values[0].value,'Volkswagen');assert.equal(out.user_facts.attributes[0].values[0].value,'Volkswagen');
 assert.equal(out.variants[0].attributes[0].values[0].value,'Golf');assert.deepEqual(out.attributes[1],input.attributes[1]);assert.deepEqual(out.price,input.price);assert.deepEqual(out.images,input.images);
});
test('an unavailable target dictionary selection clears stale compatibility instead of inventing a platform id',()=>{
 const out=retargetVariantVehicleAttributes({attributes:[attr(7204),attr(7212)]},{vehicle_brand:'VOLKSWAGEN',vehicle_model:'Golf'},{7204:[{dictionary_value_id:1,value:'Tenet'}]});
 for(const a of out.attributes){assert.deepEqual(a.value,[]);assert.deepEqual(a.values,[]);assert.deepEqual(a.selected_values,[]);assert.deepEqual(a.raw.values,[]);}
});
