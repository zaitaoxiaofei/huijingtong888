import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

const MARKER='_erp_listing_sections_v1',REF='_erp_listing_section_ref_v1';
const LEAF='_erp_listing_leaf_gzip_v1';
const MAX_BYTES=64*1024*1024,MAX_ENTRIES=20000;
const SECTION_KEYS=new Set(['attributes','raw','values','category_attributes','categoryAttributes','source_raw']);
const hash=text=>createHash('sha256').update(text).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Only large attribute/provenance sections move into the inline dictionary.
// IDs, titles, images, prices, variant arrays and tenant/asset projections stay
// at their existing SQL paths. Each dictionary belongs to this one JSON field.
export function encodeListingJsonSections(text){
  if(typeof text!=='string'||Buffer.byteLength(text)<32768||Buffer.byteLength(text)>MAX_BYTES)return text;
  const payload=JSON.parse(text);
  // Standalone attributes must remain a JSON array for existing SQL readers.
  // Compact provenance/options within each attribute; names and selected values
  // remain plain JSON so the existing keyword filters keep their authority.
  if(Array.isArray(payload)){
    if(text.includes('"'+LEAF+'":')){decodeListingJsonSections(text);return text;}
    const visit=(value,key='',depth=0)=>{
      if(depth>64)throw new Error('Listing attribute depth exceeds limit');
      if(!value||typeof value!=='object')return value;
      if(Object.hasOwn(value,LEAF))throw new Error('Reserved listing leaf marker in business payload');
      if(['raw','values'].includes(key)){
        const original=JSON.stringify(value),bytes=Buffer.byteLength(original);
        if(bytes>=1024){const body=gzipSync(original,{level:6}).toString('base64');if(body.length+256<bytes)return {[LEAF]:{bytes,sha256:hash(original),body}};}
      }
      return Array.isArray(value)?value.map(child=>visit(child,'',depth+1)):Object.fromEntries(Object.entries(value).map(([name,child])=>[name,visit(child,name,depth+1)]));
    };
    const encoded=JSON.stringify(visit(payload));return Buffer.byteLength(encoded)<Buffer.byteLength(text)?encoded:text;
  }
  if(!object(payload)||Object.hasOwn(payload,MARKER))return text;
  const entries=Object.create(null);
  function visit(value,key='',depth=0){
    if(depth>64)throw new Error('Listing JSON section depth exceeds limit');
    if(!value||typeof value!=='object')return value;
    if(Object.hasOwn(value,REF)||Object.hasOwn(value,MARKER))throw new Error('Reserved listing storage marker in business payload');
    if(SECTION_KEYS.has(key)){
      const original=JSON.stringify(value),bytes=Buffer.byteLength(original);
      if(bytes>=4096){
        const sha256=hash(original),body=gzipSync(original,{level:6}).toString('base64');
        if(body.length+256<bytes){
          if(!Object.hasOwn(entries,sha256)){if(Object.keys(entries).length>=MAX_ENTRIES)throw new Error('Too many listing JSON sections');entries[sha256]={bytes,body};}
          return {[REF]:sha256};
        }
      }
    }
    if(Array.isArray(value))return value.map(child=>visit(child,'',depth+1));
    return Object.fromEntries(Object.entries(value).map(([name,child])=>[name,visit(child,name,depth+1)]));
  }
  const stored=visit(payload);
  if(!Object.keys(entries).length)return text;
  const encoded=JSON.stringify({[MARKER]:{bytes:Buffer.byteLength(JSON.stringify(payload)),sha256:hash(JSON.stringify(payload)),entries},...stored});
  return Buffer.byteLength(encoded)<Buffer.byteLength(text)?encoded:text;
}

export function decodeListingJsonSections(text){
  if(typeof text==='string'&&text.startsWith('[')&&text.includes('"'+LEAF+'":')){
    if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('Stored listing attributes exceed limit');
    let expanded=0;
    const visit=(value,depth=0)=>{
      if(depth>64)throw new Error('Listing attribute depth exceeds limit');
      if(!value||typeof value!=='object')return value;
      if(Object.hasOwn(value,LEAF)){
        const item=value[LEAF];
        if(Object.keys(value).length!==1||!object(item)||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(item.sha256||'')||typeof item.body!=='string'||item.body.length>MAX_BYTES*2||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.body))throw new Error('Invalid listing leaf envelope');
        expanded+=item.bytes;if(expanded>MAX_BYTES)throw new Error('Expanded listing attributes exceed limit');
        const original=gunzipSync(Buffer.from(item.body,'base64'),{maxOutputLength:item.bytes}).toString('utf8');
        if(Buffer.byteLength(original)!==item.bytes||hash(original)!==item.sha256)throw new Error('Listing leaf checksum mismatch');return JSON.parse(original);
      }
      return Array.isArray(value)?value.map(child=>visit(child,depth+1)):Object.fromEntries(Object.entries(value).map(([key,child])=>[key,visit(child,depth+1)]));
    };
    const decoded=JSON.stringify(visit(JSON.parse(text)));if(Buffer.byteLength(decoded)>MAX_BYTES)throw new Error('Expanded listing attributes exceed limit');return decoded;
  }
  if(typeof text!=='string'||!text.startsWith('{')||!text.includes('"'+MARKER+'":'))return text;
  if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('Stored listing JSON exceeds limit');
  const stored=JSON.parse(text),meta=stored[MARKER];
  if(!Object.hasOwn(stored,MARKER))return text;
  if(!object(meta)||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||meta.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(meta.sha256||'')
    ||!object(meta.entries)||Object.keys(meta.entries).length>MAX_ENTRIES)throw new Error('Invalid listing JSON section envelope');
  const used=new Set();let expandedBytes=0;
  function visit(value,depth=0){
    if(depth>64)throw new Error('Listing JSON section depth exceeds limit');
    if(!value||typeof value!=='object')return value;
    if(Object.hasOwn(value,REF)){
      const key=value[REF],entry=meta.entries[key];
      if(Object.keys(value).length!==1||!/^[a-f0-9]{64}$/.test(key||'')||!Object.hasOwn(meta.entries,key)||!object(entry)
        ||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>MAX_BYTES||typeof entry.body!=='string'
        ||entry.body.length>MAX_BYTES*2||!/^[A-Za-z0-9+/]+={0,2}$/.test(entry.body))throw new Error('Invalid listing JSON section reference');
      expandedBytes+=entry.bytes;if(expandedBytes>MAX_BYTES)throw new Error('Expanded listing JSON exceeds limit');
      const original=gunzipSync(Buffer.from(entry.body,'base64'),{maxOutputLength:entry.bytes}).toString('utf8');
      if(Buffer.byteLength(original)!==entry.bytes||hash(original)!==key)throw new Error('Listing JSON section checksum mismatch');
      used.add(key);return JSON.parse(original);
    }
    if(Array.isArray(value))return value.map(child=>visit(child,depth+1));
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,visit(child,depth+1)]));
  }
  const payload=visit(Object.fromEntries(Object.entries(stored).filter(([key])=>key!==MARKER))),decoded=JSON.stringify(payload);
  if(Buffer.byteLength(decoded)!==meta.bytes||hash(decoded)!==meta.sha256||used.size!==Object.keys(meta.entries).length)throw new Error('Listing JSON payload checksum mismatch');
  return decoded;
}

// Reader rollout comes first. Enable new writes only after both production
// application processes run this reader-compatible release.
export function encodeListingJsonForWrite(text,env=process.env){
  return env.LISTING_SECTION_STORAGE_ENABLED==='1'?encodeListingJsonSections(text):text;
}

const FIELD=/(?:^|_)(?:editable_payload_json|manual_facts_json|ai_payload_json|attributes_json)$/;
const RAW=Symbol('listingStoredJson');
export const listingStoredJsonText=(row,field)=>row?.[RAW]?.[field]??row?.[field];
export function decodeListingMysqlResult(result){
  const [rows,fields]=result;
  if(!Array.isArray(rows))return result;
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))continue;
    for(const name of Object.keys(row)){
      const source=fields?.find?.(field=>field.name===name)?.orgName;
      if(FIELD.test(source||name)){
        const decoded=decodeListingJsonSections(row[name]);
        if(decoded!==row[name]){
          if(!row[RAW])Object.defineProperty(row,RAW,{value:Object.create(null)});
          if(!Object.hasOwn(row[RAW],name))row[RAW][name]=row[name];
          row[name]=decoded;
        }
      }
    }
  }
  return result;
}

export function listingStorageReadConnection(connection){
  return new Proxy(connection,{get(target,key){
    if(key==='query'||key==='execute')return async(...args)=>decodeListingMysqlResult(await target[key](...args));
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}
