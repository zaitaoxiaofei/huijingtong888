// Labels follow the Seller document folders used by the archive transport.
export const OZON_DOCUMENT_FOLDERS=[
 {id:'updWithAdditionalServices',name:'含附加服务的通用传输文件',sections:[]},
 {id:'realizationReports',name:'销售报告',sections:['结算单据','参考信息']},
 {id:'b2bSales',name:'向法人销售',sections:['销售登记册','用于提交联邦税务局的文件']},
 {id:'agentReports',name:'合作伙伴报告',sections:['报告','发票']},
 {id:'analyticalReports',name:'分析报告',sections:[]},
 {id:'compensationsAndOtherCharges',name:'赔偿及其它应计项目',sections:[]},
 {id:'securityPayments',name:'保证金与罚款',sections:[]},
 {id:'invoices',name:'扣款与待付账单',sections:['扣款','付款账单']},
 {id:'reconciliationActs',name:'对账单',sections:['平台出具','已申请']},
 {id:'actsFBS',name:'FBS发运',sections:[]}
];
export const ozonDocumentPath=(folder,section='')=>['Ozon Seller','财务','文件',folder,section].filter(Boolean).join(' > ');
export function normalizeFinanceSourceLocation(input){
 if(input==null||input==='')return null;
 const folder=OZON_DOCUMENT_FOLDERS.find(f=>f.id===input.folder_id),section=input.section||'';
 if(input.platform!=='ozon'||!folder||typeof section!=='string'||section&&!folder.sections.includes(section))throw Object.assign(new Error('请选择有效的 Ozon 下载目录和子目录（source_location），在上传用途下方重新选择'),{statusCode:400});
 return {platform:'ozon',folder_id:folder.id,folder_name:folder.name,section,recorded_by:'manual'};
}
const readPayload=doc=>{try{return typeof doc.payload_json==='string'?JSON.parse(doc.payload_json):doc.payload_json||{};}catch{return {};}};
export function financeDocumentLocation(doc={}){
 if(doc.source_type==='payroll')return {path:'ERP > 财务中心 > 工资管理',recorded:true,method:'系统工资记录'};
 const p=readPayload(doc),source=p.archive_source||p.source_location;
 if(source?.folder_name){return {path:ozonDocumentPath(source.folder_name,source.section),recorded:true,method:p.archive_source?'插件记录':'上传时填写',folder_id:source.folder_id,document_id:source.document_id||''};}
 return {path:'未记录下载目录',recorded:false,method:''};
}
const categories={sales:['realizationReports'],platform:['updWithAdditionalServices','agentReports'],advertising:['updWithAdditionalServices','agentReports'],international:['agentReports'], 'last-mile':['agentReports'],acquiring:['agentReports'],adjustments:['compensationsAndOtherCharges','securityPayments'],cash:['invoices','reconciliationActs'],analysis:['analyticalReports'],other:['updWithAdditionalServices','agentReports']};
export function financeCategoryDownloadPaths(id){return (categories[id]||[]).flatMap(id=>{const f=OZON_DOCUMENT_FOLDERS.find(f=>f.id===id);return (f.sections.length?f.sections:['']).map(section=>ozonDocumentPath(f.name,section));});}
export function financeUploadDownloadPaths(type){
 if(type==='auto')return ['Ozon Seller > 财务 > 文件（选择具体报告用途，查看对应文件夹）'];
 if(type==='order-sales')return ['Ozon 官方逐单销售接口 /v1/finance/realization/posting（不属于“文件”目录）'];
 if(type==='collection-cash')return ['连连支付 > 交易明细 > 入账 / 提现'];
 if(type==='payroll')return ['ERP > 财务中心 > 工资管理；工资及社保付款回单由公司提供'];
 if(type==='manual-expense')return ['由供应商、银行或服务商提供账单、发票及付款依据'];
 const ids={sales:['sales'], 'platform-fees':['platform','advertising','international'],compensation:['adjustments'],settlement:['cash'],support:['other'],auto:['sales','platform','adjustments','cash']}[type]||[];
 return [...new Set(ids.flatMap(financeCategoryDownloadPaths))];
}
