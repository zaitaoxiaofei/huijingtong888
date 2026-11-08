<script setup>
import { onMounted, ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import WorkflowKeyLibrary from './WorkflowKeyLibrary.vue';
import WorkflowMaterialLibrary from './WorkflowMaterialLibrary.vue';
const props=defineProps({modelValue:{type:Array,default:()=>[]},label:{type:String,default:'引用生产资料'},imageReferences:{type:Boolean,default:true}}),emit=defineEmits(['update:modelValue']);
const records=ref([]),open=ref(false),loading=ref(false),libraryTab=ref('materials');
const selected=computed(()=>props.modelValue.map(ref=>ref.id));
const stale=computed(()=>props.modelValue.filter(ref=>!records.value.some(r=>r.id===ref.id&&r.revision===ref.revision)));
async function load(){loading.value=true;try{const [materials,keys]=await Promise.all([apiClient.get('/api/product-workflows/materials',{noCache:true}),apiClient.get('/api/product-workflows/key-models',{noCache:true})]);records.value=[...materials,...keys];}catch(e){ElMessage.error(e.message);}finally{loading.value=false;}}
function change(ids){emit('update:modelValue',ids.map(id=>{const r=records.value.find(r=>r.id===id);return {id,kind:r?.kind||props.modelValue.find(r=>r.id===id)?.kind||'material',revision:r?.revision||props.modelValue.find(r=>r.id===id)?.revision||1};}));}
onMounted(load);
</script>
<template><div class="material-references"><div class="references-head"><strong>{{ label }}</strong><el-button link type="primary" @click="open=true">新增 / 管理资料</el-button></div><el-select :model-value="selected" multiple filterable clearable :loading="loading" placeholder="搜索选择企业已有资料，可留空" @visible-change="$event&&load()" @change="change"><el-option v-for="record in records" :key="record.id" :value="record.id" :label="[record.name,record.payload.material,record.payload.category].filter(Boolean).join(' · ')"/><el-option v-for="ref in modelValue.filter(ref=>!records.some(r=>r.id===ref.id))" :key="ref.id" :value="ref.id" label="资料已停用或不可用，请移除" disabled/></el-select><small>{{ imageReferences?'图片与说明一起提供给本节点；超过模型图片上限时会提示调整引用。':'文本节点只引用资料说明，不读取图片。' }}</small><el-alert v-if="stale.length" type="warning" :closable="false" title="引用资料已更新或停用，请更新引用或移除后重新选择。"><el-button link @click="change(selected.filter(id=>records.some(r=>r.id===id)))">更新引用</el-button></el-alert><el-dialog v-model="open" title="企业生产资料库" width="960px" top="4vh" append-to-body><el-tabs v-if="open" v-model="libraryTab"><el-tab-pane label="公共生产资料" name="materials" lazy><WorkflowMaterialLibrary @saved="load"/></el-tab-pane><el-tab-pane label="钥匙适配资料" name="keys" lazy><WorkflowKeyLibrary @saved="load"/></el-tab-pane></el-tabs></el-dialog></div></template>
<style scoped>.references-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}.references-head strong{font-size:13px}.el-select{width:100%}small{display:block;margin-top:8px;font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.material-references{margin:12px 0}</style>
