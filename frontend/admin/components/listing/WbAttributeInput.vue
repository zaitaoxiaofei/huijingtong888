<script setup>
import {computed,onBeforeUnmount,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {wbAttributeDirectory} from '../../../../src/shared/wb-attribute-options.js';
const props=defineProps({attribute:{type:Object,required:true},modelValue:{default:undefined},subjectId:{type:Number,required:true},shopId:{type:Number,default:null}}),emit=defineEmits(['update:modelValue']);
const options=ref([]),loading=ref(false),loaded=ref(false);let sequence=0;
const directory=computed(()=>wbAttributeDirectory(props.attribute)),multiple=computed(()=>Number(props.attribute.maxCount)!==1);
const selected=computed(()=>multiple.value?(Array.isArray(props.modelValue)?props.modelValue:props.modelValue?[String(props.modelValue)]:[]):Array.isArray(props.modelValue)?props.modelValue[0]||'':props.modelValue||'');
async function load(open){if(!open||!directory.value||loaded.value||loading.value)return;const id=++sequence,scope=currentApiCacheScope();loading.value=true;try{const r=await apiClient.get(`/api/wb/catalog/options?subject_id=${props.subjectId}&attribute_id=${props.attribute.charcID}${props.shopId?`&shop_id=${props.shopId}`:''}`,{noCache:true});if(id!==sequence||scope!==currentApiCacheScope())return;if(r.cache?.stale)throw Error('属性选项暂时无法更新，请稍后重试。');options.value=r.data;loaded.value=true;}catch(e){ElMessage.error(e.message);}finally{if(id===sequence)loading.value=false;}}
onBeforeUnmount(()=>sequence++);
</script>
<template>
 <div class="wb-attribute-input" :data-directory="directory" :data-loaded="loaded" :data-loading="loading" @click="load(true)" @pointerdown="load(true)" @focusin="load(true)">
 <el-input-number v-if="Number(attribute.charcType)===4" :model-value="modelValue===undefined||modelValue===''?undefined:Number(modelValue)" :controls="false" @update:model-value="emit('update:modelValue',$event)"/>
 <el-select v-else-if="directory" :model-value="selected" :multiple="multiple" :multiple-limit="Number(attribute.maxCount)||0" filterable clearable collapse-tags collapse-tags-tooltip :loading="loading" placeholder="请选择" @focus="load(true)" @visible-change="load" @update:model-value="emit('update:modelValue',$event)"><el-option v-for="value in options" :key="value" :label="value" :value="value"/></el-select>
 <el-input v-else :model-value="Array.isArray(modelValue)?modelValue.join(', '):modelValue" :placeholder="attribute.maxCount===1?'填写属性值':'多个值用逗号分隔'" @update:model-value="emit('update:modelValue',$event)"/>
 </div>
</template>
<style scoped>.wb-attribute-input{width:100%;min-width:0}.wb-attribute-input :deep(.el-select){width:100%}</style>
