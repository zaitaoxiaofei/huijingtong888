import { randomUUID } from 'node:crypto';
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from '../mysql-pool.js';
import { restoreBusinessTaskSession, authorizeBusinessTaskSession, assertBusinessTaskPermission } from './business-task-tenant.js';
import { productWorkflowStore, importProductWorkflowDraft } from './product-workflows.js';
import { createAiGenerationTasks, aiGenerationTasks, retryAiGenerationTask } from './ai-generation-tasks.js';
import { advanceProductWorkflow, invalidateWorkflowResults } from './product-workflow-execution.js';
import { buildWorkflowDraft, workflowInputContext, workflowError } from '../shared/product-workflow.js';

let schema;
export async function ensureProductWorkflowJobs() {
  if(!schema)schema=mysqlExecute(`CREATE TABLE IF NOT EXISTS product_workflow_jobs (
    tenant_id VARCHAR(64) NOT NULL, run_id VARCHAR(36) NOT NULL, person_id BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued', lease_token VARCHAR(36) NULL, lease_until DATETIME NULL,
    next_tick_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, error_message TEXT NULL,
    PRIMARY KEY (tenant_id, run_id), INDEX idx_workflow_job_pick (status, next_tick_at, lease_until)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error=>{schema=null;throw error;});
  await schema;
}
let timer,working=false;
export async function startProductWorkflowRunner() {
  await ensureProductWorkflowJobs();
  if(timer)return;
  timer=setInterval(()=>tickProductWorkflowJobs().catch(error=>console.error('product workflow runner',error.message)),2000);
  timer.unref?.();
}
export async function enqueueProductWorkflow(id,session) {
  const {tenant,actor}=await productWorkflowStore.scope(session);
  await productWorkflowStore.get('run',id,actor);
  await ensureProductWorkflowJobs();
  await mysqlExecute(`INSERT INTO product_workflow_jobs (tenant_id, run_id, person_id, status) VALUES (?, ?, ?, 'queued')
    ON DUPLICATE KEY UPDATE run_id = VALUES(run_id)`,[tenant,id,actor.personId]);
  await startProductWorkflowRunner();
}

export async function tickProductWorkflowJobs() {
  if(working)return;working=true;
  try {
    const job=await withMysqlTransaction(async connection=>{
      const [rows]=await connection.execute(`SELECT * FROM product_workflow_jobs WHERE status IN ('queued', 'running')
        AND next_tick_at <= UTC_TIMESTAMP() AND (lease_until IS NULL OR lease_until < UTC_TIMESTAMP())
        ORDER BY next_tick_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if(!rows[0])return null;
      const claimed={...rows[0],lease_token:randomUUID()};
      await connection.execute("UPDATE product_workflow_jobs SET lease_token = ?, lease_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 90 SECOND), status = 'running' WHERE tenant_id = ? AND run_id = ?",[claimed.lease_token,claimed.tenant_id,claimed.run_id]);
      return claimed;
    });
    if(!job)return;
    let document;
    const commit=async(result=null)=>withMysqlTransaction(async connection=>{
      const [lease]=await connection.execute("SELECT lease_token FROM product_workflow_jobs WHERE tenant_id = ? AND run_id = ? AND lease_until > UTC_TIMESTAMP() FOR UPDATE",[job.tenant_id,job.run_id]);
      if(lease[0]?.lease_token!==job.lease_token)throw Object.assign(new Error('Workflow lease lost'),{code:'WORKFLOW_LEASE_LOST'});
      if(document) {
        const [updated]=await connection.execute("UPDATE product_workflow_documents SET payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND kind = 'run' AND id = ? AND revision = ?",[JSON.stringify(document.payload),job.tenant_id,job.run_id,document.revision]);
        if(!updated.affectedRows)throw new Error('任务版本已变化，等待重新加载');
        document.revision++;
      }
      if(result)await connection.execute("UPDATE product_workflow_jobs SET status = ?, error_message = ?, lease_token = NULL, lease_until = NULL, next_tick_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 SECOND) WHERE tenant_id = ? AND run_id = ?",[result.status,result.error||null,job.tenant_id,job.run_id]);
    });
    try {
      const actor=await restoreBusinessTaskSession(job.tenant_id,job.person_id);assertBusinessTaskPermission(actor,'operations');
      document=await productWorkflowStore.get('run',job.run_id,actor);
      const guard=async()=>{
        const current=await authorizeBusinessTaskSession(actor);assertBusinessTaskPermission(current,'operations');
        const rows=await mysqlQuery("SELECT run_id FROM product_workflow_jobs WHERE tenant_id = ? AND run_id = ? AND lease_token = ? AND lease_until > UTC_TIMESTAMP()",[job.tenant_id,job.run_id,job.lease_token]);
        if(!rows.length)throw Object.assign(new Error('Workflow lease lost'),{code:'WORKFLOW_LEASE_LOST'});
      };
      const result=document.payload.draftId?{status:'imported'}:await advanceProductWorkflow(document,{
        commit,guard,
        findTask:async id=>(await aiGenerationTasks({taskIds:id,includePayload:1},actor))[0],
        createTask:body=>createAiGenerationTasks(body,actor),
        retryTask:id=>retryAiGenerationTask(id,actor)
      });
      const automaticReady=result.status==='ready'&&document.payload.definition.reviewMode==='automatic';
      // Keep automatic imports recoverable if the process stops after the checkpoint.
      await commit(automaticReady?{status:'running'}:result);
      if(automaticReady) {
        try {
          const {mysqlRuntimeServices}=await import('./mysql-runtime-services.js');
          await importProductWorkflowDraft(job.run_id,actor,mysqlRuntimeServices);
          await mysqlExecute("UPDATE product_workflow_jobs SET status = 'imported', error_message = NULL WHERE tenant_id = ? AND run_id = ?",[job.tenant_id,job.run_id]);
        }catch(error){await mysqlExecute("UPDATE product_workflow_jobs SET status = 'failed', error_message = ? WHERE tenant_id = ? AND run_id = ?",[`自动生成草稿失败：${error.message}`,job.tenant_id,job.run_id]);}
      }
    }catch(error){if(error.code!=='WORKFLOW_LEASE_LOST')await commit({status:'failed',error:error.message}).catch(e=>console.error('product workflow checkpoint',e.message));}
  } finally {working=false;}
}

export async function productWorkflowAction(body,session) {
  const {tenant,actor}=await productWorkflowStore.scope(session);
  await ensureProductWorkflowJobs();
  await withMysqlTransaction(async connection=>{
    const [jobs]=await connection.execute("SELECT *, lease_until > UTC_TIMESTAMP() AS busy FROM product_workflow_jobs WHERE tenant_id = ? AND run_id = ? FOR UPDATE",[tenant,body.id]);
    if(Number(jobs[0]?.busy))throw Object.assign(new Error('后台正在更新该任务，请稍后重试'),{status:409});
    const [rows]=await connection.execute("SELECT * FROM product_workflow_documents WHERE tenant_id = ? AND kind = 'run' AND id = ? FOR UPDATE",[tenant,body.id]);
    if(!rows[0])throw Object.assign(new Error('当前企业中没有这个任务'),{status:404});
    const payload=JSON.parse(rows[0].payload_json);
    if(payload.draftId||payload.draftImportStatus==='unknown')throw workflowError('该任务已进入操作箱，请在操作箱编辑或核对导入状态');
    let next='queued';
    if(body.action!=='start'&&body.action!=='approve-all') {
      const variant=payload.variants.find(v=>v.id===body.variantId);
      const node=payload.definition.nodes.find(n=>n.id===body.nodeId&&['image','copy','video','approval'].includes(n.type));
      if(!variant||!node)throw workflowError('变体或生产节点无效');
      const results=payload.outputs[variant.id] ||= {},state=results[node.id];
      if(body.action==='approve') {
        workflowInputContext(payload.definition,variant,node,results);
        if(node.type==='approval') {
          results[node.id]={approved:true};for(const id of node.inputs)results[id].approved=true;
        }else {
          if(!state?.url&&!state?.text)throw workflowError('该节点尚未完成生成');
          state.approved=true;
        }
      }else if(body.action==='save-copy'&&node.type==='copy'&&state?.text) {
        const text=body.text;
        if(!text||typeof text!=='object'||Array.isArray(text)||Object.keys(text).some(key=>!['title','tags','description','text'].includes(key))||('tags'in text&&(!Array.isArray(text.tags)||text.tags.some(x=>typeof x!=='string')))||['title','description','text'].some(key=>key in text&&typeof text[key]!=='string')||JSON.stringify(text).length>40000)throw workflowError('文案格式无效');
        const retained={...state,text,approved:false};invalidateWorkflowResults(payload,variant.id,node.id);results[node.id]=retained;
      }else if(body.action==='retry') {
        if(['running','submitting'].includes(state?.status))throw workflowError('该节点仍在生成，请等待后台更新');
        if(state?.status==='unknown')state.status='resubmit';
        else invalidateWorkflowResults(payload,variant.id,node.id);
      }else throw workflowError('不支持此任务操作');
    }else if(body.action==='approve-all') {
      for(const variant of payload.variants)for(const node of payload.definition.nodes.filter(n=>['image','copy','video'].includes(n.type))) {
        const state=payload.outputs[variant.id]?.[node.id];
        if(!state?.url&&!state?.text)throw workflowError(`${variant.label}的“${node.label}”尚未生成完成`);
        workflowInputContext(payload.definition,variant,node,payload.outputs[variant.id]);state.approved=true;
      }
      buildWorkflowDraft(payload.definition,payload.variants,payload.outputs,{},body.id);
      next='ready';
    }
    payload.executionMode='background';
    await connection.execute("UPDATE product_workflow_documents SET payload_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?",[JSON.stringify(payload),tenant,body.id]);
    await connection.execute(`INSERT INTO product_workflow_jobs (tenant_id, run_id, person_id, status) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE status = VALUES(status), person_id = VALUES(person_id), error_message = NULL, lease_token = NULL, lease_until = NULL, next_tick_at = UTC_TIMESTAMP()`,[tenant,body.id,actor.personId,next]);
  });
  await startProductWorkflowRunner();
  return productWorkflowStore.get('run',body.id,actor);
}

export async function workflowJobStates(session) {
  const {tenant}=await productWorkflowStore.scope(session);await ensureProductWorkflowJobs();
  return mysqlQuery('SELECT run_id, status, error_message FROM product_workflow_jobs WHERE tenant_id = ?',[tenant]);
}
