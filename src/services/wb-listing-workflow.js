import { wbListingValidation } from '../shared/wb-listing-validation.js';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const id=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw fail('请选择有效的 WB 模板或草稿。',400);return n;};
export function createWbListingWorkflow({query,request,account}) {
  async function template(tenantId,templateId){const [row]=await query('SELECT * FROM wb_listing_templates WHERE id=? AND tenant_id=?',[id(templateId),id(tenantId)]);if(!row)throw fail('WB 类目模板不存在或不属于当前企业。',404);return {...row,attributes:parse(row.attributes_json),defaults:parse(row.defaults_json),attributes_json:undefined,defaults_json:undefined};}
  async function listingTemplates(tenantId,body){await account(tenantId,body.shop_id);const rows=await query('SELECT id FROM wb_listing_templates WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 200',[id(tenantId)]);return {rows:await Promise.all(rows.map(r=>template(tenantId,r.id)))};}
  async function saveListingTemplate(tenantId,body){
    const a=await account(tenantId,body.shop_id),subject=id(body.subject_id),name=String(body.name||'').trim();
    if(!name||name.length>120)throw fail('模板名称：请填写 1–120 个字符。',400);
    const result=await request(a,'content',`/content/v2/object/charcs/${subject}`,{query:{locale:'zh'}});
    if(!Array.isArray(result.data)||!result.data.length)throw fail('WB 没有返回该类目的属性，模板尚未导入，请重新选择类目。',502);
    const defaults=body.defaults||{currency:'CNY',characteristics:[]};
    if(defaults.currency!=='CNY'||JSON.stringify(defaults).length>100000)throw fail('中国主体 WB 模板使用人民币 CNY；请核对模板默认值。',400);
    const attributes=result.data,categoryName=String(attributes[0].subjectName||body.category_name||subject);
    try{
      if(body.template_id){const previous=await template(a.tenant_id,body.template_id);if(Number(previous.subject_id)!==subject)throw fail('已有模板不能替换类目，请为新类目新建模板。');const changed=await query('UPDATE wb_listing_templates SET name=?,category_name=?,attributes_json=?,defaults_json=?,revision=revision+1 WHERE id=? AND tenant_id=? AND revision=?',[name,categoryName,JSON.stringify(attributes),JSON.stringify(defaults),previous.id,a.tenant_id,Number(body.revision)]);if(!changed.affectedRows)throw fail('模板已在其他窗口更新，请刷新后重试。');return {ok:true,template:await template(a.tenant_id,previous.id)};}
      const saved=await query('INSERT INTO wb_listing_templates (tenant_id,name,subject_id,category_name,attributes_json,defaults_json) VALUES (?,?,?,?,?,?)',[a.tenant_id,name,subject,categoryName,JSON.stringify(attributes),JSON.stringify(defaults)]);return {ok:true,template:await template(a.tenant_id,saved.insertId)};
    }catch(error){if(error.code==='ER_DUP_ENTRY')throw fail('本企业已有同名 WB 模板，请编辑已有模板。');throw error;}
  }
  async function owned(tenantId,body){const a=await account(tenantId,body.shop_id);const [row]=await query('SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=?',[id(body.draft_id),a.tenant_id,a.shop_id]);if(!row)throw fail('WB 草稿不存在或不属于当前店铺。',404);return {a,row,payload:parse(row.payload_json)};}
  async function listingDrafts(tenantId,body){const a=await account(tenantId,body.shop_id);const rows=await query('SELECT * FROM wb_listing_drafts WHERE tenant_id=? AND shop_id=? ORDER BY updated_at DESC LIMIT 200',[a.tenant_id,a.shop_id]);return {rows:rows.map(row=>({...row,payload:parse(row.payload_json),payload_json:undefined}))};}
  async function saveListingDraft(tenantId,body){
    const a=await account(tenantId,body.shop_id),payload=body.payload;
    const selected=await template(a.tenant_id,payload?.template_id);
    if(Number(payload.subject_id)!==Number(selected.subject_id))throw fail('草稿类目与所选 WB 模板不一致，请重新套用模板。',400);
    const vendor=String(payload.card?.vendorCode||'').trim();
    if(!vendor||vendor.length>72||JSON.stringify(payload).length>1000000)throw fail('草稿商家货号：请填写 1–72 个字符，图片请使用地址。',400);
    if(payload.currency!=='CNY')throw fail('WB 草稿售价币种须为人民币 CNY，不能沿用 Ozon 币种。',400);
    const saved={...payload,template_revision:selected.revision,template_name:selected.name,attributes_schema:selected.attributes};
    if(body.draft_id){const {row}=await owned(tenantId,body);if(row.status!=='draft'||row.vendor_code!==vendor)throw fail('该草稿已提交或货号已变化，不能覆盖。');const r=await query('UPDATE wb_listing_drafts SET template_id=?,payload_json=?,revision=revision+1 WHERE id=? AND tenant_id=? AND shop_id=? AND revision=? AND status=\'draft\'',[selected.id,JSON.stringify(saved),row.id,a.tenant_id,a.shop_id,Number(body.revision)]);if(!r.affectedRows)throw fail('草稿已在其他窗口修改，请刷新后重试。');return {ok:true,draft_id:row.id,revision:Number(row.revision)+1};}
    try{const r=await query("INSERT INTO wb_listing_drafts (tenant_id,shop_id,template_id,vendor_code,payload_json,status) VALUES (?,?,?,?,?,'draft')",[a.tenant_id,a.shop_id,selected.id,vendor,JSON.stringify(saved)]);return {ok:true,draft_id:r.insertId,revision:1};}catch(error){if(error.code==='ER_DUP_ENTRY')throw fail('该 WB 店铺已存在此货号草稿，请在草稿列表继续编辑。');throw error;}
  }
  async function validateListingDraft(tenantId,body){const {a,payload}=await owned(tenantId,body),selected=await template(a.tenant_id,payload.template_id);const current=await request(a,'content',`/content/v2/object/charcs/${selected.subject_id}`,{query:{locale:'zh'}});const result=wbListingValidation(payload,current.data||[]);if(payload.currency!=='CNY')result.errors.push('售价币种：请选择人民币 CNY。');return {...result,ok:!result.errors.length,review_only:true,message:'本次只校验资料，不会向 WB 创建商品、生成条码、发布价格或库存。'};}
  return {listingTemplates,saveListingTemplate,listingDrafts,saveListingDraft,validateListingDraft};
}
