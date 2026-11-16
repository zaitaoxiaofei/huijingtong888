export {allocateBillingAiCost} from '../shared/finance-ai-cost.js';
import{mysqlQuery,mysqlExecute,withMysqlTransaction}from'../mysql-pool.js';
import{submissionActor}from'./finance-submissions.js';
export const FINANCE_AI_COST_SCHEMA = `CREATE TABLE IF NOT EXISTS finance_ai_cost_policies (
 tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,effective_month CHAR(7) NOT NULL,
 fallback_from CHAR(7) NULL,fallback_to CHAR(7) NULL,fallback_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
 revision INT NOT NULL DEFAULT 1,updated_by BIGINT UNSIGNED NOT NULL,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS finance_ai_cost_policy_history (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,tenant_id BIGINT UNSIGNED NOT NULL,before_json MEDIUMTEXT NULL,after_json MEDIUMTEXT NOT NULL,
 reason VARCHAR(500) NOT NULL,recorded_by BIGINT UNSIGNED NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_ai_policy_tenant(tenant_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`;
const fail=(m,s=400)=>{throw Object.assign(new Error(m),{statusCode:s});};
const validMonth=v=>/^20\d{2}-(0[1-9]|1[0-2])$/.test(v||'');
export function createFinanceAiCostPolicy({query=mysqlQuery,execute=mysqlExecute,transaction=withMysqlTransaction}={}){
 let schema;const ready=()=>schema||=(async()=>{for(const ddl of FINANCE_AI_COST_SCHEMA.split(';').filter(s=>s.trim()))await execute(ddl);})().catch(e=>{schema=null;throw e;});
 async function readForScope(scope){await ready();const [row]=await query('SELECT * FROM finance_ai_cost_policies WHERE tenant_id=?',[Number(scope.id)]);return row||null;}
 return {readForScope,
 async get(session){const actor=submissionActor(session,true);return {policy:await readForScope({id:actor.tenantId})};},
 async save(body,session){const actor=submissionActor(session,true),companyId=Number(body.company_id),reason=String(body.reason||'').trim();if(!Number.isSafeInteger(companyId)||companyId<=0||!validMonth(body.effective_month)||reason.length<4||reason.length>500||!Number.isInteger(body.expected_revision))fail('请提供公司、起始月份、当前版本及至少4字调整原因');
 const fallback=Number(body.fallback_amount||0);if(!Number.isFinite(fallback)||fallback<0||fallback>1000000||fallback&&(!validMonth(body.fallback_from)||!validMonth(body.fallback_to)||body.fallback_from>body.fallback_to))fail('历史图片估算月份或金额无效');await ready();
 return transaction(async c=>{const run=async(sql,p=[])=>(await c.execute(sql,p))[0];const [company]=await run(`SELECT id FROM finance_companies WHERE id=? AND status='active' AND (tenant_id=?${actor.legacy?' OR tenant_id IS NULL OR tenant_id=0':''}) FOR UPDATE`,[companyId,actor.tenantId]);if(!company)fail('归属公司不存在或不属于当前企业',404);
 const [before]=await run('SELECT * FROM finance_ai_cost_policies WHERE tenant_id=? FOR UPDATE',[actor.tenantId]);if(Number(before?.revision||0)!==body.expected_revision)fail('AI归属设置已变化，请刷新后重试',409);
 const after={tenant_id:actor.tenantId,company_id:companyId,effective_month:body.effective_month,fallback_from:fallback?body.fallback_from:null,fallback_to:fallback?body.fallback_to:null,fallback_amount:fallback,revision:Number(before?.revision||0)+1,updated_by:actor.personId};
 await run('INSERT INTO finance_ai_cost_policies (tenant_id,company_id,effective_month,fallback_from,fallback_to,fallback_amount,revision,updated_by) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE company_id=VALUES(company_id),effective_month=VALUES(effective_month),fallback_from=VALUES(fallback_from),fallback_to=VALUES(fallback_to),fallback_amount=VALUES(fallback_amount),revision=VALUES(revision),updated_by=VALUES(updated_by),updated_at=UTC_TIMESTAMP()',Object.values(after));
 await run('INSERT INTO finance_ai_cost_policy_history (tenant_id,before_json,after_json,reason,recorded_by) VALUES(?,?,?,?,?)',[actor.tenantId,before?JSON.stringify(before):null,JSON.stringify(after),reason,actor.personId]);return {ok:true,policy:after};});}
 };
}
export const financeAiCostPolicy=createFinanceAiCostPolicy();
