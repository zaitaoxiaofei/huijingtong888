<script setup>
import {computed} from 'vue';
import {orderHandlingContext} from '../../utils/order-handling-context.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
const props=defineProps({row:{type:Object,default:()=>({})},showNote:{type:Boolean,default:true}});
const context=computed(()=>orderHandlingContext(props.row));
const printedTime=computed(()=>props.row.printed_at?shanghaiDateTimeText(props.row.printed_at,{assumeUtcWhenNaive:true}):'');
</script>
<template>
 <div class="order-handling-summary">
  <div class="handling-tags">
   <el-tag size="small" :type="context.printed?'success':'info'" title="面单打印记录仅供核对，不等于已交接或已进入运输。">{{context.printLabel}}</el-tag>
   <span class="handling-mark" :class="`is-${context.markColor}`"><i v-if="context.marked" aria-hidden="true"/>{{context.markLabel}}</span>
  </div>
  <small v-if="printedTime">打印：{{printedTime}}</small>
  <p v-if="showNote" class="handling-note" :title="context.note">{{context.note||'无备注'}}</p>
 </div>
</template>
<style scoped>
.order-handling-summary{display:grid;gap:5px;margin-top:7px;line-height:1.5;font-size:12px;font-weight:400}.handling-tags{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.handling-mark{display:inline-flex;align-items:center;gap:5px;color:var(--mark-color,var(--el-text-color-secondary));font-size:12px}.handling-mark i{width:8px;height:8px;flex-shrink:0;border-radius:50%;background:currentColor}.is-red{--mark-color:#f56c6c}.is-orange{--mark-color:#e6a23c}.is-yellow{--mark-color:#b99516}.is-green{--mark-color:#67c23a}.is-cyan{--mark-color:#16a6bb}.is-purple{--mark-color:#a78bfa}.order-handling-summary small{color:var(--el-text-color-secondary)}.handling-note{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;color:var(--el-text-color-regular)}
</style>
