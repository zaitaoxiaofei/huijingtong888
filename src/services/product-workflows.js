import { workflowRunIdentity } from '../shared/workflow-run-identity.js';
import {starterWorkflow} from '../shared/workflow-starter.js';
import {aiVehicleCatalog} from './ai-vehicle-catalog.js';
import {bindMaterialToCatalog,requireCatalogBindings} from '../shared/workflow-catalog-bindings.js';
import {isReviewedMold,isKeyMold} from '../shared/key-mold-mapping.js';
import { materialMatches,materialBindings,materialCoversFitments,normalizeMaterialBindings } from '../shared/workflow-materials.js';
import { randomUUID } from "node:crypto";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey } from "./business-task-tenant.js";
import { validateWorkflow, validateWorkflowVariants, buildWorkflowDraft, workflowError } from "../shared/product-workflow.js";

import { normalizeWorkflowKeyModel, normalizeWorkflowMaterial } from "../shared/workflow-key-models.js";

// Model words must match business data, never media hosts, hashes or internal IDs.
const MATERIAL_SEARCH_TEXT=`CONCAT_WS(' ',${['name','label','brand','model','coreName','searchTerms','notes','moldCode','shape','material','category','listingCategory.name','bindings[*].brand','bindings[*].models'].map(key=>`JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.${key}'))`).join(',')})`;

const SCHEMA=`CREATE TABLE IF NOT EXISTS product_workflow_documents (
  id VARCHAR(36) NOT NULL, tenant_id VARCHAR(64) NOT NULL, kind VARCHAR(16) NOT NULL,
  name VARCHAR(200) NOT NULL, revision INT NOT NULL DEFAULT 1, payload_json LONGTEXT NOT NULL,
  created_by BIGINT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id), INDEX idx_workflow_list (tenant_id, kind, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

// Dependencies are injectable so isolation and optimistic writes can be verified without real AI or MySQL.
export function createProductWorkflowStore({query=mysqlQuery,execute=mysqlExecute,authorize=authorizeBusinessTaskSession,loadCatalog=aiVehicleCatalog,ensureSchema=()=>execute(SCHEMA)}={}) {
  let schema;
  async function scope(session) {
    const actor=await authorize(session); assertBusinessTaskPermission(actor,"operations");
    if(!schema) schema=ensureSchema().catch(error=>{schema=null;throw error;});
    await schema;return {tenant:businessTaskTenantKey(actor),actor};
  }
  const catalogFor=async actor=>loadCatalog?(await loadCatalog({},actor)).brands:null;
  const decorate=async(records,actor)=>{const brands=await catalogFor(actor);return brands?records.map(r=>bindMaterialToCatalog(r,brands)):records;};
  const map=row=>({id:row.id,name:row.name,revision:Number(row.revision),kind:row.kind,payload:JSON.parse(row.payload_json)});
  async function list(kind,session,options={}) {
    const {tenant,actor}=await scope(session);
    if(['prompt','optimization'].includes(kind)){
      const rows=await query("SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false' ORDER BY updated_at DESC LIMIT 500",[tenant,kind]);
      return rows.map(row=>({...map(row),updated_at:row.updated_at}));
    }
    if(kind==='library'||kind==='mapping'){
      const size=Math.max(1,Math.min(48,Number.parseInt(options.pageSize,10)||12)),keyword=String(options.keyword||'').trim().slice(0,200);
      const filters=["tenant_id = ?", "kind IN ('material','key_model')", "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false'"];
      const terms=keyword.split(/\s+/).filter(Boolean);if(!terms.length)terms.push('');
      const params=[tenant];for(const term of terms){filters.push(`(LOWER(name) LIKE LOWER(?) OR LOWER(${MATERIAL_SEARCH_TEXT}) LIKE LOWER(?))`);params.push(`%${term}%`,`%${term}%`);}
      if(options.reviewStatus&&['pending','verified'].includes(options.reviewStatus)){filters.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.reviewStatus')), 'verified') = ?");params.push(options.reviewStatus);}
      if(options.role==='compatibility'||kind==='mapping')filters.push("(kind = 'key_model' OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.role')) = 'compatibility')");
      if(options.category){filters.push("(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.listingCategory.key')) = ? OR JSON_EXTRACT(payload_json, '$.listingCategory') IS NULL OR JSON_TYPE(JSON_EXTRACT(payload_json, '$.listingCategory')) = 'NULL')");params.push(String(options.category));}
      if(options.brand){
        const brands=await catalogFor(actor),models=options.model?[String(options.model)]:(brands?.find(b=>b.name===options.brand)?.models||[]).map(m=>m.name);
        const pairs=[{brand:String(options.brand),model:String(options.model||'')},...models.flatMap(model=>{const words=model.split(' ');return words.slice(0,-1).map((_,i)=>({brand:[options.brand,...words.slice(0,i+1)].join(' '),model:words.slice(i+1).join(' ')}));})];
        const clauses=pairs.map(pair=>{if(options.model){params.push(pair.brand,pair.model,JSON.stringify([{brand:pair.brand,models:[pair.model]}]),JSON.stringify([{brand:pair.brand,allModels:true}]));return "((LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.brand'))) = LOWER(?) AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.model'))) = LOWER(?)) OR JSON_CONTAINS(LOWER(payload_json), LOWER(?), '$.bindings') OR JSON_CONTAINS(LOWER(payload_json), LOWER(?), '$.bindings'))";}params.push(pair.brand,pair.brand);return "(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.brand')) = ? OR JSON_SEARCH(LOWER(payload_json), 'one', LOWER(?), NULL, '$.bindings[*].brand') IS NOT NULL)";});
        filters.push('('+clauses.join(' OR ')+')');
      }
      const filter=filters.join(' AND ');
      if(kind==='mapping'){const rows=await query(`SELECT * FROM product_workflow_documents WHERE ${filter} ORDER BY updated_at DESC, id DESC LIMIT 5001`,params);if(rows.length>5000)throw workflowError('导出超过5000份模具，请缩小搜索范围');return decorate(rows.map(map),actor);}
      const total=Number((await query(`SELECT COUNT(*) AS total FROM product_workflow_documents WHERE ${filter}`,params))[0]?.total||0);
      const page=Math.max(1,Math.min(Math.ceil(total/size)||1,Number.parseInt(options.page,10)||1));
      const rows=await query(`SELECT * FROM product_workflow_documents WHERE ${filter} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,[...params,size,(page-1)*size]);
      return {items:await decorate(rows.map(map),actor),total,page,pageSize:size};
    }
    if(kind==='run'&&options.page!==undefined){
      const size=Math.max(1,Math.min(100,Number.parseInt(options.pageSize,10)||20)),keyword=String(options.keyword||'').trim().slice(0,200);
      const filters=["tenant_id = ?", "kind = ?", "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false'"];
      const params=[tenant,kind];
      if(options.section==='results')filters.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.draftId')), '') NOT IN ('', 'null')");
      else filters.push("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.draftId')), '') IN ('', 'null')");
      if(keyword){filters.push("CONCAT_WS(' ', name, JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.definition.category.categoryName')), JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.variants[*].label')), JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.variants[*].fitments')), JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sharedValues.__fitments'))) LIKE ?");params.push(`%${keyword}%`);}
      const filter=filters.join(' AND '),total=Number((await query(`SELECT COUNT(*) AS total FROM product_workflow_documents WHERE ${filter}`,params))[0]?.total||0);
      const page=Math.max(1,Math.min(Math.ceil(total/size)||1,Number.parseInt(options.page,10)||1));
      const rows=await query(`SELECT id, name, revision, updated_at,
        JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.draftId')) AS draft_id,
        JSON_LENGTH(JSON_EXTRACT(payload_json, '$.variants')) AS variant_count,
        JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.variants[0].label')) AS product_label,
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.definition.category.categoryName')), JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.definition.category.name'))) AS category_name,
        JSON_EXTRACT(payload_json, '$.sharedValues.__fitments', '$.variants[*].values.__fitments', '$.variants[*].fitments') AS fitments_json
        FROM product_workflow_documents WHERE ${filter} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,[...params,size,(page-1)*size]);
      const items=rows.map(row=>({...row,draft_id:row.draft_id==='null'?null:row.draft_id,revision:Number(row.revision),...workflowRunIdentity(row.fitments_json)}));
      return {items,total,page,pageSize:size};
    }
    if(kind==='template'&&options.page!==undefined){
      const size=Math.max(1,Math.min(48,Number.parseInt(options.pageSize,10)||12)),keyword=String(options.keyword||'').trim().slice(0,200);
      const filter="tenant_id = ? AND kind = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false' AND (name LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.category.categoryName')) LIKE ?)";
      const params=[tenant,'template',`%${keyword}%`,`%${keyword}%`];
      let total=Number((await query(`SELECT COUNT(*) AS total FROM product_workflow_documents WHERE ${filter}`,params))[0]?.total||0);
      // First visit provisions an editable sample within this tenant only. No customer assets are copied.
      if(!total&&!keyword){
        const payload=starterWorkflow(null,{sample:true});
        await execute("INSERT IGNORE INTO product_workflow_documents (id, tenant_id, kind, name, payload_json, created_by) SELECT ?, ?, 'template', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM product_workflow_documents WHERE tenant_id = ? AND kind = 'template')",['00000000-0000-4000-8000-000000000001',tenant,payload.name,JSON.stringify(payload),actor.personId,tenant]);
        total=Number((await query(`SELECT COUNT(*) AS total FROM product_workflow_documents WHERE ${filter}`,params))[0]?.total||0);
      }

      const page=Math.max(1,Math.min(Math.ceil(total/size)||1,Number.parseInt(options.page,10)||1));
      const rows=await query(`SELECT * FROM product_workflow_documents WHERE ${filter} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,[...params,size,(page-1)*size]);
      const items=rows.map(row=>{const doc=map(row);return {id:doc.id,name:doc.name,revision:doc.revision,category_name:doc.payload.category?.categoryName||doc.payload.category?.name||(doc.payload.starterSample?'宠物玩具示例 · 待关联官方类目':''),preview_image:doc.payload.previewImage||''};});
      const missing=items.filter(item=>!item.preview_image);
      if(missing.length){
        const recent=await query(`SELECT payload_json FROM product_workflow_documents WHERE tenant_id = ? AND kind = 'run' AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.templateId')) IN (${missing.map(()=>'?').join(',')}) AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.draftId')) NOT IN ('null', '') ORDER BY updated_at DESC LIMIT 100`,[tenant,...missing.map(item=>item.id)]);
        for(const row of recent){const run=JSON.parse(row.payload_json),item=items.find(item=>item.id===run.templateId&&!item.preview_image),main=run.definition?.nodes.find(n=>n.type==='image'&&n.role==='main');if(item&&main)item.preview_image=run.outputs?.[run.variants?.[0]?.id]?.[main.id]?.url||'';}
      }
      return {items,total,page,pageSize:size};
    }
    if(['key_model','material'].includes(kind)){
      const keyword=String(options.keyword||options.model||'').trim().slice(0,200);
      const rows=await query(`SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false' AND (LOWER(name) LIKE LOWER(?) OR LOWER(${MATERIAL_SEARCH_TEXT}) LIKE LOWER(?)) ORDER BY updated_at DESC LIMIT 500`,[tenant,kind,`%${keyword}%`,`%${keyword}%`]);
      return decorate(rows.map(map).filter(record=>!record.payload.archived),actor);
    }
    return (await query(`SELECT id, name, revision, kind, updated_at,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.draftId')) AS draft_id,
      JSON_LENGTH(JSON_EXTRACT(payload_json, '$.variants')) AS variant_count,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.variants[0].label')) AS product_label,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.productionMode')) AS production_mode,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.category.categoryName')), JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.definition.category.categoryName')), JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.definition.category.name'))) AS category_name,
      JSON_EXTRACT(payload_json, '$.sharedValues.__fitments', '$.variants[*].values.__fitments') AS fitments_json
      FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false' ORDER BY updated_at DESC LIMIT 100`,[tenant,kind])).map(row=>({...row,draft_id:row.draft_id==='null'?null:row.draft_id,revision:Number(row.revision),...workflowRunIdentity(row.fitments_json)}));
  }
  async function get(kind,id,session) {
    const {tenant,actor}=await scope(session);
    const row=(await query("SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? AND id = ?",[tenant,kind,id]))[0];
    if(!row||(['run','template'].includes(kind)&&JSON.parse(row.payload_json).archived)) throw Object.assign(new Error("当前企业中没有这个工作流记录"),{status:404});return ['material','key_model'].includes(kind)?(await decorate([map(row)],actor))[0]:map(row);
  }
  async function save(kind,body,session) {
    const {tenant,actor}=await scope(session);
    if(['material','key_model'].includes(kind)&&loadCatalog){const brands=await catalogFor(actor),bindings=requireCatalogBindings(Object.hasOwn(body.payload||{},'bindings')?body.payload.bindings:materialBindings(body.payload),brands);body={...body,payload:{...body.payload,brand:bindings[0]?.brand||'',model:bindings[0]?.models[0]||'',bindings}};}
    const payload=kind==='key_model'?normalizeWorkflowKeyModel(body.payload):kind==='material'?normalizeWorkflowMaterial(body.payload):body.payload;
    if(kind==="template")validateWorkflow(payload);
    else if(['prompt','optimization'].includes(kind)) {
      if(!payload || typeof payload !== 'object' || Array.isArray(payload) || !String(payload.name||'').trim())throw workflowError('请填写记录名称');
      if(kind==='prompt' && (!['main','detail','title','tags','description'].includes(payload.category)||!String(payload.prompt||'').trim()))throw workflowError('请选择提示词分类并填写提示词');
    }
    else if(!['key_model','material'].includes(kind)) {
      validateWorkflow(payload?.definition);
      validateWorkflowVariants(payload.definition,payload.variants);
      if(!payload.outputs || typeof payload.outputs!=="object" || Array.isArray(payload.outputs))throw workflowError("任务结果格式无效");
    }
    const name=String(kind!=="run"?payload.name:payload.definition.name).trim();
    if(name.length>200)throw workflowError("模板名称最多 200 个字符");
    const serialized=JSON.stringify(payload);
    if(Buffer.byteLength(serialized)>4*1024*1024)throw workflowError("工作流记录超过 4 MB，请减少内容；图片必须上传，不能嵌入文件");
    if(body.id) {
      const previous=await get(kind,body.id,session);
      if(kind==='run'&&previous.payload.executionMode==='background')throw workflowError('后台生产任务请使用确认、编辑文案或重试操作，不能覆盖整条任务记录');
      if(kind==="run" && JSON.stringify([previous.payload.definition,previous.payload.variants])!==JSON.stringify([payload.definition,payload.variants]))throw workflowError("任务已锁定模板和材料；请创建新任务使用修改后的内容");
      if(kind==="run" && (previous.payload.draftId!==payload.draftId || previous.payload.draftImportStatus!==payload.draftImportStatus))throw workflowError("草稿导入状态只能通过导入操作更新");
      if(kind==="run" && previous.payload.draftImportStatus==="unknown")throw Object.assign(new Error("草稿导入状态待核对，请点击导入操作箱核对已有结果"),{status:409});
      const result=await execute("UPDATE product_workflow_documents SET name = ?, payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND kind = ? AND id = ? AND revision = ?",[name,serialized,tenant,kind,body.id,Number(body.revision)]);
      if(!result.affectedRows)throw Object.assign(new Error("记录已被其他页面修改，请重新打开后继续"),{status:409});
      return {...previous,name,payload,revision:previous.revision+1};
    }
    if(body.creationId&&(kind!=="run"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.creationId)))throw workflowError("生产提交标识无效，请重新打开生产窗口");
    const id=body.creationId||randomUUID();
    if(kind==="run" && (payload.draftId || payload.draftImportStatus))throw workflowError("新任务不能指定已有草稿或导入状态");
    try{await execute("INSERT INTO product_workflow_documents (id, tenant_id, kind, name, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?)",[id,tenant,kind,name,serialized,actor.personId]);}
    catch(error){if(body.creationId&&error.code==='ER_DUP_ENTRY')return get(kind,id,session);throw error;}
    return {id,kind,name,payload,revision:1};
  }
  async function archiveTemplate(body,session){
    const {tenant}=await scope(session),previous=await get('template',String(body.id||''),session);
    if(!Number.isInteger(body.revision)||body.revision!==previous.revision)throw Object.assign(new Error('流程已被修改，请刷新后再删除'),{status:409});
    const result=await execute("UPDATE product_workflow_documents SET payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND kind = 'template' AND id = ? AND revision = ?",[JSON.stringify({...previous.payload,archived:true}),tenant,previous.id,body.revision]);
    if(!result.affectedRows)throw Object.assign(new Error('流程已被修改，请刷新后再删除'),{status:409});
    return {ok:true,id:previous.id};
  }
  async function importMappings(records,session,transaction=withMysqlTransaction){
    const {actor}=await scope(session);
    const brands=await catalogFor(actor);
    if(!Array.isArray(records)||!records.length||records.length>100)throw workflowError('每次请导入1–100份模具');
    if(records.some(r=>!r||!['material','key_model'].includes(r.kind)||!r.patch||r.patch.role!=='compatibility'||(r.id&&(!Number.isSafeInteger(r.revision)||r.revision<1))))throw workflowError('映射表只能更新钥匙模具资料');
    return transaction(async connection=>{
      const scoped=createProductWorkflowStore({query:async(sql,p)=>(await connection.execute(sql,p))[0],execute:async(sql,p)=>(await connection.execute(sql,p))[0],authorize:async()=>actor,loadCatalog:brands?async()=>({brands}):null,ensureSchema:async()=>{}});
      const saved=[];
      for(const row of records){const previous=row.id?await scoped.get(row.kind,row.id,actor):null;if(previous&&!isKeyMold(previous))throw workflowError('映射表不能将其他生产资料改为钥匙模具');const payload={...previous?.payload,...row.patch};if(row.kind==='key_model'){payload.brand=payload.bindings?.[0]?.brand||'';payload.model=payload.bindings?.[0]?.models?.[0]||'';payload.label=row.patch.name;}
        saved.push(await scoped.save(row.kind,{id:row.id,revision:row.revision,payload},actor));}
      return {count:saved.length,items:saved};
    });
  }
  async function matchingKeys(fitments,category,session,{includePending=false}={}){
    const {tenant,actor}=await scope(session);
    normalizeMaterialBindings(fitments.map(f=>({brand:f?.brand,models:[f?.model]})));
    if(!fitments.length)return [];
    // Search by confirmed brand before matching all fitments; no first-500 truncation.
    const names=[...new Set(fitments.flatMap(f=>{const parts=String(f.model).split(' ');return [f.brand,...parts.slice(0,-1).map((_,i)=>[f.brand,...parts.slice(0,i+1)].join(' '))];}))];
    const match=names.map(()=>"(LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.brand'))) = LOWER(?) OR JSON_SEARCH(LOWER(payload_json), 'one', LOWER(?), NULL, '$.bindings[*].brand') IS NOT NULL)").join(' OR ');
    const rows=await query(`SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind IN ('material','key_model') AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false' AND (${match}) ORDER BY updated_at DESC, id DESC`,[tenant,...names.flatMap(name=>[name,name])]);
    return (await decorate(rows.map(map),actor)).filter(r=>(includePending||isReviewedMold(r))&&r.payload.images?.length&&(r.kind==='key_model'||r.payload.role==='compatibility')&&materialBindings(r.payload).length&&materialMatches(r,{category,fitments})&&materialCoversFitments(r,fitments));
  }
  async function factsHistory(session){
    const {tenant,actor}=await scope(session);
    const rows=await query("SELECT id, name, JSON_EXTRACT(payload_json, '$.variants') AS variants_json FROM product_workflow_documents WHERE tenant_id = ? AND kind = 'run' ORDER BY updated_at DESC LIMIT 60",[tenant]);
    const result=[],seen=new Set();
    for(const row of rows)for(const variant of (typeof row.variants_json==='string'?JSON.parse(row.variants_json):row.variants_json)||[]){const facts=String(variant.values?.facts||'').trim();if(!facts||seen.has(facts))continue;seen.add(facts);result.push({id:`${row.id}:${variant.id}`,runId:row.id,name:row.name,product:variant.label,facts});if(result.length>=40)return result;}
    return result;
  }
  return {list,get,save,scope,factsHistory,matchingKeys,importMappings,archiveTemplate};
}
export const productWorkflowStore=createProductWorkflowStore();

export async function importProductWorkflowDraft(id,session,services,{store=productWorkflowStore,transaction=withMysqlTransaction,execute=mysqlExecute}={}) {
  const {tenant,actor}=await store.scope(session);
  const claim=await transaction(async connection=>{
    const [rows]=await connection.execute("SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = 'run' AND id = ? FOR UPDATE",[tenant,id]);
    if(!rows[0])throw Object.assign(new Error("当前企业中没有这个任务"),{status:404});
    const run=JSON.parse(rows[0].payload_json);
    if(run.draftId)return {id:run.draftId};
    if(run.draftImportStatus==="unknown"){
      const [drafts]=await connection.execute("SELECT id FROM listing_drafts WHERE COALESCE(tenant_id, 'admin') = ? AND JSON_UNQUOTE(JSON_EXTRACT(ai_payload_json, '$.workflow_run_id')) = ? AND status <> 'deleted' LIMIT 2",[tenant,id]);
      if(drafts.length!==1)throw Object.assign(new Error(`任务 ${id} 的导入状态待核对，请先检查操作箱，避免重复创建草稿`),{status:409});
      run.draftId=drafts[0].id;run.draftImportStatus="done";
      await connection.execute("UPDATE product_workflow_documents SET payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?",[JSON.stringify(run),tenant,id]);
      return {id:run.draftId};
    }
    const definition=validateWorkflow(run.definition);
    validateWorkflowVariants(definition,run.variants);
    const templateId=Number(definition.nodes.find(n=>n.type==="listing").templateId);
    if(!templateId)throw workflowError("类目模板尚未设置，请修改模板后新建任务");
    const currentTemplate=await services.listingCategoryTemplateDetail(templateId,actor);
    const template=run.listingSnapshot||currentTemplate;
    if(run.listingSnapshot)for(const key of ['description_category_id','type_id'])if(Number(template[key]||template.editable_payload?.[key])!==Number(currentTemplate[key]||currentTemplate.editable_payload?.[key]))throw workflowError('原类目模板的分类已变化，请重新绑定类目后创建生产任务');
    const body=buildWorkflowDraft(definition,run.variants,run.outputs,template,id);
    run.draftImportStatus="unknown";
    await connection.execute("UPDATE product_workflow_documents SET payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?",[JSON.stringify(run),tenant,id]);
    return {body,run};
  });
  if(claim.id)return {id:claim.id};
  const draft=await services.createListingDraft(claim.body,actor);
  const draftId=draft.id||draft.draft_id;
  if(!draftId)throw new Error("草稿保存未返回标识，请点击导入操作箱核对已有结果");
  claim.run.draftId=draftId;claim.run.draftImportStatus="done";
  await execute("UPDATE product_workflow_documents SET payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND kind = 'run' AND id = ?",[JSON.stringify(claim.run),tenant,id]);
  const main=claim.run.definition.nodes.find(n=>n.type==='image'&&n.role==='main'),preview=main&&claim.run.outputs?.[claim.run.variants[0]?.id]?.[main.id]?.url;
  if(claim.run.templateId&&preview&&Number.isSafeInteger(Number(claim.run.templateRevision))&&Number(claim.run.templateRevision)>0)await execute("UPDATE product_workflow_documents SET payload_json = JSON_SET(payload_json, '$.previewImage', ?), revision = revision + 1 WHERE tenant_id = ? AND kind = 'template' AND id = ? AND revision = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.previewImage')), '') = ''",[preview,tenant,claim.run.templateId,Number(claim.run.templateRevision)]).catch(error=>console.warn('workflow preview cache',error.message));
  return {id:draftId};
}
