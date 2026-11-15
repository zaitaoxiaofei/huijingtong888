import {gzipSync,gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";

const MARKER="_listing_frozen_gzip_v1",MAX_BYTES=8*1024*1024;
const digest=text=>createHash("sha256").update(text).digest("hex");
export function encodeFrozenContentStorage(payload){
  const text=JSON.stringify(payload),bytes=Buffer.byteLength(text);
  if(bytes>MAX_BYTES)throw new Error("Frozen listing content exceeds 8 MiB");
  const compressed=gzipSync(text,{level:9});
  const envelope={[MARKER]:{codec:"gzip",bytes,sha256:digest(text),body:compressed.toString("base64")}};
  return Buffer.byteLength(JSON.stringify(envelope))<bytes?envelope:payload;
}
export function decodeFrozenContentStorage(payload){
  if(!payload||typeof payload!=="object"||!Object.hasOwn(payload,MARKER))return payload;
  const saved=payload[MARKER];
  if(Object.keys(payload).length!==1||!saved||saved.codec!=="gzip"||!Number.isSafeInteger(saved.bytes)||saved.bytes<1||saved.bytes>MAX_BYTES
    ||!/^[a-f0-9]{64}$/.test(saved.sha256||"")||typeof saved.body!=="string"||saved.body.length>MAX_BYTES*2||!/^[A-Za-z0-9+/]+={0,2}$/.test(saved.body))throw new Error("Invalid compressed frozen listing content");
  const text=gunzipSync(Buffer.from(saved.body,"base64"),{maxOutputLength:MAX_BYTES}).toString("utf8");
  if(Buffer.byteLength(text)!==saved.bytes||digest(text)!==saved.sha256)throw new Error("Compressed frozen listing content checksum mismatch");
  return JSON.parse(text);
}
