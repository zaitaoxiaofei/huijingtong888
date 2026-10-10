<script setup>
import { CircleCheck, ClipboardCheck, Edit3, Rocket, Trash2 } from "lucide-vue-next";

defineProps({
  mode: { type: String, default: "model" },
  done: { type: Number, default: 0 },
  target: { type: Number, default: 0 },
  canDelete: { type: Boolean, default: false },
  canComplete: { type: Boolean, default: true }
});

const emit = defineEmits(["complete", "drafts", "edit", "develop", "delete"]);
</script>

<template>
  <div class="task-scope-actions">
    <el-tooltip v-if="canComplete" content="标记完成" placement="top">
      <el-button circle type="success" plain :disabled="target > 0 && done >= target" :icon="CircleCheck" @click="emit('complete')" />
    </el-tooltip>
    <el-tooltip content="绑定草稿箱 / 记录进度" placement="top">
      <el-button circle :icon="ClipboardCheck" @click="emit('drafts')" />
    </el-tooltip>
    <el-tooltip :content="mode === 'task' ? '编辑任务' : '编辑车型目标'" placement="top">
      <el-button circle :icon="Edit3" @click="emit('edit')" />
    </el-tooltip>
    <el-tooltip content="去开发" placement="top">
      <el-button circle type="primary" plain :icon="Rocket" @click="emit('develop')" />
    </el-tooltip>
    <el-tooltip v-if="mode === 'task' && canDelete" content="删除任务" placement="top">
      <el-button circle type="danger" plain :icon="Trash2" @click="emit('delete')" />
    </el-tooltip>
  </div>
</template>

<style scoped>
.task-scope-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap}
.task-scope-actions :deep(.el-button.is-circle){width:32px;height:32px}
.task-scope-actions :deep(.el-button + .el-button){margin-left:0}
</style>
