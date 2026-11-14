import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import path from 'node:path';

// Ozon exports include prefixed XML and rows without r attributes, both legal
// OOXML variants that the existing payroll ExcelJS loader cannot read reliably.
function xml(text, handlers) {
  const parser=new SaxesParser({xmlns:true});
  parser.on('doctype',()=>{throw new Error('财务表格不允许DOCTYPE');});
  for(const [event,handler]of Object.entries(handlers))parser.on(event,handler);
  parser.write(text).close();
}
const attr=(node,name)=>node.attributes[name]?.value;
export async function financeXlsxRows(buffer){
  const zip=await JSZip.loadAsync(buffer);
  const read=async name=>{const f=zip.file(name);if(!f)throw new Error(`财务表格缺少${name}`);return f.async('string');};
  let sheetId,target;xml(await read('xl/workbook.xml'),{opentag:n=>{if(n.local==='sheet'&&!sheetId)sheetId=attr(n,'r:id');}});
  xml(await read('xl/_rels/workbook.xml.rels'),{opentag:n=>{if(n.local==='Relationship'&&attr(n,'Id')===sheetId)target=attr(n,'Target');}});
  if(!target)throw new Error('财务表格没有工作表');
  target=path.posix.normalize(target.startsWith('/')?target.slice(1):`xl/${target}`);
  if(!target.startsWith('xl/worksheets/'))throw new Error('财务表格工作表路径无效');
  const strings=[];let str='',inT=false;
  if(zip.file('xl/sharedStrings.xml'))xml(await read('xl/sharedStrings.xml'),{opentag:n=>{if(n.local==='si')str='';if(n.local==='t')inT=true;},text:t=>{if(inT)str+=t;},closetag:n=>{if(n.local==='t')inT=false;if(n.local==='si')strings.push(str);}});
  const rows=[];let row=0,column=0,c=null,mode=null,value='',inline='',formula=false;
  xml(await read(target),{
    opentag:n=>{
      if(n.local==='row'){row=Number(attr(n,'r')||row+1);column=0;if(!Number.isSafeInteger(row)||row<1||row>100000)throw new Error('财务表格超过10万行');rows[row]=[];}
      if(n.local==='c'){
        const ref=attr(n,'r')||'';const letters=ref.match(/^[A-Z]+/)?.[0];
        const col=letters?[...letters].reduce((s,x)=>s*26+x.charCodeAt(0)-64,0):column+1;column=col;if(col>120)throw new Error('财务表格超过120列');
        c={col,type:attr(n,'t')};value='';inline='';formula=false;
      }
      if(c&&['v','t','f'].includes(n.local)){mode=n.local;if(mode==='f')formula=true;}
    },text:t=>{if(mode==='v')value+=t;if(mode==='t')inline+=t;},
    closetag:n=>{
      if(['v','t','f'].includes(n.local))mode=null;
      if(n.local==='c'&&c){
        if(formula&&!value)throw new Error('财务表格公式缺少保存结果');
        rows[row][c.col]=c.type==='s'?strings[Number(value)]:c.type==='inlineStr'?inline:c.type==='str'?value:value===''?'':Number(value);
        c=null;
      }
    }
  });return rows;
}
