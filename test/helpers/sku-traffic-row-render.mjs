import fs from 'node:fs';
import vm from 'node:vm';
import {compileTemplate,parse} from '@vue/compiler-sfc';
import {createSSRApp,computed,ref} from 'vue';
import {ElImage,ElRadioGroup,ElRadioButton} from 'element-plus';
import {renderToString} from 'vue/server-renderer';
const view=fs.readFileSync(new URL('../../frontend/admin/views/analytics/SkuTrafficMonitorView.vue',import.meta.url),'utf8');
const chart=fs.readFileSync(new URL('../../frontend/admin/components/SkuTrafficTrendChart.vue',import.meta.url),'utf8');
async function renderFunction(template,name){
 const result=compileTemplate({source:template,filename:name,id:name,ssr:true,ssrCssVars:[]});
 if(result.errors.length)throw new Error(String(result.errors));
 const code=result.code.replace(/from ["'](vue(?:\/server-renderer)?)["']/g,(_,name)=>'from '+JSON.stringify(import.meta.resolve(name)));
 return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).ssrRender;
}
export async function renderTrafficRows(rows){
 const imageDescriptor=parse(fs.readFileSync(new URL('../../frontend/admin/components/SkuTrafficProductImage.vue',import.meta.url),'utf8')).descriptor;
 const ProductImage={props:{src:String,alt:String,hero:Boolean},setup(props){const context=vm.createContext({defineProps:()=>props,computed});vm.runInContext(imageDescriptor.scriptSetup.content.replace(/^import .*$/gm,'')+';this.exposed={url};',context);return {...props,...context.exposed};},ssrRender:await renderFunction(imageDescriptor.template.content,'TrafficImage')};
 const metrics=[['total_views','总曝光'],['search_views','搜索曝光'],['pdp_views','详情浏览'],['total_hits_to_cart','加购次数'],['ordered_units','下单件数']];
 const chartDescriptor=parse(chart).descriptor;
 const chartScript=chartDescriptor.scriptSetup.content.replace(/^import .*$/gm,'');
 const Chart={props:{series:Array,metrics:Array,unit:{type:String,default:''},compact:Boolean,tooltipMetrics:Array},setup(props){
  const context=vm.createContext({defineProps:()=>props,computed,ref});
  vm.runInContext(chartScript+';this.exposed={hidden,hover,svg,lines,shown,value,maximum,ceiling,bottom,x,y,ticks,segments,move,keyMove,toggle,selected,number,hasData,tooltipLines,tooltipPosition};',context);
  return {...props,...context.exposed};
 },ssrRender:await renderFunction(chartDescriptor.template.content,'TrafficChart')};
 const start=view.indexOf('  <div v-loading="loading" class="records-scroll">'),end=view.indexOf('  <el-drawer',start);
 const template=view.slice(start,end).replace('v-loading="loading"','');
 const component={setup:()=>({state:{rows,range_from:'2026-11-01',date:'2026-11-07'},rateLabel:key=>key,metrics,rates:[],hoverMetrics:[],chartOptions:[],visibleKeys:[],toggleLine(){},lineMetrics:metrics,chartGroup:'traffic',shortName:name=>name,inventoryLabel:row=>row.inventory.map(i=>i.name).join(' / ')||'未关联库存',number:value=>value??'—',percent:value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`}),ssrRender:await renderFunction(template,'TrafficRows')};
 const app=createSSRApp(component);app.component('SkuTrafficTrendChart',Chart);app.component('SkuTrafficProductImage',ProductImage);app.component('ElImage',ElImage);app.component('ElRadioGroup',ElRadioGroup);app.component('ElRadioButton',ElRadioButton);app.component('ElEmpty',{render:()=>null});
 const html=await renderToString(app);
 return {html,css:parse(view).descriptor.styles[0].content+chartDescriptor.styles[0].content+imageDescriptor.styles[0].content};
}
