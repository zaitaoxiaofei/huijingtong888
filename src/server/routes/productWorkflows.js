import { productWorkflowStore, importProductWorkflowDraft } from "../../services/product-workflows.js";
import { enqueueProductWorkflow, productWorkflowAction, workflowJobStates } from '../../services/product-workflow-runner.js';
import { productWorkflowCategory, prepareProductWorkflowRun } from '../../services/product-workflow-category.js';

export function createProductWorkflowRoutes({readJson,services,store=productWorkflowStore,enqueue=enqueueProductWorkflow}) {
  const routes={};
  for(const [collection,kind] of [["templates","template"],["runs","run"]]) {
    routes[`GET /api/product-workflows/${collection}`]=req=>req.query?.id
      ?store.get(kind,String(req.query.id),req._session):store.list(kind,req._session,req.query||{});
    routes[`POST /api/product-workflows/${collection}`]=async req=>store.save(kind,await readJson(req),req._session);
  }
  routes['GET /api/product-workflows/key-models']=req=>req.query?.id?store.get('key_model',String(req.query.id),req._session):store.list('key_model',req._session,req.query||{});
  routes['POST /api/product-workflows/key-models']=async req=>store.save('key_model',await readJson(req),req._session);
  routes['GET /api/product-workflows/facts-history']=req=>store.factsHistory(req._session);
  routes['GET /api/product-workflows/key-model-matches']=req=>{let fitments;try{fitments=JSON.parse(req.query?.fitments||'[]');}catch{throw Object.assign(new Error('品牌型号筛选格式无效'),{status:400});}if(!Array.isArray(fitments)||fitments.length>100)throw Object.assign(new Error('最多选择100个适配型号'),{status:400});return store.matchingKeys(fitments,{key:String(req.query?.category||'')},req._session,{includePending:req.query?.includePending==='1'});};
  routes['GET /api/product-workflows/mold-mappings']=req=>store.list('mapping',req._session,req.query||{});
  routes['POST /api/product-workflows/mold-mappings']=async req=>store.importMappings((await readJson(req)).records,req._session);
  routes['GET /api/product-workflows/material-library']=req=>store.list('library',req._session,req.query||{});
  routes['GET /api/product-workflows/materials']=req=>req.query?.id?store.get('material',String(req.query.id),req._session):store.list('material',req._session,req.query||{});
  routes['POST /api/product-workflows/materials']=async req=>store.save('material',await readJson(req),req._session);
  routes['GET /api/product-workflows/category']=req=>productWorkflowCategory(req.query?.id,req._session,services);
  routes['GET /api/product-workflows/job-states']=req=>workflowJobStates(req._session);
  routes['POST /api/product-workflows/run-action']=async req=>productWorkflowAction(await readJson(req),req._session);
  routes['POST /api/product-workflows/runs']=async req=>{
    const body=await readJson(req);
    if(body.id)return store.save('run',body,req._session);
    if(body.requestId){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))throw Object.assign(new Error('生产提交标识无效，请重新打开生产窗口'),{status:400});
      try{const existing=await store.get('run',body.requestId,req._session);await enqueue(existing.id,req._session);return existing;}
      catch(error){if(error.status!==404)throw error;}
    }
    const payload=await prepareProductWorkflowRun(body.payload,req._session,services,store);
    const saved=await store.save('run',{payload,creationId:body.requestId},req._session);
    await enqueue(saved.id,req._session);
    return saved;
  };
  routes["POST /api/product-workflows/import-draft"]=async req=>importProductWorkflowDraft(String((await readJson(req)).id||""),req._session,services);
  return routes;
}
