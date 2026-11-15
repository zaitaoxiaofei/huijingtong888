import test from "node:test";
import assert from "node:assert/strict";
import {encodeFrozenContentStorage,decodeFrozenContentStorage} from "../src/services/listing-frozen-codec.js";

test("large repeated JSON compresses losslessly while media and selected values survive",()=>{
  const payload={category_hash:"a".repeat(64),payload:{attributes:Array.from({length:100},(_,i)=>({id:i,values:["完整保留".repeat(100)]})),images:["https://media.invalid/private.jpg"],manual:[],price:0}};
  const saved=encodeFrozenContentStorage(payload);assert.ok(saved._listing_frozen_gzip_v1);
  assert.ok(JSON.stringify(saved).length<JSON.stringify(payload).length/5);assert.deepEqual(decodeFrozenContentStorage(saved),payload);
});
test("small and legacy immutable versions retain their original representation",()=>{
  const value={payload:{title:"small"}};assert.deepEqual(encodeFrozenContentStorage(value),value);assert.equal(decodeFrozenContentStorage(value),value);
});
test("corruption, extra fields and decompression bounds refuse frozen content",()=>{
  const saved=encodeFrozenContentStorage({x:"重复".repeat(10000)});
  assert.throws(()=>decodeFrozenContentStorage({...saved,extra:true}),/Invalid/);
  const corrupted=structuredClone(saved);corrupted._listing_frozen_gzip_v1.sha256="0".repeat(64);assert.throws(()=>decodeFrozenContentStorage(corrupted),/checksum/);
  const oversized=structuredClone(saved);oversized._listing_frozen_gzip_v1.bytes=9000000;assert.throws(()=>decodeFrozenContentStorage(oversized),/Invalid/);
});
