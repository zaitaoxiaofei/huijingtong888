import {wbLocalizedOptions} from '../shared/wb-display.js';
import {wbAttributeDirectory,wbDirectoryOptions,wbTemplateOptions} from '../shared/wb-attribute-options.js';
import {createHash} from 'node:crypto';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const parse=value=>typeof value==='string'?JSON.parse(value):value;
export const WB_CATALOG_CACHE_SCHEMA=`CREATE TABLE IF NOT EXISTS wb_catalog_cache (
  tenant_id BIGINT UNSIGNED NOT NULL, environment VARCHAR(16) NOT NULL,
  resource_key VARCHAR(96) NOT NULL, locale VARCHAR(8) NOT NULL,
  payload_json JSON NOT NULL, checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,environment,resource_key,locale)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
export function createWbCategoryCatalog({query,request,account}){
 const pending=new Map();
 async function catalogAccount(tenantId,body={}){
  if(body.shop_id)return account(tenantId,body.shop_id);
  const rows=await query(`SELECT c.shop_id FROM wb_shop_credentials c JOIN shops s ON s.id=c.shop_id AND s.tenant_id=c.tenant_id
    WHERE c.tenant_id=? AND s.platform='wb' AND s.status='active' AND LENGTH(c.token)>0
    AND (c.environment='sandbox' OR (c.checked_at IS NOT NULL AND c.seller_id IS NOT NULL))
    ORDER BY (c.environment='production') DESC,c.shop_id LIMIT 1`,[Number(tenantId)]);
  if(!rows[0])throw fail('请先在企业店铺配置并检查一家具备 Content 权限的 WB 店铺，系统才能读取类目；目标上架店铺可以稍后选择。');
  return account(tenantId,rows[0].shop_id);
 }
 async function cached(a,key,locale,refresh,load){
  const [row]=await query('SELECT payload_json,TIMESTAMPDIFF(SECOND,checked_at,UTC_TIMESTAMP()) AS age FROM wb_catalog_cache WHERE tenant_id=? AND environment=? AND resource_key=? AND locale=?',[a.tenant_id,a.environment,key,locale]);
  if(row&&Number(row.age)>=0&&Number(row.age)<21600&&!refresh)return {...parse(row.payload_json),cache:{source:'local',stale:false,age_seconds:Number(row.age)}};
  const identity=`${a.tenant_id}:${a.environment}:${locale}:${key}`;
  if(pending.has(identity))return pending.get(identity);
  const run=(async()=>{try{
    const result=await load();
    if(!Array.isArray(result.data))throw fail('WB 类目接口没有返回完整字段，请稍后刷新。',502);
    await query('INSERT INTO wb_catalog_cache (tenant_id,environment,resource_key,locale,payload_json,checked_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE payload_json=VALUES(payload_json),checked_at=VALUES(checked_at)',[a.tenant_id,a.environment,key,locale,JSON.stringify(result)]);
    return {...result,cache:{source:'wb',stale:false,age_seconds:0}};
  }catch(error){if(!row)throw error;return {...parse(row.payload_json),cache:{source:'local',stale:true,age_seconds:Number(row.age),message:'WB 暂时无法更新，当前显示上次缓存；正式校验时仍需核对最新字段。'}};}})();
  pending.set(identity,run);try{return await run;}finally{pending.delete(identity);}
 }
 async function categoryParents(tenantId,body={}){const a=await catalogAccount(tenantId,body);return cached(a,'parents','zh',body.refresh===true||body.refresh==='1',()=>request(a,'content','/content/v2/object/parent/all',{query:{locale:'zh'}}));}
 async function catalogCategories(tenantId,body={}){
  const a=await catalogAccount(tenantId,body),offset=Number(body.offset||0),search=String(body.search||'').trim(),parent=body.parent_id?Number(body.parent_id):null;
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000||search.length>100||(parent!==null&&(!Number.isSafeInteger(parent)||parent<=0)))throw fail('类目筛选条件无效，请重新搜索。',400);
  const options={locale:'zh',name:search,limit:100,offset,...(parent?{parentID:parent}:{})};
  const key='categories:'+createHash('sha256').update(JSON.stringify(options)).digest('hex');
  const result=await cached(a,key,'zh',body.refresh===true||body.refresh==='1',()=>request(a,'content','/content/v2/object/all',{query:options}));
  return {...result,offset,next_offset:result.data.length===100?offset+100:null};
 }
 async function categorySchema(tenantId,body={}){
  const a=await catalogAccount(tenantId,body),subject=Number(body.subject_id);
  if(!Number.isSafeInteger(subject)||subject<=0)throw fail('请先选择 WB 商品类目。',400);
  const result=await cached(a,`schema:${subject}`,'zh',body.refresh===true||body.refresh==='1',()=>request(a,'content',`/content/v2/object/charcs/${subject}`,{query:{locale:'zh'}}));
  const candidates=await query('SELECT * FROM wb_listing_templates WHERE tenant_id=? AND subject_id=? ORDER BY id',[a.tenant_id,subject]);
  const existing=candidates.find(row=>(parse(row.defaults_json).environment||'production')===a.environment);
  const categoryName=String(result.data[0]?.subjectName||String(body.category_name||'').slice(0,200)||`WB 类目 ${subject}`);
  let template=existing;
  if(!template){
   try{const r=await query('INSERT INTO wb_listing_templates (tenant_id,name,subject_id,category_name,attributes_json,defaults_json) VALUES (?,?,?,?,?,?)',[a.tenant_id,`WB · ${categoryName.slice(0,70)} (${subject})${a.environment==='sandbox'?' · Sandbox':''}`,subject,categoryName,JSON.stringify(result.data),JSON.stringify({currency:'CNY',characteristics:[],environment:a.environment})]);template={id:r.insertId,revision:1,defaults_json:{currency:'CNY',characteristics:[],environment:a.environment}};}
   catch(e){if(e.code!=='ER_DUP_ENTRY')throw e;const candidates=await query('SELECT * FROM wb_listing_templates WHERE tenant_id=? AND subject_id=? ORDER BY id',[a.tenant_id,subject]);template=candidates.find(row=>(parse(row.defaults_json).environment||'production')===a.environment);if(!template)throw e;}
  }else if(!result.cache.stale&&JSON.stringify(parse(template.attributes_json))!==JSON.stringify(result.data)){
   await query('UPDATE wb_listing_templates SET attributes_json=?,category_name=?,revision=revision+1 WHERE id=? AND tenant_id=?',[JSON.stringify(result.data),categoryName,template.id,a.tenant_id]);template.revision=Number(template.revision)+1;
  }
  console.info('[wb-catalog]',JSON.stringify({tenant_id:a.tenant_id,environment:a.environment,subject_id:subject,field_count:result.data.length,source:result.cache.source,stale:result.cache.stale}));
  return {environment:a.environment,subject_id:subject,category_name:categoryName,template_id:template.id,revision:template.revision,attributes:result.data,defaults:parse(template.defaults_json),cache:result.cache};
 }
 async function categoryOptions(tenantId,body={}){
  const a=await catalogAccount(tenantId,body),subject=Number(body.subject_id),attributeId=Number(body.attribute_id);
  if(!Number.isSafeInteger(subject)||subject<=0||!Number.isSafeInteger(attributeId)||attributeId<=0)throw fail('请先选择有效类目和属性。',400);
  const schema=await cached(a,`schema:${subject}`,'zh',false,()=>request(a,'content',`/content/v2/object/charcs/${subject}`,{query:{locale:'zh'}}));
  const attribute=schema.data.find(item=>Number(item.charcID)===attributeId),kind=wbAttributeDirectory(attribute);
  if(!attribute)throw fail('该属性不属于当前类目，请重新选择类目。',400);
  if(!kind){
   const options=wbTemplateOptions(attribute),seen=new Set(options.map(item=>item.value));
   const cards=await query("SELECT raw_json FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.subjectID')) AS UNSIGNED)=? ORDER BY synced_at DESC LIMIT 200",[a.tenant_id,a.shop_id,subject]);
   for(const row of cards){const card=parse(row.raw_json);for(const value of card.characteristics||[]){if(Number(value.id)!==attributeId||!Array.isArray(value.value))continue;for(const text of value.value){if(typeof text!=='string'||!text.trim()||text.length>500||seen.has(text))continue;seen.add(text);options.push({value:text,label:text});}}}
   return {data:options.map(item=>item.value),options,source:wbTemplateOptions(attribute).length?'template':'shop_history',allow_custom:true};
  }
  const result=await cached(a,`options:${kind}:${kind==='tnved'?subject:0}`,'ru',body.refresh===true||body.refresh==='1',()=>request(a,'content',`/content/v2/directory/${kind}`,{query:{locale:'ru',...(kind==='tnved'?{subjectID:subject}:{})}}));
  const localized=await cached(a,`options:${kind}:${kind==='tnved'?subject:0}`,'zh',body.refresh===true||body.refresh==='1',()=>request(a,'content',`/content/v2/directory/${kind}`,{query:{locale:'zh',...(kind==='tnved'?{subjectID:subject}:{})}}));
  return {...result,source:'official',allow_custom:false,data:wbDirectoryOptions(result.data,kind),options:wbLocalizedOptions(result.data,localized.data,kind),cache:{...result.cache,stale:result.cache.stale||localized.cache.stale}};
 }
 async function categoryBrands(tenantId,body={}){
  const a=await catalogAccount(tenantId,body),subject=Number(body.subject_id);if(!Number.isSafeInteger(subject)||subject<=0)throw fail('请先选择有效类目。',400);
  const result=await cached(a,`brands:${a.shop_id}:${subject}`,'ru',false,async()=>{const r=await request(a,'content','/api/content/v1/brands',{query:{subjectId:subject}});if(!Array.isArray(r.brands))throw fail('品牌目录暂时不可用，请稍后重试。',502);return {data:r.brands.map(b=>String(b.name||'')).filter(Boolean)};});return result;
 }
 return {catalogAccount,categoryParents,catalogCategories,categorySchema,categoryOptions,categoryBrands};
}
