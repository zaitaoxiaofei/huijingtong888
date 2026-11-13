import {mysqlQuery,mysqlExecute} from '../mysql-pool.js';
import {authorizeBusinessTaskSession,assertBusinessTaskPermission,businessTaskTenantKey} from './business-task-tenant.js';
import {createAiGenerationTasks,mapAiGenerationTaskRow,ensureAiGenerationTaskSchema,startAiGenerationTaskWorker} from './ai-generation-tasks.js';

// Workflow documents are enterprise-owned. Public AI task endpoints remain
// person-scoped; only this internal path can recover a colleague's task receipt.
export function createWorkflowAiTaskAccess({query=mysqlQuery,execute=mysqlExecute,authorize=authorizeBusinessTaskSession,ensureSchema=ensureAiGenerationTaskSchema,create=createAiGenerationTasks,map=mapAiGenerationTaskRow,startWorker=startAiGenerationTaskWorker}={}){
  async function scope(session){const actor=await authorize(session);assertBusinessTaskPermission(actor,'operations');await ensureSchema();return {actor,tenant:businessTaskTenantKey(actor)};}
  async function find(workflowId,taskId,session){
    const {tenant}=await scope(session);
    const rows=await query(`SELECT t.* FROM ai_generation_tasks t
      WHERE t.tenant_id=? AND t.source_module='product_workflow' AND t.workflow_id=? AND t.task_no=?
      AND EXISTS (SELECT 1 FROM product_workflow_documents d WHERE d.tenant_id=? AND d.id=? AND d.kind='run'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(d.payload_json,'$.archived')),'false')='false') LIMIT 1`,[tenant,workflowId,taskId,tenant,workflowId]);
    return map(rows[0]);
  }
  async function submit(workflowId,body,session){
    if(body.workflowId!==workflowId||body.sourceModule!=='product_workflow')throw new Error('工作流任务归属不一致');
    try{return await create(body,session);}catch(error){
      if(error.code!=='ER_DUP_ENTRY')throw error;
      const task=await find(workflowId,body.taskId,session);
      if(!task||task.fieldKey!==body.fieldKey||task.resultId!==body.resultId)throw error;
      return {ok:true,tasks:[task],taskId:task.taskId,taskIds:[task.taskId]};
    }
  }
  async function retry(workflowId,taskId,session){
    const {tenant}=await scope(session),task=await find(workflowId,taskId,session);
    if(!task)throw Object.assign(new Error('当前企业中未找到这个工作流的原任务'),{status:404});
    await execute(`UPDATE ai_generation_tasks t
      SET t.status='queued',t.error_json=NULL,t.output_json=CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(t.output_json,'$.stage'))='generated_image_v1' THEN t.output_json ELSE NULL END,t.started_at=NULL,t.finished_at=NULL
      WHERE t.tenant_id=? AND t.source_module='product_workflow' AND t.workflow_id=? AND t.task_no=? AND t.status IN ('failed','cancelled','provider_pending')
      AND EXISTS (SELECT 1 FROM product_workflow_documents d WHERE d.tenant_id=? AND d.id=? AND d.kind='run'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(d.payload_json,'$.archived')),'false')='false')`,[tenant,workflowId,taskId,tenant,workflowId]);
    startWorker();return {ok:true,task:await find(workflowId,taskId,session)};
  }
  return {find,submit,retry};
}
export const workflowAiTaskAccess=createWorkflowAiTaskAccess();
