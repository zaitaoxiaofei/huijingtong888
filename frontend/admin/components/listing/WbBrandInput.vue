<script setup>
import {ref,onBeforeUnmount,watch} from 'vue';import {ElMessage} from 'element-plus';import {apiClient,currentApiCacheScope} from '../../utils/api.js';
const props=defineProps({modelValue:{type:String,default:''},subjectId:{type:Number,required:true},shopId:{type:Number,default:null}}),emit=defineEmits(['update:modelValue']);const options=ref(props.modelValue?[props.modelValue]:[]),loading=ref(false),loaded=ref(false);let sequence=0;
async function load(){if(loading.value||loaded.value)return;const id=++sequence,scope=currentApiCacheScope();loading.value=true;try{const r=await apiClient.get(`/api/wb/catalog/brands?subject_id=${props.subjectId}${props.shopId?`&shop_id=${props.shopId}`:''}`,{noCache:true});if(id!==sequence||scope!==currentApiCacheScope())return;options.value=[...new Set([props.modelValue,...r.data].filter(Boolean))];loaded.value=true;}catch(e){if(id===sequence)ElMessage.error(e.message);}finally{if(id===sequence)loading.value=false;}}
watch([()=>props.shopId,()=>props.subjectId],()=>{sequence++;options.value=props.modelValue?[props.modelValue]:[];loaded.value=false;loading.value=false;});
onBeforeUnmount(()=>sequence++);
</script>
<template><div @click="load" @focusin="load"><el-select-v2 :model-value="modelValue" :options="options.map(value=>({value,label:['Без бренда','Нет бренда'].includes(value)?'无品牌':value}))" filterable allow-create clearable :loading="loading" placeholder="选择或填写品牌" @update:model-value="emit('update:modelValue',$event||'')"/></div></template>
