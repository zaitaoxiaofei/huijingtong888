<script setup>
import { computed, ref } from 'vue';
import {workflowDictionaryOptions} from '../../../../src/shared/product-workflow-inputs.js';
import { ElMessage } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { apiClient } from '../../utils/api.js';
import { withImageToken } from '../../api/tools/imageCropper.js';
const props=defineProps({node:{type:Object,required:true},modelValue:{default:''},category:{type:Object,default:()=>({})},disabled:Boolean,compact:Boolean,dense:Boolean,multipleProducts:Boolean});
const emit=defineEmits(['update:modelValue','upload','upload-files','options']);
const loading=ref(false);
const dictionaryOptions=computed(()=>workflowDictionaryOptions(props.node.options||[],[],props.node.attributeId));
async function loadOptions(keyword='') {
  if(!props.node.dictionaryId||loading.value)return;
  loading.value=true;
  try {
    const params=new URLSearchParams({description_category_id:props.category.descriptionCategoryId,type_id:props.category.typeId,attribute_id:props.node.attributeId,limit:60,keyword});
    const rows=await apiClient.get(`/api/listing/ozon-attribute-values?${params}`,{noCache:true});
    emit('options',workflowDictionaryOptions(rows,props.node.options||[],props.node.attributeId));
  }catch(error){ElMessage.error(error.message);}finally{loading.value=false;}
}
function remove(index){const next=[...(props.modelValue||[])];next[index]='';emit('update:modelValue',next);}
function importProducts(files){if(!props.disabled&&files?.length)emit('upload-files',[...files]);}
function slotLabel(purpose,index){const text=String(purpose).split(/[：:，,；;。]/)[0].trim();return text.length>10?`${text.slice(0,10)}…`:text||`图片 ${index+1}`;}
</script>
<template>
  <div v-if="node.type==='images'" class="workflow-upload-slots" :class="{'is-compact':compact,'is-dense':dense}">
    <div v-for="(purpose,index) in node.slots" :key="index" class="upload-slot">
      <span v-if="dense||!compact||node.slots.length>1" class="upload-slot-label" :title="purpose">{{ index+1 }}. {{ dense?slotLabel(purpose,index):purpose }}</span>
      <div class="upload-slot-body">
        <el-image v-if="modelValue?.[index]" :src="withImageToken(modelValue[index])" :preview-src-list="modelValue.filter(Boolean).map(withImageToken)" :initial-index="modelValue.slice(0,index).filter(Boolean).length" preview-teleported :fit="dense?'cover':'contain'"/>
        <span v-else-if="dense&&disabled" class="upload-disabled-empty">无图</span>
        <div class="upload-slot-actions">
          <label v-if="!disabled&&multipleProducts&&index===0" class="product-upload-trigger" title="多选或拖入产品图片；第一张填入本卡片，其余分别添加产品" @dragover.prevent @drop.prevent.stop="importProducts($event.dataTransfer.files)">
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple :aria-label="`${node.label}，可批量选择产品图片`" @change="importProducts($event.target.files);$event.target.value=''"/>
            <span v-if="modelValue?.[index]" class="upload-replace">{{ dense?'替换 / 多图':'替换主图 / 批量添加' }}</span><div v-else class="upload-placeholder"><el-icon :size="dense?18:24"><Plus/></el-icon><strong>{{ dense?'上传多图':'选择图片 / 批量添加' }}</strong><span v-if="!dense">多选或拖入图片，每张新建一件产品</span></div>
          </label>
          <el-upload drag v-else-if="!disabled" accept="image/*" :auto-upload="false" :show-file-list="false" :on-change="file=>emit('upload',file.raw,index)" :aria-label="`${node.label} ${purpose}`">
            <el-button v-if="modelValue?.[index]" size="small" :link="dense">{{ dense?'替换':'替换图片' }}</el-button><div v-else class="upload-placeholder" :title="purpose"><el-icon :size="dense?18:24"><Plus/></el-icon><strong>{{ dense?'上传图片':'选择图片' }}</strong><span v-if="!dense">点击或拖入图片 · 支持 JPG、PNG</span></div>
          </el-upload>
          <el-button v-if="modelValue?.[index]&&!disabled" link type="danger" @click="remove(index)">移除</el-button>
        </div>
      </div>
    </div>
  </div>
  <el-select v-else-if="node.type==='attribute'&&node.dictionaryId" :model-value="modelValue" :multiple="node.multiple" filterable remote :remote-method="loadOptions" :loading="loading" :disabled="disabled" placeholder="选择已核实的属性值" @update:model-value="emit('update:modelValue',$event)" @visible-change="$event&&loadOptions()">
    <el-option v-for="option in dictionaryOptions" :key="option.id" :label="option.label" :value="option.id"/>
  </el-select>
  <el-input-number v-else-if="node.inputFormat==='number'" :model-value="modelValue===''||modelValue==null?undefined:Number(modelValue)" :controls="false" :disabled="disabled" placeholder="填写数字" @update:model-value="emit('update:modelValue',$event??'')"/>
  <el-input v-else :model-value="modelValue" :type="compact&&['facts','packaging'].includes(node.id)?'textarea':'text'" :rows="dense?2:3" :disabled="disabled" :placeholder="compact&&node.id==='facts'?'例如：黑银碳纹、仅壳款、黑色礼盒。只填写已确认的卖点和包装内容。':node.help||'填写产品信息'" @update:model-value="emit('update:modelValue',$event)"/>
</template>
<style scoped>
.workflow-upload-slots{display:flex;flex-wrap:wrap;gap:12px}.upload-slot{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:250px}.upload-slot>span{font-size:12px;color:var(--el-text-color-secondary)}.upload-slot .el-image{width:108px;height:144px;background:var(--el-fill-color-light);border-radius:8px}.upload-placeholder{display:grid;justify-items:center;gap:10px;padding:24px 20px;border:1px dashed var(--el-border-color);border-radius:8px;color:var(--el-text-color-secondary);background:var(--el-fill-color-lighter);min-width:180px;box-sizing:border-box}.upload-placeholder strong{font-size:14px;color:var(--el-color-primary)}.upload-placeholder span{font-size:12px}.is-compact .upload-slot{max-width:100%}.el-select,.el-input-number{width:100%}:deep(.el-upload-dragger){border:0;padding:0;background:transparent;width:auto}:deep(.el-upload-dragger.is-dragover){outline:2px solid var(--el-color-primary)}
.product-upload-trigger{position:relative;display:block;cursor:pointer}.product-upload-trigger input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.product-upload-trigger:focus-within{outline:2px solid var(--el-color-primary);outline-offset:2px;border-radius:8px}.upload-replace{display:block;border:1px solid var(--el-border-color);border-radius:4px;padding:5px 10px;text-align:center;font-size:12px;color:var(--el-text-color-regular)}
.upload-slot-body,.upload-slot-actions{display:contents}.is-dense{gap:8px 12px;align-items:flex-start}.is-dense .upload-slot{gap:4px;max-width:160px}.is-dense .upload-slot-label{font-size:11px;line-height:16px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.is-dense .upload-slot-body{display:flex;gap:6px;align-items:flex-start;min-height:84px}.is-dense .el-image{width:64px;height:84px;flex-shrink:0;border-radius:4px}.is-dense .upload-slot-actions{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0}.is-dense .upload-placeholder{width:88px;height:84px;min-width:88px;padding:10px 6px;gap:6px;align-content:center;border-radius:4px}.is-dense .upload-placeholder strong{font-size:12px;font-weight:400;white-space:nowrap}.is-dense .upload-replace{font-size:11px;line-height:18px;white-space:nowrap;padding:2px 5px}.is-dense .upload-slot-actions>.el-button{height:22px;margin:0;font-size:12px}.is-dense .upload-slot-actions :deep(.el-button){height:22px;padding:0;font-size:12px}.is-dense .upload-disabled-empty{display:grid;place-items:center;width:88px;height:84px;border-radius:4px;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);font-size:12px}
</style>
