import { BETA_PLAN_PRICES_FEN, publicPlanDetails } from '../shared/subscription-plan-features.js';
export { renderPublicWebsite } from './public-website-renderer.js';
export const publicSelfServiceEnabled=(env=process.env)=>env.SELF_SERVICE_PUBLIC_ENABLED==='1';
export function isPublicEntry(req,url) {
  if(!publicSelfServiceEnabled())return false;
  if(['GET','HEAD'].includes(req.method)&&['/admin.html','/admin','/admin/','/mobile-icon.svg','/favicon.ico','/favicon.svg','/release.json','/website/erp-dashboard-demo.png'].includes(url.pathname))return true;
  return (req.method==='POST'&&['/api/auth/login','/api/auth/register'].includes(url.pathname))||(req.method==='GET'&&['/api/auth/me','/api/auth/entry-options'].includes(url.pathname));
}
export function publicWebsitePath(path){return ['/','/pricing','/docs','/register','/login'].includes(path);}
export async function loadPublicPlans(query){return (await query('SELECT code,name,duration_days,subscription_status,account_limit,shop_limit FROM tenant_plans WHERE active=1 ORDER BY duration_days,id')).filter(p=>Object.hasOwn(BETA_PLAN_PRICES_FEN,p.code)).map(publicPlanDetails);}
