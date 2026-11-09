import { WORKFLOW_COPY_RULES, validateWorkflowCopy } from '../shared/workflow-copy-rules.js';
import { chatWithAiProvider } from './ai-provider-settings.js';

// Uses the existing tenant-aware provider and credit/task context.
export async function generateProductWorkflowText(input,chat=chatWithAiProvider) {
  const target=input.workflowOutput;
  if(!['text','title','tags','description'].includes(target))throw new Error('文本节点输出格式无效');
  let feedback='';
  for(let attempt=0;attempt<2;attempt++){
  const response=await chat({temperature:0.2,maxTokens:2200,timeoutMs:60000,messages:[
    {role:'system',content:'按用户定义的节点规则，基于已确认事实生成所需文本。不能编造商品事实。只返回 JSON 对象，键为 value。文本值使用字符串，标签列表使用字符串数组。'},
    {role:'user',content:JSON.stringify({node:input.workflowNodeLabel,outputType:target,rules:[input.workflowCopyRules??WORKFLOW_COPY_RULES[target]??'',...(input.rules||[]),feedback],confirmedFitments:input.sourceContext?.workflowFitments||[],confirmedFacts:input.sourceContext?.workflowFacts||{}})}
  ]});
  let value;
  try{value=JSON.parse(String(response.content).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')).value;}
  catch{throw new Error('文本节点未返回有效 JSON，请重试');}
  if(target==='tags') {
    if(!Array.isArray(value)||!value.length||value.some(v=>typeof v!=='string'||!v.trim()))throw new Error('标签节点未返回有效文本列表，请重试');
    try{return {tags:validateWorkflowCopy(target,value),provider:response.provider,model:response.model};}catch(error){if(attempt)throw error;feedback=error.message;continue;}
  }
  if(typeof value!=='string'||!value.trim())throw new Error('文本节点没有返回内容，请重试');
  try{return {[target]:validateWorkflowCopy(target,value,input.sourceContext?.workflowFitments||[]),provider:response.provider,model:response.model};}catch(error){if(attempt)throw error;feedback=error.message;}
  }
}
