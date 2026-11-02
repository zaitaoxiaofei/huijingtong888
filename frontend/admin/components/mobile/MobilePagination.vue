<script setup>
import {computed,ref,watch} from 'vue';
const props=defineProps({page:{type:Number,default:1},pageSize:{type:Number,default:20},total:{type:Number,default:null},loading:Boolean});
const emit=defineEmits(['change']);
const pages=computed(()=>props.total==null?null:Math.max(1,Math.ceil(props.total/props.pageSize))),draft=ref(props.page);
watch(()=>props.page,value=>draft.value=value);
function move(value){if(props.loading||pages.value==null)return;const next=Math.max(1,Math.min(pages.value,Math.trunc(Number(value)||1)));draft.value=next;if(next!==props.page)emit('change',{page:next,pageSize:props.pageSize});}
</script>
<template><nav class="mobile-list-footer" aria-label="分页">
 <span class="mobile-pagination-total" :title="total==null?'数量待更新':`共 ${total} 条`">{{total==null?'待统计':`共${total}条`}}</span>
 <select :value="pageSize" aria-label="每页条数" :disabled="loading" @change="emit('change',{page:1,pageSize:Number($event.target.value)})"><option :value="20">20条/页</option><option :value="50">50条/页</option><option :value="100">100条/页</option></select>
 <button type="button" aria-label="上一页" :disabled="loading||page<=1||pages==null" @click="move(page-1)">‹</button>
 <label class="mobile-pagination-pages"><input v-model="draft" aria-label="当前页" type="number" inputmode="numeric" min="1" :max="pages||1" :disabled="loading||pages==null" @change="move(draft)" @keyup.enter="move(draft)"><span>/ {{pages??'—'}}页</span></label>
 <button type="button" aria-label="下一页" :disabled="loading||pages==null||page>=pages" @click="move(page+1)">›</button>
</nav></template>
<style scoped>
.mobile-list-footer{display:flex;align-items:center;gap:5px;padding:6px 0 0;border-top:1px solid var(--el-border-color-light);background:var(--erp-detail-surface-alt,#f4f7fb);font-size:12px;flex:none;min-width:0;width:100%;box-sizing:border-box;white-space:nowrap}
.mobile-pagination-total{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.mobile-list-footer select{width:85px;min-width:0;height:40px;padding:3px 0;border:1px solid var(--el-border-color);background:var(--el-bg-color);border-radius:6px;color:var(--el-text-color-primary)}
.mobile-list-footer button{flex:none;width:34px;height:40px;padding:0;font-size:23px;border:1px solid var(--el-border-color);border-radius:6px;color:var(--el-color-primary);background:var(--el-bg-color);cursor:pointer}.mobile-list-footer button:disabled{color:var(--el-text-color-disabled);cursor:default}
.mobile-pagination-pages{display:flex;align-items:center;gap:3px;flex:none}
.mobile-pagination-pages input{width:36px;min-width:0;height:40px;box-sizing:border-box;text-align:center;border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-bg-color);color:var(--el-text-color-primary);padding:3px 0;appearance:textfield;-moz-appearance:textfield}.mobile-pagination-pages input::-webkit-inner-spin-button,.mobile-pagination-pages input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
</style>
