<script setup>
const props = defineProps({ modelValue: Boolean, purpose: { type: String, default: '套餐开通与续费' } });
const emit = defineEmits(['update:modelValue']);
</script>
<template>
  <el-dialog :model-value="props.modelValue" title="联系开通 · Beta 内测" width="min(430px, 94vw)" append-to-body destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <div class="beta-contact"><p>{{ props.purpose }}</p><img :src="'/support/beta-contact-wechat.jpg'" alt="扫码添加服务人员微信，联系开通或续费" width="296" height="377" /><p>使用微信扫码添加好友，备注企业名称和所需套餐。由服务人员确认价格、收款并开通授权或提供激活码。</p><small>内测期间暂不支持在线支付；扫码联系不会自动扣款或更改套餐。</small></div>
    <template #footer><el-button type="primary" @click="emit('update:modelValue', false)">知道了</el-button></template>
  </el-dialog>
</template>
<style scoped>.beta-contact{display:grid;gap:12px;text-align:center}.beta-contact img{max-width:100%;height:auto;display:block;margin:0 auto;background:white}.beta-contact p{margin:0;line-height:1.8;color:var(--erp-text-regular)}.beta-contact small{color:var(--erp-text-secondary);line-height:1.7}</style>
