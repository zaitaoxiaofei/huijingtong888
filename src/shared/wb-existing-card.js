import {createHash} from 'node:crypto';
const clone=v=>JSON.parse(JSON.stringify(v));
const project=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,clone(value[k])]));
export function wbExistingCard(card){
 const result=project(card,['nmID','vendorCode','kizMarked','brand','title','gtin','description']);
 result.dimensions=project(card.dimensions,['length','width','height','weightBrutto']);
 result.characteristics=(card.characteristics||[]).map(c=>project(c,['id','value']));
 result.sizes=(card.sizes||[]).map(s=>project(s,['chrtID','techSize','wbSize','skus']));
 if(card.documents)result.documents={...project(card.documents,['excludeDocuments']),items:(card.documents.items||[]).map(d=>project(d,['id','type','number','productNumber','tradeName','applicant','startDate','endDate','isEndless']))};
 return result;
}
const normalize=card=>{const c=wbExistingCard(card);for(const key of ['brand','title','description'])c[key]=String(c[key]||'');c.characteristics.sort((a,b)=>Number(a.id)-Number(b.id));for(const x of c.characteristics)if(Array.isArray(x.value))x.value.sort();c.sizes.sort((a,b)=>Number(a.chrtID)-Number(b.chrtID));for(const s of c.sizes){s.skus?.sort();if(!s.techSize||s.techSize==='0')delete s.techSize;if(!s.wbSize)delete s.wbSize;}return c;};
export const wbExistingFingerprint=card=>createHash('sha256').update(JSON.stringify(normalize(card))).digest('hex');
export function wbUpdatedCard(current,desired,attributes){
 const result=wbExistingCard(current);
 for(const key of ['title','brand','description'])result[key]=String(desired[key]||'');
 result.dimensions=project(desired.dimensions,['length','width','height','weightBrutto']);
 const editable=new Set(attributes.filter(a=>!a.existNamedField&&Number(a.charcType)!==0).map(a=>Number(a.charcID)));
 result.characteristics=[...result.characteristics.filter(c=>!editable.has(Number(c.id))),...(desired.characteristics||[]).filter(c=>editable.has(Number(c.id))).map(c=>project(c,['id','value']))];
 result.vendorCode=String(desired.vendorCode||'');
 const requested=desired.sizes||[];
 const used=new Set();
 result.sizes=current.sizes.map(old=>{
  const found=requested.filter(s=>Number(s.chrtID)===Number(old.chrtID)||(s.skus||[]).some(b=>(old.skus||[]).includes(b)));
  if(found.length!==1||(old.skus||[]).some(b=>!found[0].skus?.includes(b)))throw Error('WB 不支持删除或替换已有条码；请保留原条码，或选择按新品上架。');
  used.add(found[0]);return {...project(found[0],['techSize','wbSize','skus']),chrtID:old.chrtID};
 });
 for(const size of requested.filter(s=>!used.has(s))){if(size.chrtID)throw Error('新增规格不能使用不属于原商品的规格编号。');if(!Number.isSafeInteger(Number(size.price))||Number(size.price)<=0)throw Error('新增规格请填写大于零的整数售价。');result.sizes.push({...project(size,['techSize','wbSize','skus']),price:Number(size.price)});}
 return result;
}

export function wbExistingMatches(actual,desired){const expected=clone(desired);for(const size of expected.sizes){if(!size.chrtID){const found=(actual.sizes||[]).filter(s=>size.skus?.some(b=>s.skus?.includes(b)));if(found.length!==1)return false;size.chrtID=found[0].chrtID;}}return wbExistingFingerprint(actual)===wbExistingFingerprint(expected);}
