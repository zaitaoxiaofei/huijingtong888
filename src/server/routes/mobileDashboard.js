import {authorizeBusinessTaskSession} from '../../services/business-task-tenant.js';
import {hasPermission} from '../../shared/permissions.js';
import {mobileDashboard} from '../../shared/mobile-dashboard.js';
export function createMobileDashboardHandler({dashboard,finance,authorize=authorizeBusinessTaskSession}){
 return async req=>{
  const current=await authorize(req._session);
  if(req.query?.view==='mobile-finance'){
   if(!hasPermission(current,'finance'))throw Object.assign(new Error('当前岗位无权查看财务指标'),{statusCode:403});
   return finance(req.query||{},current.tenant.id);
  }
  if(req.query?.view!=='mobile')throw Object.assign(new Error('手机指标视图无效'),{statusCode:400});
  return mobileDashboard(await dashboard(req.query||{},current.tenant.id),current);
 };
}
