import { productWorkflowStore, importProductWorkflowDraft } from "../../services/product-workflows.js";
import { enqueueProductWorkflow, productWorkflowAction, workflowJobStates } from '../../services/product-workflow-runner.js';
import { productWorkflowCategory, prepareProductWorkflowRun } from '../../services/product-workflow-category.js';

export function createProductWorkflowRoutes({readJson,services}) {
  const routes={};
  for(const [collection,kind] of [["templates","template"],["runs","run"]]) {
    routes[`GET /api/product-workflows/${collection}`]=req=>req.query?.id
      ?productWorkflowStore.get(kind,String(req.query.id),req._session):productWorkflowStore.list(kind,req._session);
    routes[`POST /api/product-workflows/${collection}`]=async req=>productWorkflowStore.save(kind,await readJson(req),req._session);
  }
  routes['GET /api/product-workflows/category']=req=>productWorkflowCategory(req.query?.id,req._session,services);
  routes['GET /api/product-workflows/job-states']=req=>workflowJobStates(req._session);
  routes['POST /api/product-workflows/run-action']=async req=>productWorkflowAction(await readJson(req),req._session);
  routes['POST /api/product-workflows/runs']=async req=>{
    const body=await readJson(req);
    if(body.id)return productWorkflowStore.save('run',body,req._session);
    const payload=await prepareProductWorkflowRun(body.payload,req._session,services);
    const saved=await productWorkflowStore.save('run',{payload},req._session);
    await enqueueProductWorkflow(saved.id,req._session);
    return saved;
  };
  routes["POST /api/product-workflows/import-draft"]=async req=>importProductWorkflowDraft(String((await readJson(req)).id||""),req._session,services);
  return routes;
}
