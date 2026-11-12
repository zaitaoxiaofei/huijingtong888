<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../admin/utils/api.js';
const props=defineProps({row:{type:Object,required:true}}),emit=defineEmits(['close','changed']);
const loading=ref(false),context=ref(null),amount=ref(1),busy=ref(false);
async function load(){const scope=currentApiCacheScope();loading.value=true;try{const value=await apiClient.get(`/api/wb/supply?order_id=${props.row.id}`,{noCache:true});if(scope===currentApiCacheScope())context.value=value;}catch(error){ElMessage.error(error.message);}finally{loading.value=false;}}
async function act(action){
  if(busy.value)return;
  if(action==='handover'){try{await ElMessageBox.confirm('请确认本批次所有订单已装箱，订单面单及运输箱标签已贴好。提交后无法继续向此批次加单；实际揽收以后续 WB 状态为准。','确认交接',{type:'warning'});}catch{return;}}
  busy.value=true;
  try{const result=await apiClient.post('/api/wb/supply/action',{order_id:props.row.id,action,amount:amount.value});
    if(action==='box-labels'||action==='supply-label'){
      const files=(result.stickers||[result]).map(item=>item.file).filter(Boolean);
      if(!files.length)throw new Error('WB 未返回可打印的标签，请刷新后核对。');
      const popup=window.open('','_blank');if(!popup)throw new Error('请允许本站打开打印窗口。');
      popup.document.title='WB 交接标签';
      const button=popup.document.createElement('button');button.textContent='打印标签';button.onclick=()=>popup.print();popup.document.body.append(button);
      for(const file of files){const image=popup.document.createElement('img');image.src=`data:image/png;base64,${file}`;image.style.cssText='display:block;max-width:100%;margin:12px 0;break-after:page';popup.document.body.append(image);}
    }else{ElMessage.success(result.message||'操作已完成');emit('changed');await load();}
  }catch(error){ElMessage.error(error.message);}finally{busy.value=false;}
}
onMounted(load);
</script>
<template>
  <el-dialog :model-value="true" title="WB 揽收交接" width="min(700px,94vw)" destroy-on-close @close="emit('close')">
    <div v-loading="loading"><p>店铺：{{row.shop_name}}　供货批次：{{context?.supply_id||row.wb_supply_id}}</p>
      <el-alert title="订单面单、运输箱标签、供货批次二维码用途不同。提交交接不代表承运商已实际接收。" type="info" :closable="false"/>
      <p>批次状态：{{context?.details?.done?'已提交交接':'待装箱交接'}}　已有运输箱：{{context?.boxes?.trbxes?.length||0}}</p>
      <el-alert v-if="context?.handover_mode==='unverified'" title="尚未核对揽收点交接要求，请先在企业店铺中配置。" type="warning" :closable="false"/>
      <el-form v-if="context?.handover_mode==='shipping_units'" inline><el-form-item label="新增运输箱"><el-input-number v-model="amount" :min="1" :max="1000" :precision="0"/></el-form-item><el-form-item><el-button :disabled="busy||context?.details?.done" @click="act('boxes')">创建运输箱</el-button></el-form-item></el-form>
      <el-button v-if="context?.handover_mode==='shipping_units'" :disabled="busy" @click="act('box-labels')">打印箱标签</el-button>
      <el-button v-if="context?.details?.done" :disabled="busy" @click="act('supply-label')">打印批次二维码</el-button>
      <p>报关单号、商品必填标识或账号专属交接要求，以 WB 后台提示为准；缺少这些资料时，平台可能阻止面单或交接。</p>
    </div>
    <template #footer><el-button @click="load" :disabled="busy">刷新状态</el-button><el-button @click="emit('close')">关闭</el-button><el-button type="primary" :loading="busy" :disabled="loading||!context||context.handover_mode==='unverified'||context.details?.done" @click="act('handover')">确认交接</el-button></template>
  </el-dialog>
</template>
