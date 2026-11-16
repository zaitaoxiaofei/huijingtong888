export function allocateBillingAiCost({policy,usage,from,to,companyId=0,shopId='all'}){
 if(!policy)return {ai_cost_applied:false,ai_usage_cost:0};
 const common={ai_cost_company_id:Number(policy.company_id),ai_cost_revision:Number(policy.revision),ai_cost_estimated:true};
 if(Number(shopId)>0||(Number(companyId)>0&&Number(companyId)!==Number(policy.company_id))||to.slice(0,7)<policy.effective_month)return {...common,ai_cost_applied:false,ai_usage_cost:0};
 if(usage?.available===false||!usage?.months)return {...common,ai_cost_applied:true,ai_usage_cost:null};
 let cents=0;const fallback=[];
 for(let month=from.slice(0,7);month<=to.slice(0,7);){const row=usage.months[month]||{cost:0,request_count:0};if(month>=policy.effective_month){let amount=Number(row.cost||0);if(Number(row.request_count)===0&&policy.fallback_from&&month>=policy.fallback_from&&month<=policy.fallback_to){const days=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate(),start=month===from.slice(0,7)?Number(from.slice(8)):1,end=month===to.slice(0,7)?Number(to.slice(8)):days;amount=Number(policy.fallback_amount)*(end-start+1)/days;fallback.push(month);}cents+=Math.round(amount*100);}
 const y=Number(month.slice(0,4)),m=Number(month.slice(5));month=m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;}
 return {...common,ai_cost_applied:true,ai_usage_cost:cents/100,ai_cost_fallback_months:fallback};
}
