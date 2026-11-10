import { workflowNodeSkipped, NO_KEY_REFERENCE_RULE } from '../shared/workflow-conditions.js';
import { createHash, randomUUID } from 'node:crypto';
import { workflowInputContext } from '../shared/product-workflow.js';
import { workflowNodeForVariant } from '../shared/product-workflow-inputs.js';

export function workflowGenerationInput(definition,variant,node,results) {
  if(node.type==='video')return {imageUrl:results[node.inputs[0]]?.url,sourceId:`${variant.id}-${node.id}`,title:variant.label,listingVariantMedia:true};
  const context=workflowInputContext(definition,variant,node,results);
  const configured=workflowNodeForVariant(node,variant);
  if(node.type==='copy')return {
    ...(definition.bindings&&node.target!=='bundle'?{workflowOutput:node.target,workflowNodeLabel:node.label,...(configured.copyRules!==undefined?{workflowCopyRules:configured.copyRules}:{})}:{}),
    productName:String(Object.values(context.facts)[0]||variant.label),summary:JSON.stringify(context.facts),
    exactProductIdentity:JSON.stringify(context.facts),rules:[definition.globalPrompt,configured.prompt,definition.bindings?'Use only confirmed facts. Follow configured language and output rules.':'Use only confirmed facts. Output natural Russian.'],
    sourceContext:{workflowFacts:context.facts,workflowFitments:variant.fitments?.length?variant.fitments:variant.values.model?String(variant.values.model).split(/[；;]/).map(model=>({model})):[]}
  };
  const refsByUrl=new Map();
  for(const ref of context.refs){const prior=refsByUrl.get(ref.url);if(prior){prior.label+=` / ${ref.label}`;if(!String(prior.role||'').includes(ref.role||''))prior.role=`${prior.role||''} / ${ref.role||''}`;}else refsByUrl.set(ref.url,{...ref});}
  context.refs=[...refsByUrl.values()];
  if(context.refs.length>8)throw Object.assign(new Error(`${node.label}引用超过 8 张图片，请减少输入或指定本张的参考槽位，避免参考图被截断`),{status:400});
  return {
    sourceImageUrl:context.refs[0]?.url,sourceImageUrls:context.refs.map(r=>r.url),imageCount:1,ratio:node.ratio,autoCrop:false,
    finalPrompt:[definition.globalPrompt,configured.prompt,...(definition.preset==='key-case-production'&&!variant.values.key?.some(Boolean)?[NO_KEY_REFERENCE_RULE]:[]),`CONFIRMED FACTS: ${JSON.stringify(context.facts)}`,
      `REFERENCE ORDER: ${JSON.stringify(context.refs.map((r,i)=>({index:i+1,role:r.role,purpose:r.label})))}`,
      'Product references define true geometry, color and structure. Compatibility references define only the exact key fit. Style references define art direction only. Never copy their product, claims or branding. Keep suite style consistent with the approved main.'
    ].join('\n')
  };
}

function dependenciesReady(definition,variant,node,results) {
  return node.inputs.every(id=>{
    const source=definition.nodes.find(n=>n.id===id),result=results[id];
    if(source.type==='approval')return result?.approved===true;
    if(source.type==='image')return Boolean(result?.url);
    if(source.type==='copy')return Boolean(result?.text);
    return true;
  });
}
function acceptOutput(node,raw) {
  if(node.type==='video'){const url=raw.video?.publishUrl||raw.video?.url||raw.cover?.publishUrl;if(!url)throw new Error(`${node.label}没有返回可用视频`);return {url};}
  if(node.type==='image') {
    const url=raw.generatedImages?.[0]?.url||raw.croppedImages?.[0]?.url||raw.images?.[0]?.url||raw.url;
    if(!url)throw new Error(`${node.label}没有返回可用图片`);
    return {url};
  }
  const text={text:raw.description||raw.text||'',title:raw.title||raw.titles?.[0]||'',tags:raw.tags||[],description:raw.description||''};
  if(node.target&&node.target!=='bundle')return {text:{[node.target]:text[node.target]}};
  return {text:{title:text.title,tags:text.tags,description:text.description}};
}

export function isConfirmedImageTaskFailure(task){return task?.status==='failed'&&['AI_CREDIT_TASK_FAILED','provider_job_terminal_failed'].includes(task.error?.code);}
// One bounded tick, independent of any browser. commit persists submit intent before creating an AI task.
export async function advanceProductWorkflow({id,payload}, {findTask,createTask,retryTask,commit,guard}) {
  const definition=payload.definition;
  let pending=false,review=false;
  for(const variant of payload.variants) {
    const results=payload.outputs[variant.id] ||= {};
    for(const node of definition.nodes.filter(n=>['image','copy','video','approval'].includes(n.type))) {
      const state=results[node.id];
      if(workflowNodeSkipped(node,variant)){results[node.id]={status:'skipped',approved:true,reason:'未提供或未匹配到适配钥匙图'};continue;}
      if(node.type==='approval') {
        if(!state?.approved&&definition.reviewMode==='automatic'&&dependenciesReady(definition,variant,node,results)){results[node.id]={approved:true,approvalMode:'automatic'};for(const input of node.inputs)if(results[input])results[input].approved=true;}
        if(!results[node.id]?.approved)review=true;continue;
      }
      if(state?.url||state?.text) {if(definition.reviewMode==='automatic'){state.approved=true;state.approvalMode='automatic';}else if(!state.approved)review=true;continue;}
      if(node.type==='image'&&node.imageMode==='material'){const ref=node.materialRefs?.[0],url=definition.materialSnapshots?.[ref?.id]?.images?.[ref?.imageIndex||0];if(!url)return {status:'failed',error:`${node.label}没有可用资料图片，请重新选择`};results[node.id]={url,status:'done',approved:definition.reviewMode==='automatic',source:'material'};return {status:'running'};}
      if(!dependenciesReady(definition,variant,node,results)){review=true;continue;}
      if(state?.status==='failed'&&!state.taskId)return {status:'failed',error:`${variant.label} / ${node.label}：${state.error||'生成失败'}`};
      if(state?.taskId) {
        const task=await findTask(state.taskId);
        if(!task) {
          if(state.status==='resubmit') {
            await guard();
            await createTask(taskRequest(id,variant,node,state,definition,results));
            state.status='running';return {status:'running'};
          }
          state.status='unknown';return {status:'awaiting_review',error:`${variant.label} / ${node.label}提交状态待核对，请核对并恢复原任务，不会自动另建付费任务。`};
        }
        if(task.status==='done') {
          try{Object.assign(state,acceptOutput(node,task.output||{}),{status:'done',approved:false,error:null,progressMessage:null,phase:null});}
          catch(error){state.status='unknown';state.error=error.message;return {status:'awaiting_review',error:`已返回的结果待核对：${error.message}`};}
          return {status:'running'};
        }
        if(['failed','cancelled'].includes(task.status)){
          if(node.type==='image'&&!isConfirmedImageTaskFailure(task)){
            if(state.status==='resubmit'){await guard();await retryTask(state.taskId);state.status='running';state.error=null;return {status:'running'};}
            state.status='unknown';state.failureKind='unconfirmed';state.error=`原任务结果待核对：${task.error?.message||'未收到明确生成结果'}；可核对并恢复原任务，不自动新建生图请求。`;return {status:'awaiting_review',error:state.error};
          }
          state.status='failed';if(node.type==='image')state.failureKind='provider_confirmed';state.error=task.error?.message||'生成失败';return {status:'failed',error:`${variant.label} / ${node.label}：${state.error}`};
        }
        state.status='running';state.phase=task.status;state.progressMessage=task.status==='queued'?'排队中，等待可用通道':task.status==='provider_pending'?(task.error?.code==='AI_GENERATION_STORAGE_PENDING'?'图片已生成，等待素材保存恢复；复用原图':'正在查询原任务结果，不重复提交'):'正在生成';
        // The AI worker repolls the original receipt. Do not reset its durable output checkpoint here.
        pending=true;continue;
      }
      const submissionKey=randomUUID();
      const taskId=`wf-${createHash('sha256').update(`${id}:${variant.id}:${node.id}:${submissionKey}`).digest('hex').slice(0,40)}`;
      results[node.id]={taskId,submissionKey,status:'submitting',approved:false};
      await commit();await guard();
      try {await createTask(taskRequest(id,variant,node,results[node.id],definition,results));results[node.id].status='running';}
      catch(error) {
        if(!await findTask(taskId)) {
          results[node.id].status=[400,401,403,422].includes(Number(error.status||error.statusCode))?'failed':'unknown';
          results[node.id].error=error.message;return {status:results[node.id].status==='unknown'?'awaiting_review':'failed',error:`${variant.label} / ${node.label}：${error.message}`};
        }
        results[node.id].status='running';
      }
      return {status:'running'};
    }
  }
  return {status:pending?'running':review?'awaiting_review':'ready',error:null};
}
function taskRequest(id,variant,node,state,definition,results) {
  return {taskId:state.taskId,fieldKey:node.type==='image'?'mainImage':node.type==='video'?'video':'commerceCopy',sourceModule:'product_workflow',workflowId:id,resultId:state.submissionKey,maxAttempts:1,input:workflowGenerationInput(definition,variant,node,results)};
}

export function invalidateWorkflowResults(payload,variantId,nodeId) {
  const ids=new Set([nodeId]);
  for(const node of payload.definition.nodes)if(node.inputs.some(id=>ids.has(id)))ids.add(node.id);
  for(const id of ids)delete payload.outputs[variantId]?.[id];
}
