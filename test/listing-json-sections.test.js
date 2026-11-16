import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeListingJsonSections,decodeListingJsonSections,encodeListingJsonForWrite,decodeListingMysqlResult,listingStorageReadConnection,listingStoredJsonText} from '../src/services/listing-json-sections.js';

const attributes=()=>Array.from({length:160},(_,i)=>({attribute_id:i+1,value:'已选值',selected_values:[{dictionary_value_id:i+1,value:'已选值'}],raw:{definition:{name:'原始属性',options:'历史候选资料'.repeat(200)}}}));
const payload=()=>({title:'保留标题',asset_variant_id:17,user_facts:{source_product_id:23},attributes:attributes(),variants:[{id:'a',price:7000,images:[],images_manually_edited:true,attributes:attributes()}]});

test('large repeated attribute sections store once and reconstruct all original values',()=>{
 const original=JSON.stringify(payload()),stored=encodeListingJsonSections(original),raw=JSON.parse(stored);
 assert(Buffer.byteLength(stored)<Buffer.byteLength(original)/8);
 assert.equal(Object.keys(raw._erp_listing_sections_v1.entries).length,1);
 assert.equal(raw.variants.length,1);assert.deepEqual(raw.variants[0].images,[]);assert.equal(raw.variants[0].images_manually_edited,true);
 assert.equal(raw.asset_variant_id,17);assert.equal(raw.user_facts.source_product_id,23);
 assert.equal(decodeListingJsonSections(stored),original);assert.equal(encodeListingJsonSections(stored),stored);
 const numbered=JSON.stringify({'0':'legacy numeric field',...payload()});assert.equal(decodeListingJsonSections(encodeListingJsonSections(numbered)),numbered);
});
test('small/legacy JSON and inactive rollout flag preserve original bytes',()=>{
 for(const value of [' {"images":[]} ','[1,2,3]','null'])assert.equal(encodeListingJsonSections(value),value);
 const original=JSON.stringify(payload());assert.equal(encodeListingJsonForWrite(original,{}),original);
 assert.notEqual(encodeListingJsonForWrite(original,{LISTING_SECTION_STORAGE_ENABLED:'1'}),original);
});
test('standalone attribute arrays keep SQL-searchable selected values while packing bulky raw provenance',()=>{
 const original=JSON.stringify(attributes()),stored=encodeListingJsonSections(original),raw=JSON.parse(stored);
 assert(Array.isArray(raw));assert.equal(raw.length,160);assert.equal(raw[0].value,'已选值');assert.equal(raw[0].selected_values[0].dictionary_value_id,1);
 assert(Buffer.byteLength(stored)<Buffer.byteLength(original)/5);assert.equal(decodeListingJsonSections(stored),original);assert.equal(encodeListingJsonSections(stored),stored);
 raw[0].raw._erp_listing_leaf_gzip_v1.sha256='0'.repeat(64);assert.throws(()=>decodeListingJsonSections(JSON.stringify(raw)),/checksum/);
});
test('corruption and missing references fail instead of returning empty business data',()=>{
 const stored=JSON.parse(encodeListingJsonSections(JSON.stringify(payload())));
 const key=Object.keys(stored._erp_listing_sections_v1.entries)[0];
 stored._erp_listing_sections_v1.entries[key].body=Buffer.from('bad').toString('base64');
 assert.throws(()=>decodeListingJsonSections(JSON.stringify(stored)));
 const missing=JSON.parse(encodeListingJsonSections(JSON.stringify(payload())));delete missing._erp_listing_sections_v1.entries[key];
 assert.throws(()=>decodeListingJsonSections(JSON.stringify(missing)),/reference/);
 const projection=JSON.parse(encodeListingJsonSections(JSON.stringify(payload())));projection.variants[0].price=1;
 assert.throws(()=>decodeListingJsonSections(JSON.stringify(projection)),/checksum/);
});
test('expanded byte bound and reserved marker collisions are rejected',()=>{
 const stored=JSON.parse(encodeListingJsonSections(JSON.stringify(payload())));stored._erp_listing_sections_v1.bytes=64*1024*1024+1;
 assert.throws(()=>decodeListingJsonSections(JSON.stringify(stored)),/envelope/);
 const collision={attributes:attributes(),user_facts:{_erp_listing_section_ref_v1:'manual'}};
 assert.throws(()=>encodeListingJsonSections(JSON.stringify(collision)),/Reserved/);
});
test('mysql readers decode aliases and transactions without changing other fields or connection binding',async()=>{
 const original=JSON.stringify(payload()),stored=encodeListingJsonSections(original);
 const result=[[{facts:stored,unrelated:stored}], [{name:'facts',orgName:'manual_facts_json'},{name:'unrelated',orgName:'other'}]];
 assert.equal(decodeListingMysqlResult(result)[0][0].facts,original);assert.equal(result[0][0].unrelated,stored);
 assert.equal(listingStoredJsonText(result[0][0],'facts'),stored);assert.deepEqual(Object.keys(result[0][0]),['facts','unrelated']);assert.equal(JSON.parse(JSON.stringify(result[0][0])).facts,original);
 const connection={state:3,async execute(){assert.equal(this,connection);return [[{manual_facts_json:stored}],[]];},ping(){return this.state;}};
 const proxy=listingStorageReadConnection(connection);
 assert.equal((await proxy.execute('SELECT'))[0][0].manual_facts_json,original);assert.equal(proxy.ping(),3);
});
