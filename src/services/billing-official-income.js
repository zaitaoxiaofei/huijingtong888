import {OFFICIAL_INCOME_POLICY,readApprovedH1,approvedH1Report} from './billing-approved-h1.js';

// Explicitly approved, append-only CNY projections. Original profit formula and
// frozen FX records stay untouched; this is not a profit recalculation writer.
export async function readOfficialIncome(query,{tenantId,companyId,from,to,shopId}){
 if(Number(tenantId)!==1||(companyId&&Number(companyId)!==1))return [];
 const params=[tenantId,from,to,OFFICIAL_INCOME_POLICY];if(Number(shopId)>0)params.push(Number(shopId));
 const rows=await query(`SELECT j.*,DATE_FORMAT(CONVERT_TZ(j.created_at,'+00:00','+08:00'),'%Y-%m-%dT%H:%i:%s+08:00') created_at
  FROM finance_reconciliation_adjustments j JOIN shops s ON s.id=j.shop_id AND (s.tenant_id=j.tenant_id OR s.tenant_id IS NULL)
  WHERE j.tenant_id=? AND j.company_id=1 AND j.month_key>=? AND j.month_key<=?
  AND JSON_UNQUOTE(JSON_EXTRACT(j.after_json,'$.policy'))=? AND j.shop_id IN (4,5,6)
  ${Number(shopId)>0?'AND j.shop_id=?':''}
  AND EXISTS(SELECT 1 FROM finance_shop_company_assignments a WHERE a.company_id=j.company_id AND a.shop_id=j.shop_id AND (a.tenant_id=j.tenant_id OR a.tenant_id IS NULL) AND a.effective_from<=LAST_DAY(CONCAT(j.month_key,'-01')) AND (a.effective_to IS NULL OR a.effective_to>=CONCAT(j.month_key,'-01'))) ORDER BY j.id`,params);
 const json=v=>typeof v==='string'?JSON.parse(v):v;
 const ids=[...new Set(rows.flatMap(r=>json(r.sources_json).map(s=>Number(s.document_id))))];if(!ids.length)return [];
 const docs=await query(`SELECT id,shop_key,sha256,original_name,attachment_url FROM finance_import_documents WHERE tenant_id=? AND company_id=1 AND id IN (${ids.map(()=>'?').join(',')})`,[tenantId,...ids]);
 const indexed=new Map(docs.map(d=>[Number(d.id),d]));
 return rows.map(r=>({...r,source_valid:json(r.sources_json).length>0&&json(r.sources_json).every(s=>{const d=indexed.get(Number(s.document_id));return d&&Number(d.shop_key)===Number(r.shop_id)&&d.sha256===s.sha256;}),sources_json:JSON.stringify(json(r.sources_json).map(s=>{const d=indexed.get(Number(s.document_id));return d&&Number(d.shop_key)===Number(r.shop_id)?{...s,original_name:d.original_name,attachment_url:d.attachment_url}:{document_id:s.document_id,sha256:s.sha256,unavailable:true};}))}));
}
export async function readAllApprovedIncome(query,scope){return [...await readApprovedH1(query,scope),...await readOfficialIncome(query,scope)].sort((a,b)=>Number(a.id)-Number(b.id));}
export function approvedIncomeReport(query,scope,input={}){return approvedH1Report(query,scope,input,readAllApprovedIncome);}
