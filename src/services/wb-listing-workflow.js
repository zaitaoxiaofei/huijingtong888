import {wbListingVariants} from '../shared/wb-listing-variants.js';
import {wbAttributeDirectory} from '../shared/wb-attribute-options.js';
import { wbListingValidation } from '../shared/wb-listing-validation.js';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const id=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw fail('请选择有效的 WB 模板或草稿。',400);return n;};
export function createWbListingWorkflow({query,request,account,transaction,categoryOptions}) {
  async function template(tenantId,templateId){const [row]=await query('SELECT * FROM wb_listing_templates WHERE id=? AND tenant_id=?',[id(templateId),id(tenantId)]);if(!row)throw fail('WB 类目模板不存在或不属于当前企业。',404);return {...row,attributes:parse(row.attributes_json),defaults:parse(row.defaults_json),attributes_json:undefined,defaults_json:undefined};}
  async function listingTemplates(tenantId,body){await account(tenantId,body.shop_id);const rows=await query('SELECT id FROM wb_listing_templates WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 200',[id(tenantId)]);return {rows:await Promise.all(rows.map(r=>template(tenantId,r.id)))};}
  async function saveListingTemplate(tenantId,body){
    const a=await account(tenantId,body.shop_id),subject=id(body.subject_id),name=String(body.name||'').trim();
    if(!name||name.length>120)throw fail('模板名称：请填写 1–120 个字符。',400);
    const result=await request(a,'content',`/content/v2/object/charcs/${subject}`,{query:{locale:'zh'}});
    if(!Array.isArray(result.data)||!result.data.length)throw fail('WB 没有返回该类目的属性，模板尚未导入，请重新选择类目。',502);
    const defaults={...(body.defaults||{currency:'CNY',characteristics:[]}),environment:a.environment};
    if(defaults.currency!=='CNY'||JSON.stringify(defaults).length>100000)throw fail('中国主体 WB 模板使用人民币 CNY；请核对模板默认值。',400);
    const attributes=result.data,categoryName=String(attributes[0].subjectName||body.category_name||subject);
    try{
      if(body.template_id){const previous=await template(a.tenant_id,body.template_id);if((previous.defaults.environment||'production')!==a.environment)throw fail('正式和沙箱模板不能混用，请重新选择类目。');if(Number(previous.subject_id)!==subject)throw fail('已有模板不能替换类目，请为新类目新建模板。');const changed=await query('UPDATE wb_listing_templates SET name=?,category_name=?,attributes_json=?,defaults_json=?,revision=revision+1 WHERE id=? AND tenant_id=? AND revision=?',[name,categoryName,JSON.stringify(attributes),JSON.stringify(defaults),previous.id,a.tenant_id,Number(body.revision)]);if(!changed.affectedRows)throw fail('模板已在其他窗口更新，请刷新后重试。');return {ok:true,template:await template(a.tenant_id,previous.id)};}
      const saved=await query('INSERT INTO wb_listing_templates (tenant_id,name,subject_id,category_name,attributes_json,defaults_json) VALUES (?,?,?,?,?,?)',[a.tenant_id,name,subject,categoryName,JSON.stringify(attributes),JSON.stringify(defaults)]);return {ok:true,template:await template(a.tenant_id,saved.insertId)};
    }catch(error){if(error.code==='ER_DUP_ENTRY')throw fail('本企业已有同名 WB 模板，请编辑已有模板。');throw error;}
  }
  async function owned(tenantId,body){const a=await account(tenantId,body.shop_id);const [row]=await query('SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=?',[id(body.draft_id),a.tenant_id,a.shop_id]);if(!row)throw fail('WB 草稿不存在或不属于当前店铺。',404);return {a,row,payload:parse(row.payload_json)};}
  async function listingDrafts(tenantId,body){const a=await account(tenantId,body.shop_id);const rows=await query('SELECT * FROM wb_listing_drafts WHERE tenant_id=? AND shop_id=? ORDER BY updated_at DESC LIMIT 200',[a.tenant_id,a.shop_id]);return {rows:rows.map(row=>({...row,payload:parse(row.payload_json),payload_json:undefined}))};}
  async function saveListingDraft(tenantId,body){
    const a=await account(tenantId,body.shop_id),payload=body.payload;
    const selected=await template(a.tenant_id,payload?.template_id);
    if((selected.defaults.environment||'production')!==a.environment)throw fail('所选店铺环境与模板不一致，请重新选择 WB 类目。');
    if(Number(payload.subject_id)!==Number(selected.subject_id))throw fail('草稿类目与所选 WB 模板不一致，请重新套用模板。',400);
    const variants=wbListingVariants(payload),vendors=variants.map(row=>String(row.card?.vendorCode||'').trim());
    if(!variants.length||variants.length>30||vendors.some(v=>!v||v.length>72)||new Set(vendors).size!==vendors.length)throw fail('变体货号：每行须填写唯一的 1–72 字符货号，请点击生成货号或修改重复项。',400);
    if(payload.variants&&JSON.stringify(payload.card)!==JSON.stringify(variants[0].card))throw fail('首行变体与商品资料不一致，请刷新草稿后重试。',400);
    const vendor=vendors[0];
    if(!vendor||vendor.length>72||JSON.stringify(payload).length>1000000)throw fail('草稿商家货号：请填写 1–72 个字符，图片请使用地址。',400);
    if(payload.currency!=='CNY')throw fail('WB 草稿售价币种须为人民币 CNY，不能沿用 Ozon 币种。',400);
    const saved={...payload,template_revision:selected.revision,template_name:selected.name,attributes_schema:selected.attributes};
    return transaction(async connection=>{
    const q=async(sql,params)=>{const [rows]=await connection.execute(sql,params);return rows;};
    await q('SELECT id FROM shops WHERE id=? AND tenant_id=? FOR UPDATE',[a.shop_id,a.tenant_id]);
    const previous=body.draft_id?(await q('SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=? FOR UPDATE',[id(body.draft_id),a.tenant_id,a.shop_id]))[0]:null;
    if(body.draft_id&&!previous)throw fail('WB 草稿不存在或不属于当前店铺。',404);
    if(previous&&!['draft','published','publishing'].includes(previous.status))throw fail('草稿正在发布处理，不能覆盖；请到上架记录继续核对。');
    const submitted=['published','publishing'].includes(previous?.status);
    if(submitted){const original=parse(previous.payload_json);if(Number(original.subject_id)!==Number(payload.subject_id)||JSON.stringify(wbListingVariants(original).map(v=>v.card.vendorCode))!==JSON.stringify(vendors))throw fail('已提交草稿不能更换类目或变体货号；本次编辑仅保存本地资料。');}
    const existing=await q('SELECT id,payload_json FROM wb_listing_drafts WHERE tenant_id=? AND shop_id=? AND id<>?',[a.tenant_id,a.shop_id,Number(body.draft_id||0)]);
    const used=new Set(existing.flatMap(row=>wbListingVariants(parse(row.payload_json)).map(v=>String(v.card?.vendorCode||'').trim())));
    const online=await q('SELECT vendor_code,nm_id FROM wb_product_cards WHERE tenant_id=? AND shop_id=?',[a.tenant_id,a.shop_id]);
    for(const row of variants){const code=String(row.card.vendorCode).trim();if(used.has(code)||!submitted&&online.some(item=>item.vendor_code===code&&Number(item.nm_id)!==Number(row.card.nmID)))throw fail('变体货号已在当前 WB 店铺使用：'+code+'，请重新生成或编辑已有草稿。');}
    if(previous){if(previous.vendor_code!==vendor)throw fail('草稿货号已变化，不能覆盖。');const r=await q('UPDATE wb_listing_drafts SET template_id=?,payload_json=?,revision=revision+1 WHERE id=? AND tenant_id=? AND shop_id=? AND revision=? AND status=?',[selected.id,JSON.stringify(saved),previous.id,a.tenant_id,a.shop_id,Number(body.revision),previous.status]);if(!r.affectedRows)throw fail('草稿已在其他窗口修改，请刷新后重试。');return {ok:true,draft_id:previous.id,revision:Number(previous.revision)+1};}
    try{const r=await q("INSERT INTO wb_listing_drafts (tenant_id,shop_id,template_id,vendor_code,payload_json,status) VALUES (?,?,?,?,?,'draft')",[a.tenant_id,a.shop_id,selected.id,vendor,JSON.stringify(saved)]);return {ok:true,draft_id:r.insertId,revision:1};}catch(error){if(error.code==='ER_DUP_ENTRY')throw fail('该 WB 店铺已存在此货号草稿，请在草稿列表继续编辑。');throw error;}
    });
  }
  async function validateListingDraft(tenantId,body){const {a,payload}=await owned(tenantId,body),selected=await template(a.tenant_id,payload.template_id);const current=await request(a,'content',`/content/v2/object/charcs/${selected.subject_id}`,{query:{locale:'zh'}});const result=await validatePayload(a.tenant_id,{shop_id:a.shop_id,payload},current.data||[]);if(payload.currency!=='CNY')result.errors.push('售价币种：请选择人民币 CNY。');return {...result,ok:!result.errors.length,review_only:true,message:'本次只校验资料，不会向 WB 创建商品、生成条码、发布价格或库存。'};}
  async function workbenchDrafts(tenantId){const rows=await query(`SELECT d.*,s.name AS shop_name,t.category_name FROM wb_listing_drafts d JOIN wb_listing_templates t ON t.id=d.template_id AND t.tenant_id=d.tenant_id JOIN shops s ON s.id=d.shop_id AND s.tenant_id=d.tenant_id WHERE d.tenant_id=? AND s.platform='wb' AND s.status='active' ORDER BY d.updated_at DESC LIMIT 200`,[id(tenantId)]);return {rows:rows.map(row=>({...row,payload:parse(row.payload_json),payload_json:undefined}))};}
  async function validatePayload(tenantId,body,attributes){
    const result=wbListingValidation(body.payload,attributes);
    for(const attribute of attributes.filter(a=>wbAttributeDirectory(a))){
      const rows=wbListingVariants(body.payload),selected=rows.flatMap(row=>(row.card?.characteristics||[]).filter(c=>Number(c.id)===Number(attribute.charcID)).flatMap(c=>Array.isArray(c.value)?c.value:[c.value]));
      if(!selected.length)continue;
      try{const options=await categoryOptions(tenantId,{shop_id:body.shop_id,subject_id:body.payload.subject_id,attribute_id:attribute.charcID});if(options.cache?.stale)throw Error();const allowed=new Set(options.data);if(selected.some(value=>!allowed.has(String(value))))result.errors.push(attribute.name+'：请从 WB 官方选项中重新选择。');}catch{result.errors.push(attribute.name+'：暂时无法核对官方选项，请稍后重试。');}
    }
    return {...result,ok:!result.errors.length};
  }
  async function previewListingPayload(tenantId,body){
    const selected=await template(tenantId,body.payload?.template_id);
    if(Number(body.payload?.subject_id)!==Number(selected.subject_id))throw fail('请重新选择 WB 类目，模板与当前类目不一致。',400);
    const a=body.shop_id?await account(tenantId,body.shop_id):null;
    const latest=a?await request(a,'content',`/content/v2/object/charcs/${selected.subject_id}`,{query:{locale:'zh'}}):null;
    if(a&&!Array.isArray(latest?.data))throw fail('类目属性暂时无法核对，请稍后重试。',502);
    const result=await validatePayload(tenantId,body,latest?.data||selected.attributes);
    if(body.payload.currency!=='CNY')result.errors.push('售价币种须为人民币 CNY。');
    if(a){if((selected.defaults.environment||'production')!==a.environment)result.errors.push('目标店铺与模板环境不一致，请同步该店铺的类目字段。');}else result.errors.push('上架店铺：请在页面顶部选择目标 WB 店铺。');
    return {...result,ok:!result.errors.length,review_only:true};
  }
  return {previewListingPayload,workbenchDrafts,listingTemplates,saveListingTemplate,listingDrafts,saveListingDraft,validateListingDraft};
}
