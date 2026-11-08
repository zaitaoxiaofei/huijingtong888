<script setup>
import {computed,ref} from 'vue';
const props=defineProps({series:{type:Array,default:()=>[]},metrics:{type:Array,required:true},unit:{type:String,default:''}});
const hidden=ref([]),hover=ref(null),svg=ref(null);
const colors=['#4c9bff','#27c5a3','#f5b84c','#b28aff','#f47987'];
const lines=computed(()=>props.metrics.map(([key,label],index)=>({key,label,color:colors[index%colors.length]})));
const shown=computed(()=>lines.value.filter(line=>!hidden.value.includes(line.key)));
const value=(day,key)=>day?.available&&day[key]!==null&&day[key]!==undefined&&Number.isFinite(Number(day[key]))?Number(day[key]):null;
const maximum=computed(()=>Math.max(1,...shown.value.flatMap(line=>props.series.map(day=>value(day,line.key)).filter(v=>v!==null))));
const ceiling=computed(()=>{const scale=10**Math.floor(Math.log10(maximum.value));return Math.ceil(maximum.value/scale)*scale;});
const x=index=>56+index*612/Math.max(1,props.series.length-1);
const y=n=>266-n/ceiling.value*226;
const ticks=computed(()=>Array.from({length:5},(_,i)=>ceiling.value*i/4));
function segments(key){const result=[];let current=[];props.series.forEach((day,index)=>{const n=value(day,key);if(n===null){if(current.length)result.push(current);current=[];}else current.push({x:x(index),y:y(n)});});if(current.length)result.push(current);return result;}
function move(event){const box=svg.value?.getBoundingClientRect();if(!box?.width||!props.series.length)return;const position=(event.clientX-box.left)*700/box.width;hover.value=Math.max(0,Math.min(props.series.length-1,Math.round((position-56)/612*Math.max(1,props.series.length-1))));}
function keyMove(event){if(!['ArrowLeft','ArrowRight'].includes(event.key)||!props.series.length)return;event.preventDefault();hover.value=Math.max(0,Math.min(props.series.length-1,(hover.value??0)+(event.key==='ArrowRight'?1:-1)));}
function toggle(key){hidden.value=hidden.value.includes(key)?hidden.value.filter(k=>k!==key):[...hidden.value,key];}
const selected=computed(()=>hover.value===null?null:props.series[hover.value]);
const number=n=>n===null?'未采到':`${n.toLocaleString(undefined,{maximumFractionDigits:2})}${props.unit}`;
const hasData=computed(()=>props.series.some(day=>shown.value.some(line=>value(day,line.key)!==null)));
</script>
<template>
 <section class="trend-chart">
  <div class="legend"><button v-for="line in lines" :key="line.key" type="button" :class="{hidden:hidden.includes(line.key)}" :aria-pressed="!hidden.includes(line.key)" @click="toggle(line.key)"><i :style="{background:line.color}"/>{{line.label}}</button></div>
  <div class="plot" tabindex="0" aria-label="每日趋势图，鼠标悬浮查看某天，左右方向键切换日期" @keydown="keyMove" @pointerleave="hover=null" @blur="hover=null">
   <svg ref="svg" viewBox="0 0 700 310" role="img" aria-label="横轴为报表日期，纵轴为指标数值，断线表示未采集" @pointermove="move">
    <g v-for="tick in ticks" :key="tick"><line x1="56" x2="668" :y1="y(tick)" :y2="y(tick)" class="grid"/><text x="48" :y="y(tick)+4" text-anchor="end">{{tick.toLocaleString(undefined,{maximumFractionDigits:1})}}{{unit}}</text></g>
    <template v-for="line in shown" :key="line.key"><g v-for="(segment,index) in segments(line.key)" :key="index"><polyline :points="segment.map(p=>`${p.x},${p.y}`).join(' ')" fill="none" :stroke="line.color" stroke-width="2" vector-effect="non-scaling-stroke"/><circle v-for="(point,i) in segment" :key="i" :cx="point.x" :cy="point.y" r="3" :fill="line.color"/></g></template>
    <template v-for="(day,index) in series" :key="day.date_key"><text v-if="index===0||index===series.length-1||index%Math.ceil(series.length/7)===0" :x="x(index)" y="289" text-anchor="middle">{{day.date_key.slice(5)}}</text></template>
    <line v-if="selected" :x1="x(hover)" :x2="x(hover)" y1="40" y2="266" class="cursor"/>
    <text v-if="!shown.length" x="360" y="155" text-anchor="middle">请在图例中选择指标</text>
    <text v-else-if="!hasData" x="360" y="155" text-anchor="middle">所选范围尚无日记录</text>
   </svg>
   <div v-if="selected" class="hover-detail" :style="hover>Math.max(1,series.length-1)/2?{right:'12px'}:{left:'12px'}" role="status"><strong>{{selected.date_key}}</strong><span v-for="line in lines" :key="line.key"><i :style="{background:line.color}"/>{{line.label}}<b>{{number(value(selected,line.key))}}</b></span></div>
  </div>
  <p>点击图例可显示或隐藏曲线；悬浮查看当天数值。未采到的日期保留断点。</p>
 </section>
</template>
<style scoped>
.trend-chart{min-width:0}.legend{display:flex;flex-wrap:wrap;gap:6px 12px}.legend button{display:flex;align-items:center;gap:5px;border:0;background:none;color:var(--erp-text);font-size:12px;cursor:pointer;padding:4px 0}.legend button.hidden{opacity:.35}.legend i,.hover-detail i{width:8px;height:8px;border-radius:50%;flex-shrink:0}.plot{position:relative;outline-offset:3px}.plot svg{display:block;width:100%;min-height:230px}.grid{stroke:var(--erp-border);stroke-dasharray:3 4}.cursor{stroke:var(--erp-text-secondary);stroke-dasharray:4 4}text{font-size:11px;fill:var(--erp-text-secondary)}.hover-detail{position:absolute;top:24px;width:210px;padding:12px;background:var(--erp-surface-alt);border:1px solid var(--erp-border-strong);border-radius:8px;box-shadow:0 8px 26px #0003;pointer-events:none;display:flex;flex-direction:column;gap:8px;font-size:12px;z-index:2}.hover-detail span{display:flex;align-items:center;gap:6px}.hover-detail b{margin-left:auto}p{font-size:12px;color:var(--erp-text-secondary);line-height:1.7;margin:0}
</style>
