import {materialBindings} from './workflow-materials.js';
const clean=value=>String(value??'').trim();
export const isKeyMold=record=>record.kind==='key_model'||record.payload?.role==='compatibility';
export const isReviewedMold=record=>record.payload?.reviewStatus!=='pending'&&!record.payload?.unresolvedBindings?.length;
export function normalizeMoldDetails(input={}){
 const value=Object.fromEntries(['moldCode','shape','yearRange','sourceUrl'].map(key=>[key,clean(input[key])]));
 if(value.moldCode.length>80||value.shape.length>300||value.yearRange.length>300||value.sourceUrl.length>2000||(value.sourceUrl&&!/^https:\/\//i.test(value.sourceUrl)))throw Object.assign(new Error('模具编号或说明过长，来源须为 HTTPS 链接'),{status:400});
 const reviewStatus=input.reviewStatus||'verified',buttonCount=Number(input.buttonCount||0);
 if(!['pending','verified'].includes(reviewStatus)||!Number.isInteger(buttonCount)||buttonCount<0||buttonCount>12)throw Object.assign(new Error('请选择有效核对状态和按键数量（0表示待核对）'),{status:400});
 return {...value,reviewStatus,buttonCount};
}
export const MOLD_COLUMNS=['资料ID','版本','记录类型','模具编号','模具名称','品牌','型号（多个用|）','年款及限制','按键数量','外形说明','图片地址（多个用|）','资料说明','核对状态','来源链接','类目ID','类目名称'];
export function moldMappingRows(records){return records.filter(isKeyMold).flatMap(record=>{const p=record.payload;return (materialBindings(p).length?materialBindings(p):[{brand:'',models:[]}]).map(binding=>({id:record.id,revision:record.revision,kind:record.kind,moldCode:p.moldCode||'',name:record.kind==='key_model'?p.label:p.name||record.name,brand:binding.brand,models:binding.models.join('|'),yearRange:p.yearRange||'',buttonCount:p.buttonCount||0,shape:p.shape||'',images:(p.images||[]).join('|'),notes:p.notes||'',reviewStatus:p.reviewStatus||'verified',sourceUrl:p.sourceUrl||'',categoryKey:p.listingCategory?.key||'',categoryName:p.listingCategory?.name||'',allModels:binding.allModels}));});}
const keys=['id','revision','kind','moldCode','name','brand','models','yearRange','buttonCount','shape','images','notes','reviewStatus','sourceUrl','categoryKey','categoryName'];
const safe=value=>/^[=+\-@\t\r]/.test(String(value))?"'"+value:String(value);
export function exportMoldCsv(records){const rows=moldMappingRows(records).map(row=>keys.map(key=>key==='reviewStatus'?(row[key]==='pending'?'待核对':'已核对'):key==='models'&&row.allModels?'*':row[key]));return '\uFEFF'+[MOLD_COLUMNS,...rows].map(row=>row.map(value=>'"'+safe(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n');}
export function parseMoldCsv(text){
 const rows=[];let row=[],cell='',quoted=false;
 text=String(text).replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n')){row.push(cell);cell='';if(c==='\n'){rows.push(row);row=[];}}else if(c!=='\r'||quoted)cell+=c;}
 if(quoted)throw new Error('CSV引号没有闭合，请使用导出的映射表格式');if(cell||row.length){row.push(cell);rows.push(row);}if(JSON.stringify(rows.shift())!==JSON.stringify(MOLD_COLUMNS))throw new Error('映射表列名不匹配，请先导出模板再修改');
 const grouped=new Map();for(const [index,values]of rows.entries()){if(values.every(v=>!v.trim()))continue;if(values.length!==keys.length)throw new Error(`第${index+2}行列数不正确`);const r=Object.fromEntries(keys.map((key,i)=>[key,values[i].replace(/^'(?=[=+\-@\t\r])/,'').trim()]));
 if(!r.name||!r.categoryKey||!r.categoryName)throw new Error(`第${index+2}行缺少模具名称或上架类目`);if(!['已核对','待核对'].includes(r.reviewStatus))throw new Error(`第${index+2}行核对状态须为已核对或待核对`);
 const patch={name:r.name,label:r.name,moldCode:r.moldCode,yearRange:r.yearRange,buttonCount:Number(r.buttonCount||0),shape:r.shape,images:r.images.split('|').filter(Boolean),notes:r.notes,reviewStatus:r.reviewStatus==='已核对'?'verified':'pending',sourceUrl:r.sourceUrl,role:'compatibility',listingCategory:{key:r.categoryKey,name:r.categoryName}};
 const key=r.id||r.moldCode;if(!key)throw new Error(`第${index+2}行新模具必须填写编号`);const previous=grouped.get(key);if(previous&&(previous.kind!==(r.kind==='key_model'?'key_model':'material')||previous.revision!==Number(r.revision)||JSON.stringify(previous.patch)!==JSON.stringify(patch)))throw new Error(`第${index+2}行同一模具的信息或版本不一致`);
 const item=previous||{id:r.id||null,revision:Number(r.revision||0),kind:r.kind==='key_model'?'key_model':'material',patch,bindings:[]};if(r.brand)item.bindings.push({brand:r.brand,models:r.models==='*'?[]:r.models.split('|').filter(Boolean),allModels:r.models==='*'});grouped.set(key,item);
 }
 if(!grouped.size||grouped.size>100)throw new Error('每次请导入1–100份模具资料');return [...grouped.values()].map(({bindings,...item})=>({...item,patch:{...item.patch,bindings}}));
}
