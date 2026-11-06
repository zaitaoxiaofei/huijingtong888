import { createHash, randomUUID } from 'node:crypto';
import { workflowInputContext } from '../shared/product-workflow.js';
import { workflowNodeForVariant } from '../shared/product-workflow-inputs.js';

export function workflowGenerationInput(definition,variant,node,results) {
  const context=workflowInputContext(definition,variant,node,results);
  const configured=workflowNodeForVariant(node,variant);
  if(node.type==='copy')return {
    productName:String(Object.values(context.facts)[0]||variant.label),summary:JSON.stringify(context.facts),
    exactProductIdentity:JSON.stringify(context.facts),rules:[definition.globalPrompt,configured.prompt,'Use only confirmed facts. Output natural Russian.'],
    sourceContext:{workflowFacts:context.facts}
  };
  return {
    sourceImageUrl:context.refs[0]?.url,sourceImageUrls:context.refs.map(r=>r.url),imageCount:1,ratio:node.ratio,autoCrop:false,
    finalPrompt:[definition.globalPrompt,configured.prompt,`CONFIRMED FACTS: ${JSON.stringify(context.facts)}`,
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
  if(node.type==='image') {
    const url=raw.generatedImages?.[0]?.url||raw.croppedImages?.[0]?.url||raw.images?.[0]?.url||raw.url;
    if(!url)throw new Error(`${node.label}没有返回可用图片`);
    return {url};
  }
  const text={title:raw.title||raw.titles?.[0]||'',tags:raw.tags||[],description:raw.description||''};
  if(node.target&&node.target!=='bundle')return {text:{[node.target]:text[node.target]}};
  return {text};
}

// One bounded tick, independent of any browser. commit persists submit intent before creating an AI task.
export async function advanceProductWorkflow({id,payload}, {findTask,createTask,retryTask,commit,guard}) {
  const definition=payload.definition;
  let pending=false,review=false;
  for(const variant of payload.variants) {
    const results=payload.outputs[variant.id] ||= {};
    for(const node of definition.nodes.filter(n=>['image','copy','approval'].includes(n.type))) {
      const state=results[node.id];
      if(node.type==='approval') {if(!state?.approved)review=true;continue;}
      if(state?.url||state?.text) {if(!state.approved)review=true;continue;}
      if(!dependenciesReady(definition,variant,node,results)){review=true;continue;}
      if(state?.status==='failed')return {status:'failed',error:`${variant.label} / ${node.label}：${state.error||'生成失败'}`};
      if(state?.taskId) {
        const task=await findTask(state.taskId);
        if(!task) {
          if(state.status==='resubmit') {
            await guard();
            await createTask(taskRequest(id,variant,node,state,definition,results));
            state.status='running';return {status:'running'};
          }
          state.status='unknown';return {status:'failed',error:`${variant.label} / ${node.label}提交待核对。重试会使用原任务标识，不会另建付费任务。`};
        }
        if(task.status==='done') {
          try{Object.assign(state,acceptOutput(node,task.output||{}),{status:'done',approved:false,error:null});}
          catch(error){state.status='failed';state.error=error.message;return {status:'failed',error:error.message};}
          return {status:'running'};
        }
        if(['failed','cancelled'].includes(task.status)){state.status='failed';state.error=task.error?.message||'生成失败';return {status:'failed',error:`${variant.label} / ${node.label}：${state.error}`};}
        if(task.status==='provider_pending'){await guard();await retryTask(state.taskId);}
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
          results[node.id].error=error.message;return {status:'failed',error:`${variant.label} / ${node.label}：${error.message}`};
        }
        results[node.id].status='running';
      }
      return {status:'running'};
    }
  }
  return {status:pending?'running':review?'awaiting_review':'ready',error:null};
}
function taskRequest(id,variant,node,state,definition,results) {
  return {taskId:state.taskId,fieldKey:node.type==='image'?'mainImage':'commerceCopy',sourceModule:'product_workflow',workflowId:id,resultId:state.submissionKey,maxAttempts:1,input:workflowGenerationInput(definition,variant,node,results)};
}

export function invalidateWorkflowResults(payload,variantId,nodeId) {
  const ids=new Set([nodeId]);
  for(const node of payload.definition.nodes)if(node.inputs.some(id=>ids.has(id)))ids.add(node.id);
  for(const id of ids)delete payload.outputs[variantId]?.[id];
}
