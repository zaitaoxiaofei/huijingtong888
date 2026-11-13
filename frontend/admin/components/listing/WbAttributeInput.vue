<script setup>
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {wbValueLabel} from '../../../../src/shared/wb-display.js';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {wbAttributeDirectory,wbTemplateOptions} from '../../../../src/shared/wb-attribute-options.js';
const props=defineProps({attribute:{type:Object,required:true},modelValue:{default:undefined},subjectId:{type:Number,required:true},shopId:{type:Number,default:null}}),emit=defineEmits(['update:modelValue']);
const options=ref([]),loading=ref(false),loaded=ref(false);let sequence=0;
const directory=computed(()=>wbAttributeDirectory(props.attribute)),multiple=computed(()=>Number(props.attribute.maxCount)!==1);
const selected=computed(()=>multiple.value?(Array.isArray(props.modelValue)?props.modelValue:props.modelValue?[String(props.modelValue)]:[]):Array.isArray(props.modelValue)?props.modelValue[0]||'':props.modelValue||'');
function reset(){sequence++;loading.value=false;loaded.value=false;options.value=wbTemplateOptions(props.attribute);}
watch(()=>[props.subjectId,props.shopId,props.attribute.charcID],reset,{immediate:true});
async function load(open){if(!open||loaded.value||loading.value||Number(props.attribute.charcType)===4)return;const id=++sequence,scope=currentApiCacheScope();loading.value=true;try{const r=await apiClient.get(`/api/wb/catalog/options?subject_id=${props.subjectId}&attribute_id=${props.attribute.charcID}${props.shopId?`&shop_id=${props.shopId}`:''}`,{noCache:true});if(id!==sequence||scope!==currentApiCacheScope())return;if(r.cache?.stale)throw Error('属性选项暂时无法更新，请稍后重试。');options.value=r.options||(r.data||[]).map(value=>({value,label:wbValueLabel(value)}));loaded.value=true;}catch(e){if(id===sequence&&scope===currentApiCacheScope())ElMessage.error(e.message);}finally{if(id===sequence)loading.value=false;}}
onMounted(()=>{window.addEventListener('erp:auth-scope-changed',reset);if(directory.value&&props.modelValue!==undefined&&props.modelValue!==null&&String(props.modelValue)!=='')load(true);});
onBeforeUnmount(()=>{sequence++;window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template>
 <div class="wb-attribute-input" :data-directory="directory" :data-loaded="loaded" :data-loading="loading" @click="load(true)" @pointerdown="load(true)" @focusin="load(true)">
 <el-input-number v-if="Number(attribute.charcType)===4" :model-value="modelValue===undefined||modelValue===''?undefined:Number(modelValue)" :controls="false" @update:model-value="emit('update:modelValue',$event)"/>
 <el-select v-else :model-value="selected" :multiple="multiple" :multiple-limit="Number(attribute.maxCount)||0" :allow-create="!directory" default-first-option filterable clearable collapse-tags collapse-tags-tooltip :loading="loading" :placeholder="directory?'搜索并选择':String(attribute.name).includes('包装代码')?'选择或输入实际包装代码':'选择或输入'" @focus="load(true)" @visible-change="load" @update:model-value="emit('update:modelValue',$event)">
  <el-option v-for="option in options" :key="option.value" :label="option.label" :value="option.value"/>
  <template #footer v-if="!directory"><small class="option-hint">模板或本店同类目已用值；可输入新值，按回车确认</small></template>
 </el-select>
 </div>
</template>
<style scoped>.wb-attribute-input{width:100%;min-width:0}.wb-attribute-input :deep(.el-select){width:100%}.option-hint{color:var(--el-text-color-secondary)}</style>
