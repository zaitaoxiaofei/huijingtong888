import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const component=fs.readFileSync('frontend/admin/components/SkuTrafficTrendChart.vue','utf8');
const script=component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import .*?from 'vue';/,'');
test('trend hover and keyboard select the exact calendar day; missing dates break lines and zero stays visible',()=>{
 const props={unit:'',metrics:[['total_views','曝光'],['ordered_units','下单']],series:[{date_key:'2026-11-01',available:true,total_views:0,ordered_units:0},{date_key:'2026-11-02',available:true,total_views:10,ordered_units:1},{date_key:'2026-11-03',available:false,total_views:null,ordered_units:null},{date_key:'2026-11-04',available:true,total_views:20,ordered_units:2}]};
 const context=vm.createContext({defineProps:()=>props,ref:value=>({value}),computed:fn=>({get value(){return fn();}})});
 vm.runInContext(script+';this.api={svg,hover,selected,move,keyMove,segments,value,toggle,shown,ceiling};',context);
 const api=context.api;api.svg.value={getBoundingClientRect:()=>({left:100,width:700})};
 api.move({clientX:100+56+612*2/3});assert.equal(api.selected.value.date_key,'2026-11-03');assert.equal(api.value(api.selected.value,'total_views'),null);
 api.keyMove({key:'ArrowLeft',preventDefault(){}});assert.equal(api.selected.value.date_key,'2026-11-02');assert.equal(api.value(api.selected.value,'ordered_units'),1);
 const paths=api.segments('total_views');assert.equal(paths.length,2);assert.equal(paths[0].length,2);assert.equal(paths[0][0].y,266);
 api.toggle('total_views');assert.equal(api.shown.value.length,1);assert.equal(api.ceiling.value,2);
 api.move({clientX:100+668});assert.equal(api.selected.value.date_key,'2026-11-04');
 props.compact=true;assert.equal(api.segments('total_views')[0][0].y,108);
});
