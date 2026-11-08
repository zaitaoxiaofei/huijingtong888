import { randomUUID } from "node:crypto";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey } from "./business-task-tenant.js";
import { validateWorkflow, validateWorkflowVariants, buildWorkflowDraft, workflowError } from "../shared/product-workflow.js";

import { normalizeWorkflowKeyModel } from "../shared/workflow-key-models.js";

const SCHEMA=`CREATE TABLE IF NOT EXISTS product_workflow_documents (
  id VARCHAR(36) NOT NULL, tenant_id VARCHAR(64) NOT NULL, kind VARCHAR(16) NOT NULL,
  name VARCHAR(200) NOT NULL, revision INT NOT NULL DEFAULT 1, payload_json LONGTEXT NOT NULL,
  created_by BIGINT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id), INDEX idx_workflow_list (tenant_id, kind, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

// Dependencies are injectable so isolation and optimistic writes can be verified without real AI or MySQL.
export function createProductWorkflowStore({query=mysqlQuery,execute=mysqlExecute,authorize=authorizeBusinessTaskSession}={}) {
  let schema;
  async function scope(session) {
    const actor=await authorize(session); assertBusinessTaskPermission(actor,"operations");
    if(!schema) schema=execute(SCHEMA).catch(error=>{schema=null;throw error;});
    await schema;return {tenant:businessTaskTenantKey(actor),actor};
  }
  const map=row=>({id:row.id,name:row.name,revision:Number(row.revision),kind:row.kind,payload:JSON.parse(row.payload_json)});
  async function list(kind,session,options={}) {
    const {tenant}=await scope(session);
    if(kind==='key_model'){
      const keyword=String(options.keyword||options.model||'').trim().slice(0,200);
      const rows=await query("SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.archived')), 'false') = 'false' AND name LIKE ? ORDER BY updated_at DESC LIMIT 500",[tenant,kind,`%${keyword}%`]);
      return rows.map(map).filter(record=>!record.payload.archived);
    }
    return (await query(`SELECT id, name, revision, kind,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.draftId')) AS draft_id,
      JSON_LENGTH(JSON_EXTRACT(payload_json, '$.variants')) AS variant_count,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.variants[0].label')) AS product_label,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.productionMode')) AS production_mode,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.category.categoryName')) AS category_name
      FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 100`,[tenant,kind])).map(row=>({...row,draft_id:row.draft_id==='null'?null:row.draft_id,revision:Number(row.revision)}));
  }
  async function get(kind,id,session) {
    const {tenant}=await scope(session);
    const row=(await query("SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = ? AND id = ?",[tenant,kind,id]))[0];
    if(!row) throw Object.assign(new Error("当前企业中没有这个工作流记录"),{status:404});return map(row);
  }
  async function save(kind,body,session) {
    const {tenant,actor}=await scope(session);
    const payload=kind==='key_model'?normalizeWorkflowKeyModel(body.payload):body.payload;
    if(kind==="template")validateWorkflow(payload);
    else if(kind!=='key_model') {
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
      return {...previous,payload,revision:previous.revision+1};
    }
    if(body.creationId&&(kind!=="run"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.creationId)))throw workflowError("生产提交标识无效，请重新打开生产窗口");
    const id=body.creationId||randomUUID();
    if(kind==="run" && (payload.draftId || payload.draftImportStatus))throw workflowError("新任务不能指定已有草稿或导入状态");
    try{await execute("INSERT INTO product_workflow_documents (id, tenant_id, kind, name, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?)",[id,tenant,kind,name,serialized,actor.personId]);}
    catch(error){if(body.creationId&&error.code==='ER_DUP_ENTRY')return get(kind,id,session);throw error;}
    return {id,kind,name,payload,revision:1};
  }
  return {list,get,save,scope};
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
  return {id:draftId};
}
