import {buildWorkflowDraft,validateWorkflow,validateWorkflowVariants} from './product-workflow.js';
import {wbListingSource} from './wb-listing-source.js';
// Frozen, approved generation outputs only; this adapter makes no AI or publishing requests.
export function workflowWbOutput(record) {
 const run=record.payload,definition=validateWorkflow(run.definition);
 validateWorkflowVariants(definition,run.variants);
 const draft=buildWorkflowDraft(definition,run.variants,run.outputs,run.listingSnapshot||{},record.id);
 const source=wbListingSource({...draft,id:null});
 const rows=source.variants||[source];rows.forEach((row,index)=>{row.confirmed_fitments=structuredClone(run.variants[index].fitments||[]);row.workflow_facts=structuredClone(run.variants[index].values||{});});
 source.workflow_run_id=record.id;
 source.workflow_output=definition.wbOutput||{};
 return source;
}
