<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { withImageToken } from '../../api/tools/imageCropper.js';
import { apiClient } from '../../utils/api.js';
import { matchingKeyModels, applyKeyModel } from '../../../../src/shared/workflow-key-models.js';
import WorkflowMaterialInput from './WorkflowMaterialInput.vue';
const props=defineProps({values:{type:Object,required:true},node:{type:Object,required:true},disabled:Boolean,refresh:{type:Number,default:0}}),emit=defineEmits(['upload','manage']);
const manualMode=ref(false);
const records=ref([]),error=ref(''),loading=ref(false);let sequence=0;
const selected=computed(()=>records.value.find(r=>r.id===props.values.__keyModelId));
async function load(){const seq=++sequence,model=props.values.model;if(!model){records.value=[];loading.value=false;return;}loading.value=true;error.value='';try{const rows=await apiClient.get(`/api/product-workflows/key-models?model=${encodeURIComponent(model)}`,{noCache:true});if(seq!==sequence)return;records.value=matchingKeyModels(rows,model);const removed=Boolean(props.values.__keyModelId&&!records.value.some(r=>r.id===props.values.__keyModelId));if(removed&&!props.disabled){props.values.key=[];delete props.values.__keyModelId;error.value='原适配资料已停用或移除，请重新选择';}if(!removed&&records.value.length===1&&!props.values.key?.some(Boolean)&&!props.disabled)applyKeyModel(props.values,records.value[0],props.node.count);}catch(e){if(seq===sequence)error.value='适配库暂未加载，仍可手动上传';}finally{if(seq===sequence)loading.value=false;}}
onUnmounted(()=>{sequence++;});
watch([()=>props.values.model,()=>props.refresh],load,{immediate:true});
function choose(id){const record=records.value.find(r=>r.id===id);if(record){applyKeyModel(props.values,record,props.node.count);manualMode.value=false;}else{props.values.key=(props.values.key||[]).map(()=>'');delete props.values.__keyModelId;}}
function manual(file,index){if(!props.disabled)emit('upload',file,index);}
function remove(values){props.values.key=values;delete props.values.__keyModelId;}
</script>
<template>
  <div class="key-picker"><div class="key-picker-heading"><strong>适配钥匙</strong><el-button link type="primary" :disabled="disabled" @click="emit('manage',{model:values.model,images:values.key?.filter(Boolean)||[],create:Boolean(values.key?.some(Boolean)&&!selected)})">{{ values.key?.some(Boolean)&&!selected?'保存到企业适配库':'管理企业适配库' }}</el-button></div><el-select v-if="records.length" :model-value="values.__keyModelId||''" clearable :disabled="disabled" :loading="loading" placeholder="此型号有多种钥匙，请选择" @change="choose"><el-option v-for="record in records" :key="record.id" :value="record.id" :label="record.payload.label"/></el-select><el-button v-if="selected&&values.__keyModelRevision!==selected.revision" link type="warning" :disabled="disabled" @click="applyKeyModel(values,selected,node.count)">资料已更新，点击更新引用</el-button><p v-if="selected" class="key-loaded">已带入企业资料：{{ selected.payload.label }}</p><p v-else>{{ loading?'正在查找企业适配资料…':error||'可从企业适配库带入，也可以上传。产品主图已包含适配钥匙时可跳过。' }}</p><div v-if="selected&&!manualMode" class="saved-key-preview"><el-image :src="withImageToken(values.key[0])" :preview-src-list="values.key.filter(Boolean).map(withImageToken)" preview-teleported fit="contain"/><div><p>{{ selected.payload.notes||'已使用企业保存的适配图，无需重复上传' }}</p><el-button link type="primary" :disabled="disabled" @click="manualMode=true">替换适配图</el-button></div></div><WorkflowMaterialInput v-else :model-value="values.key" compact :node="node" :disabled="disabled" @update:model-value="remove" @upload="manual"/></div>
</template>
<style scoped>
.key-picker{padding:14px;background:var(--el-fill-color-lighter);border-radius:8px}.key-picker-heading{display:flex;justify-content:space-between;gap:12px;align-items:center}.key-picker p{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.key-picker .key-loaded{color:var(--el-color-success)}.el-select{width:100%;margin-top:10px}
.saved-key-preview{display:flex;gap:14px;align-items:center}.saved-key-preview .el-image{width:64px;height:84px;flex-shrink:0;background:var(--el-bg-color)}
</style>
