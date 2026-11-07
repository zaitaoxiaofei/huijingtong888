<script setup>
import {computed} from 'vue';
const props=defineProps({series:{type:Array,default:()=>[]},metric:{type:String,default:'total_views'},label:{type:String,default:'曝光'},unit:{type:String,default:''},compact:Boolean});
const points=computed(()=>{
 const values=props.series.map(p=>p.available&&p[props.metric]!==null&&p[props.metric]!==undefined?Number(p[props.metric]):null);
 const max=Math.max(1,...values.filter(v=>v!==null));
 return values.map((value,i)=>({value,date:props.series[i].date_key,x:10+i*280/Math.max(1,values.length-1),y:value===null?null:82-value/max*66}));
});
const segments=computed(()=>{const result=[];let segment=[];for(const p of points.value){if(p.value===null){if(segment.length)result.push(segment);segment=[];}else segment.push(p);}if(segment.length)result.push(segment);return result;});
const maxValue=computed(()=>Math.max(0,...points.value.filter(p=>p.value!==null).map(p=>p.value)));
const validCount=computed(()=>points.value.filter(p=>p.value!==null).length);
</script>
<template>
 <figure class="sku-traffic-chart" :class="{compact}">
  <figcaption v-if="!compact"><span>{{label}}</span><small>峰值 {{maxValue.toLocaleString()}}{{unit}} · {{validCount}} / {{series.length}} 天有数据</small></figcaption>
  <svg viewBox="0 0 300 100" role="img" :aria-label="`${label}每日趋势；空缺处未采集到数据`">
   <line x1="10" y1="82" x2="290" y2="82" class="axis"/>
   <polyline v-for="(segment,index) in segments" :key="index" :points="segment.map(p=>`${p.x},${p.y}`).join(' ')" fill="none" class="trend-line"/>
   <circle v-for="p in points.filter(p=>p.value!==null)" :key="p.date" :cx="p.x" :cy="p.y" :r="compact?2:3" class="trend-dot"><title>{{p.date}} {{label}}：{{p.value.toLocaleString()}}{{unit}}</title></circle>
   <template v-if="!compact&&series.length"><text x="10" y="97">{{series[0].date_key.slice(5)}}</text><text x="290" y="97" text-anchor="end">{{series[series.length-1].date_key.slice(5)}}</text></template>
   <text v-if="!validCount" x="150" y="50" text-anchor="middle">暂无日数据</text>
  </svg>
 </figure>
</template>
<style scoped>
.sku-traffic-chart{margin:0;border:1px solid var(--erp-border-color,#e4e7ed);border-radius:12px;padding:16px;background:var(--erp-bg-card,#fff)}
figcaption{display:flex;justify-content:space-between;gap:12px;font-weight:600}small{font-weight:400;color:var(--erp-text-secondary,#7b8497)}svg{display:block;width:100%;height:160px}.axis{stroke:var(--erp-border-color,#e4e7ed)}.trend-line{stroke:#2878cd;stroke-width:2;vector-effect:non-scaling-stroke}.trend-dot{fill:#2878cd}text{font-size:10px;fill:var(--erp-text-secondary,#7b8497)}.compact{padding:0;border:0;background:transparent}.compact svg{height:48px;width:160px}
</style>
