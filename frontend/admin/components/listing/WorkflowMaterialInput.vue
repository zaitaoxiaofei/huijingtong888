<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { apiClient } from '../../utils/api.js';
import { withImageToken } from '../../api/tools/imageCropper.js';
const props=defineProps({node:{type:Object,required:true},modelValue:{default:''},category:{type:Object,default:()=>({})},disabled:Boolean,compact:Boolean});
const emit=defineEmits(['update:modelValue','upload','options']);
const loading=ref(false);
async function loadOptions(keyword='') {
  if(!props.node.dictionaryId||loading.value)return;
  loading.value=true;
  try {
    const params=new URLSearchParams({description_category_id:props.category.descriptionCategoryId,type_id:props.category.typeId,attribute_id:props.node.attributeId,limit:60,keyword});
    const rows=await apiClient.get(`/api/listing/ozon-attribute-values?${params}`,{noCache:true});
    const options=new Map((props.node.options||[]).map(x=>[x.id,x]));
    for(const row of rows){const id=Number(row.dictionary_value_id||row.id);if(id)options.set(id,{id,label:row.display_value_zh||row.value_zh||row.label||row.value||row.name});}
    emit('options',[...options.values()]);
  }catch(error){ElMessage.error(error.message);}finally{loading.value=false;}
}
function remove(index){const next=[...(props.modelValue||[])];next[index]='';emit('update:modelValue',next);}
</script>
<template>
  <div v-if="node.type==='images'" class="workflow-upload-slots" :class="{'is-compact':compact}">
    <div v-for="(purpose,index) in node.slots" :key="index" class="upload-slot">
      <span v-if="!compact||node.slots.length>1">{{ index+1 }}. {{ purpose }}</span>
      <el-image v-if="modelValue?.[index]" :src="withImageToken(modelValue[index])" :preview-src-list="modelValue.filter(Boolean).map(withImageToken)" :initial-index="modelValue.slice(0,index).filter(Boolean).length" preview-teleported fit="contain"/>
      <el-upload v-if="!disabled" accept="image/*" :auto-upload="false" :show-file-list="false" :on-change="file=>emit('upload',file.raw,index)" :aria-label="`${node.label} ${purpose}`">
        <el-button v-if="modelValue?.[index]" size="small">替换图片</el-button><div v-else class="upload-placeholder"><el-icon :size="24"><Plus/></el-icon><strong>选择图片</strong><span>点击上传 · 支持 JPG、PNG</span></div>
      </el-upload>
      <el-button v-if="modelValue?.[index]&&!disabled" link type="danger" @click="remove(index)">移除</el-button>
    </div>
  </div>
  <el-select v-else-if="node.type==='attribute'&&node.dictionaryId" :model-value="modelValue" :multiple="node.multiple" filterable remote :remote-method="loadOptions" :loading="loading" :disabled="disabled" placeholder="选择已核实的属性值" @update:model-value="emit('update:modelValue',$event)" @visible-change="$event&&loadOptions()">
    <el-option v-for="option in node.options||[]" :key="option.id" :label="option.label" :value="option.id"/>
  </el-select>
  <el-input v-else :model-value="modelValue" :type="compact&&['facts','packaging'].includes(node.id)?'textarea':'text'" :rows="3" :disabled="disabled" :placeholder="compact&&node.id==='facts'?'例如：黑银碳纹、仅壳款、黑色礼盒。只填写已确认的卖点和包装内容。':node.help||'填写产品信息'" @update:model-value="emit('update:modelValue',$event)"/>
</template>
<style scoped>
.workflow-upload-slots{display:flex;flex-wrap:wrap;gap:12px}.upload-slot{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:250px}.upload-slot>span{font-size:12px;color:var(--el-text-color-secondary)}.upload-slot .el-image{width:108px;height:144px;background:var(--el-fill-color-light);border-radius:8px}.upload-placeholder{display:grid;justify-items:center;gap:10px;padding:24px 20px;border:1px dashed var(--el-border-color);border-radius:8px;color:var(--el-text-color-secondary);background:var(--el-fill-color-lighter);min-width:180px;box-sizing:border-box}.upload-placeholder strong{font-size:14px;color:var(--el-color-primary)}.upload-placeholder span{font-size:12px}.is-compact .upload-slot{max-width:100%}.el-select{width:100%}
</style>
