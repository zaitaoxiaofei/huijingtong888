import crypto from 'node:crypto';
import { financeXlsxRows } from './finance-xlsx-reader.js';

export const PARSER_VERSION = 'ozon-monthly-1';
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export const rounded = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
function amount(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) fail(`金额无法识别：${String(value).slice(0,40)}`);
  return Number(s);
}
function cell(value) {
  if (value instanceof Date) return value.toISOString().slice(0,10);
  if (value?.formula || value?.sharedFormula) { if (value.result == null) fail('表格公式缺少已保存的计算结果，请重新计算后保存'); return value.result; }
  if (value?.richText) return value.richText.map(x => x.text).join('');
  return value ?? '';
}
export function validateMonth(value) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(value))) fail('请选择有效业务月份（month，YYYY-MM），用于核对文件正文期间');
  return value;
}
function zipBounds(buffer) {
  let end=-1; for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--) if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0) fail('Excel压缩结构无效，请上传原始xlsx文件');
  const count=buffer.readUInt16LE(end+10);let at=buffer.readUInt32LE(end+16),expanded=0;
  if(count>4000) fail('Excel内容过多，请拆分上传');
  for(let i=0;i<count;i++){
    if(at+46>buffer.length||buffer.readUInt32LE(at)!==0x02014b50)fail('Excel压缩目录无效');
    expanded+=buffer.readUInt32LE(at+24);if(expanded>100*1024*1024)fail('Excel解压后超过100MB，请拆分上传');
    at+=46+buffer.readUInt16LE(at+28)+buffer.readUInt16LE(at+30)+buffer.readUInt16LE(at+32);
  }
}
async function extract(buffer,name) {
  if (/\.xlsx$/i.test(name)) {
    zipBounds(buffer); const rows=await financeXlsxRows(buffer);
    return {rows,text:rows.slice(0,45).map(r=>(r||[]).join(' ')).join('\n')};
  }
  if (/\.(png|jpe?g|webp)$/i.test(name)) return {text:'',rows:[],scanned:true};
  if (/\.pdf$/i.test(name)) {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false,disableFontFace:true});
    const pdf=await task.promise;let text='';
    try{
      if(pdf.numPages>100)fail('PDF超过100页，请拆分上传');
      for(let n=1;n<=pdf.numPages;n++){
        const page=await pdf.getPage(n),content=await page.getTextContent();
        // Keep PDF text runs in document reading order, retaining line breaks.
        text+=content.items.map(i=>i.str+(i.hasEOL?'\n':' ')).join('')+'\n';
        if(text.length>3000000)fail('PDF文字过多，请拆分上传');
      }
    }finally{await pdf.destroy();}
    if(!text.trim())return {text:'',rows:[],scanned:true};
    return {text,rows:[]};
  }
  fail('解析仅支持平台原始PDF和XLSX；截图请作为补充凭证归档');
}
function documentMonth(text) {
  let m=text.match(/(?:Services from|period from)\s*(\d{2})\.(\d{2})\.(20\d{2})\s*to\s*(\d{2})\.(\d{2})\.(20\d{2})/i);
  if(m)return {from:`${m[3]}-${m[2]}`,to:`${m[6]}-${m[5]}`};
  m=text.match(/(?:period from|period between)\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})\s*(?:to|and)\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})/i);
  if(m)return {from:`${m[3]}-${m[1].padStart(2,'0')}`,to:`${m[6]}-${m[4].padStart(2,'0')}`};
  m=text.match(/(?:Invoice\s*[№#]|Compensation report\s*[№#]|СЧЕТ-ФАКТУРА)[\s\S]{0,100}?(?:from|от)\s*(\d{2})\.(\d{2})\.(20\d{2})/i);
  if(m)return {from:`${m[3]}-${m[2]}`,to:`${m[3]}-${m[2]}`};
  return null;
}
export async function parseFinanceDocument(buffer,name,{month}={}) {
  validateMonth(month);
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024)fail('文件为空或超过20MB，请检查上传原件');
  const {text:original,rows,scanned}=await extract(buffer,name);const text=original.replace(/\u00a0/g,' '),flat=text.replace(/\s+/g,' ');
  const result={version:PARSER_VERSION,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),kind:'support',month,period:documentMonth(flat),currency:null,document_number:null,facts:[],cash:[],warnings:[],controls:[],buyer_tax_number:null};
  result.buyer_tax_number=flat.match(/\b(9[0-9A-Z]{17})\b/)?.[1]||null;
  const add=(metric,value,currency='CNY',source='')=>result.facts.push({metric,amount:rounded(amount(value)),currency,source});
  if(scanned){result.warnings.push('图片或扫描件仅归档，不自动识别金额；需平台电子原件或人工复核');return result;}
  if(rows.length&&rows.some(r=>r?.includes('Payment type')&&r?.includes('Date of payment transfer'))){
    result.kind='platform-payments';const header=rows.findIndex(r=>r?.includes('Payment type'));
    for(let i=header+1;i<rows.length;i++){const r=rows[i];if(r?.[3]!=='Paid')continue;const m=String(r[5]).match(/^(\d{2})\.(\d{2})\.(20\d{2})$/);if(!m)fail('平台付款日期格式变化，请核实付款报告');result.cash.push({type:'platform-payment',date:`${m[3]}-${m[2]}-${m[1]}`,currency:'CNY',amount:rounded(amount(r[2])),reference:String(r[7]||''),source:`第${i}行`});}
  }else if(/连连跨境支付(?:入账|提现)记录查询/.test(flat)&&rows.length){
    result.kind='collection-cash';
    const isEntry=flat.includes('入账记录查询');
    const header=rows.findIndex(r=>r?.includes(isEntry?'创建日期':'批次单号'));if(header<0)fail('连连表格缺少交易明细表头');
    const h=rows[header];const get=(r,label)=>r[h.indexOf(label)];
    for(let i=header+1;i<rows.length;i++){
      const r=rows[i];if(!r)continue;const date=String(get(r,isEntry?'创建日期':'交易日期')||'');if(!/^20\d{2}-\d{2}-\d{2}/.test(date))continue;
      if(isEntry&&get(r,'状态')!=='成功')continue;
      result.cash.push({type:isEntry?'entry':'withdrawal',date,currency:get(r,isEntry?'币种':'提现币种'),amount:rounded(amount(get(r,isEntry?'金额':'提现金额'))),reference:String(get(r,isEntry?'交易单号':'批次单号')),fee:isEntry?null:rounded(amount(get(r,'实收基础服务费'))+amount(get(r,'提前宝服务费'))+amount(get(r,'小额服务费'))),listed_bank_currency:isEntry?null:get(r,'到账币种'),listed_bank_amount:isEntry?null:rounded(amount(get(r,'到账金额'))),source:`第${i}行`});
    }
    result.warnings.push('公司共用收款流水；按交易日期筛选，不自动认作店铺收入或银行实际到账，提现费用保留原币');
  }else if(/Sales Report\s*[№#]/i.test(flat)&&rows.length){
    result.kind='sales'; result.document_number=flat.match(/Sales Report\s*[№#]\s*(\d+)/i)?.[1];
    if(!flat.includes('Sold for the amount, CNY')||!flat.includes('Returned for the amount, CNY'))fail('销售报告列结构变化，需核实币种及销售/退货列');
    let sold=0,returns=0,partners=0;for(const [i,r]of rows.entries())if(i>=16&&/^\d+$/.test(String(r?.[1]??''))){sold+=amount(r[6]);returns+=amount(r[10]);partners+=amount(r[7])-amount(r[11]);}
    add('已确认商品销售额',sold,'CNY','商品行F列');add('销售退回冲减额',returns,'CNY','商品行J列');add('合作伙伴补贴收入',partners,'CNY','商品行G减K列');
    const total=rows.find(r=>String(r?.[2]||'').includes('Total sales (net of refunds)'));
    if(!total||Math.abs(rounded(sold-returns)-amount(total[3]))>0.01)fail('销售报告明细与净销售总额不一致，停止入账');
  }else if(/Statement of services provided No\./i.test(flat)&&/Star Products/i.test(flat)&&rows.length){
    result.kind='star-service';result.document_number=flat.match(/No\.\s*(ЗВ\s*-\s*\d+)/i)?.[1]?.replace(/\s/g,'');
    if(!flat.includes('Amount including VAT (CNY)'))fail('推广服务书币种变化，停止入账');
    const total=rows.find(r=>String(r?.[2]||'').trim()==='Total:');if(!total)fail('推广服务书缺少Total合计');
    add('星级商品推广费',total[6],'CNY','Total行F列');
  }else if(/Unified Transfer\s*Document/i.test(flat)&&/Invoice\s*[№#]/i.test(flat)){
    result.kind='platform-invoice';result.document_number=flat.match(/Invoice\s*[№#]\s*(\d+)/i)?.[1];
    if(!/Currency:.*?CNY,?\s*156/.test(flat))fail('平台综合发票不是CNY，不能直接记为人民币费用');
    const segment=flat.slice(flat.indexOf('1 Agency fee'),flat.indexOf('In total for payment'));
    const parts=segment.split(/(?=\b[1-5] (?:Agency fee|Cost Per Click|Electronic service|Ozon agency fee|Services for))/).filter(p=>/pcs/.test(p));
    for(const [i,p]of parts.entries()){
      const nums=p.match(/\d[\d,]*\.\d{2}/g);if(!nums)fail('综合发票项目金额无法识别');
      const metric=p.includes('Cost Per Click')?'点击广告费':p.includes('Electronic service')?'平台物流连接服务费':p.includes('Ozon agency fee')?'佣金':p.includes('administration and management')?'国际货代合同管理服务费':'国际运输合同缔约服务费';
      add(metric,Number(nums.at(-1).replaceAll(',','')),'CNY',`发票项目${i+1}：${p.split('pcs')[0].trim().slice(0,180)}`);
    }
    const tail=flat.slice(flat.indexOf('In total for payment'));const total=tail.match(/In total for payment\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/);
    if(!total||parts.length!==5||Math.abs(rounded(result.facts.reduce((s,r)=>s+r.amount,0))-Number(total[3].replaceAll(',','')))>0.01)fail('综合发票明细与总额不符，停止入账');
    result.controls.push({name:'费用明细与发票合计',difference:0,currency:'CNY'});
    result.warnings.push('买方税号及电子签署情况需会计核对；不能因识别为发票就自动确认税前扣除');
  }else if(/Report on the re-provision of services/i.test(flat)&&/Amount\s*\(CNY\)/i.test(flat)){
    result.kind='recharged-service';result.document_number=flat.match(/Report No\.\s*(\d+)/i)?.[1];
    const body=flat.slice(flat.indexOf('Name of works'),flat.indexOf('Total services provided'));
    const matches=[...body.matchAll(/\d+\s+(Payment for acquiring services|Cross charging for international delivery services)\s+(-?[\d ]+,\d{2})/g)];
    for(const [i,m]of matches.entries())add(m[1].includes('acquiring')?'一般收单支付服务费':'国际物流费',m[2],'CNY',`转收费报告第${i+1}项：${m[1]}`);
    const total=body.match(/Total\s+([\d ]+,\d{2})/);if(!total||!matches.length||Math.abs(rounded(result.facts.reduce((s,r)=>s+r.amount,0))-amount(total[1]))>0.01)fail('转收费报告明细与总额不符，停止入账');
    result.controls.push({name:'转收费明细与总额',difference:0,currency:'CNY'});result.warnings.push('需会计核实平台转收费关系及外部凭证链');
  }else if(/Compensation report/i.test(flat)&&!rows.length){
    result.kind='compensation';result.document_number=flat.match(/report\s*№\s*(\d+)/i)?.[1];const total=flat.match(/Total accrual:\s*([\d.]+)/);
    if(!total||!flat.includes('CNY'))fail('赔偿报告金额或币种不明确');add('平台赔偿收入',total[1],'CNY','Total accrual');result.warnings.push('赔偿为收入候选，确认时点和相应货损需会计另行审核');
  }else if(/Settlement Report/i.test(flat)&&rows.length){
    result.kind='balance';let opening=null,closing=null,change=0,active=false;
    for(const [i,r]of rows.entries()){
      const label=String(r?.[2]||'');if(label==='Начальное сальдо'){opening=amount(r[12])-amount(r[9]);active=true;}
      else if(label==='Конечное сальдо'){closing=amount(r[12])-amount(r[9]);active=false;}
      else if(active&&label){change+=amount(r[12])-amount(r[9]);result.cash.push({type:'balance-change',date:cell(r[7]),currency:'RUB',amount:rounded(amount(r[12])-amount(r[9])),reference:cell(r[5]),source:`第${i}行`,label});}
    }
    if(opening==null||closing==null)fail('相互结算表缺少期初或期末余额');
    result.controls.push({name:'期初＋变动－期末',opening,change:rounded(change),closing,difference:rounded(opening+change-closing),currency:'RUB'});
    if(Math.abs(rounded(opening+change-closing))>0.01)fail('平台月度余额不平，停止确认');
  }else if(/Report for currency payments/i.test(flat)){
    result.kind='currency-settlement';const total=flat.match(/Total to be paid:\s*(-?[\d ]+,\d{2})/);if(!total)fail('结算报告缺少应付金额');
    result.controls.push({name:'平台结算应付',amount:rounded(amount(total[1])),currency:'CNY',period:result.period});result.warnings.push('结算期可能跨月；不按付款或下载月份重记营业额与费用');
  }else if(/СЧЕТ-ФАКТУРА/i.test(flat)){
    result.kind='foreign-invoice';result.document_number=flat.match(/ЗВ\s*-\s*\d+/)?.[0]?.replace(/\s/g,'');result.warnings.push('境外发票仅补证；与同号服务书对应，RUB和CNY不得重复累加，汇率及VAT口径待核');
  }
  if(result.facts.length&&result.period&&(result.period.from!==month||result.period.to!==month))fail(`文件正文期间为${result.period.from}至${result.period.to}，与所选业务月份${month}不同，请切换正确月份`);
  if(result.facts.length&&!result.period)fail('无法识别正文业务期间（month），请提供完整原始文件，不能只按文件名入账');
  if(!result.document_number&&result.facts.length)fail('无法识别业务单据编号，停止自动入账，避免重复计费');
  result.currency=result.facts[0]?.currency||null;
  result.business_key=result.facts.length?crypto.createHash('sha256').update([result.kind,result.document_number,result.period.from,result.currency].join('|')).digest('hex'):null;
  if(!result.facts.length&&!result.controls.length)result.warnings.push('仅归档支持资料，不自动增加收入费用；格式未支持时请财务复核');
  return result;
}
