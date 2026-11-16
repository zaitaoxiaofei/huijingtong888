<script setup>
import {computed} from 'vue';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import InventoryProductEditAction from './InventoryProductEditAction.vue';
const props=defineProps({row:{type:Object,required:true},kind:String,mobile:Boolean,viewOnly:Boolean,syncing:[Number,String]});
const emit=defineEmits(['open','sync','saved']);
const auth=useAuthStore(),canRead=computed(()=>hasPermission(auth.user,'inventory.read')),canWrite=computed(()=>hasPermission(auth.user,'inventory.write')),canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
</script>
<template>
 <div :class="viewOnly?'capital-view-actions':'capital-actions'">
  <template v-if="viewOnly&&row.product_id&&canRead">
   <el-button size="small" class="erp-btn erp-btn-secondary" @click="emit('open','details')">库存明细</el-button>
   <el-button size="small" class="erp-btn erp-btn-secondary" @click="emit('open','ledger','movements')">库存流水</el-button>
  </template>
  <template v-else-if="!viewOnly&&row.product_id">
   <InventoryProductEditAction v-if="canWrite" :product-id="Number(row.product_id)" :mobile="mobile" button-class="erp-btn erp-btn-secondary" @saved="emit('saved')"/>
   <el-button v-if="kind==='local'&&canWrite" size="small" class="erp-btn erp-btn-secondary" @click="emit('open','stocktake')">更新库存数量</el-button>
   <el-button v-if="canPurchase" size="small" class="erp-btn erp-btn-secondary" @click="emit('open','ledger','history')">补采购记录</el-button>
   <el-button v-if="kind==='transit'&&canPurchase" size="small" class="erp-btn erp-btn-secondary" @click="emit('open','receive')">验收入库</el-button>
   <el-button v-if="kind==='transit'&&!row.received_at&&canPurchase" size="small" class="erp-btn erp-btn-secondary" @click="emit('open','correction')">修改采购批次</el-button>
   <el-button v-if="kind==='fbp'&&canWrite" size="small" class="erp-btn erp-btn-secondary" :loading="syncing===row.row_id" :disabled="syncing!=null" @click="emit('sync')">同步官方数量</el-button>
  </template>
  <template v-else-if="!viewOnly&&canWrite&&kind==='fbp'">
   <el-button size="small" class="erp-btn erp-btn-secondary" @click="emit('open','bind')">绑定已有库存</el-button>
   <el-button size="small" class="erp-btn erp-btn-secondary" @click="emit('open','create')">创建库存并绑定</el-button>
  </template>
  <span v-else-if="!viewOnly">请有库存维护权限的人员核对绑定。</span>
 </div>
</template>
<style scoped>.capital-actions{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;align-items:center;width:100%}.capital-actions :deep(.el-button){margin:0;width:100%;justify-content:center}.capital-actions :deep(.el-button)+:deep(.el-button){margin:0}.capital-view-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.capital-view-actions :deep(.el-button){margin:0}</style>
