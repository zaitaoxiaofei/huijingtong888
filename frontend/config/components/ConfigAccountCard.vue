<script setup>
defineProps({
  account: {
    type: Object,
    default: () => ({ name: "-", role: "-" })
  }
});

const emit = defineEmits(["change-password"]);
</script>

<template>
  <section class="ds-card vue-config-account-card">
    <div class="ds-card-header">
      <h2>当前账号</h2>
      <div class="ds-card-actions">
        <button type="button" class="ds-btn ds-btn-primary ds-btn-small" @click="emit('change-password')">修改密码</button>
      </div>
    </div>
    <div class="ds-card-body vue-config-account-body">
      <label class="ds-field">
        <span>当前用户</span>
        <input class="ds-input" :value="account.name" readonly />
      </label>
      <label class="ds-field">
        <span>角色</span>
        <input class="ds-input" :value="account.role" readonly />
      </label>
    </div>
  </section>
</template>
