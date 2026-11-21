import { workflowNodeSkipped } from './workflow-conditions.js';

const outputTypes = new Set(['image', 'copy', 'video']);
export function workflowResultIgnored(state) { return state?.completionIgnored === true; }
const nonempty = value => typeof value === 'string' && Boolean(value.trim());

export function workflowNodeHasOutput(node, state) {
  if (workflowResultIgnored(state)) return false;
  if (node.type === 'image' || node.type === 'video') return nonempty(state?.url);
  if (node.type !== 'copy') return false;
  const keys = !node.target || node.target === 'bundle' ? ['title', 'tags', 'description'] : [node.target];
  return keys.every(key => key === 'tags'
    ? Array.isArray(state?.text?.tags) && state.text.tags.length > 0 && state.text.tags.every(nonempty)
    : nonempty(state?.text?.[key]));
}

export function workflowIncompleteNodes(payload) {
  return (payload.variants || []).flatMap(variant => (payload.definition?.nodes || [])
    .filter(node => outputTypes.has(node.type) && !workflowNodeSkipped(node, variant))
    .flatMap(node => {
      const state = payload.outputs?.[variant.id]?.[node.id];
      if (workflowResultIgnored(state) || workflowNodeHasOutput(node, state)) return [];
      const status = state?.status || 'blocked';
      const reason = state?.error || ({
        failed: '生成失败', cancelled: '生成已取消', unknown: '原任务结果待核对',
        reconciliation_required: '原任务结果待核对', queued: '尚在排队，未返回结果',
        running: '尚在生成，未返回结果', submitting: '提交结果尚未确认',
        resubmit: '正在核对原任务', provider_pending: '供应商尚未返回结果'
      }[status] || '尚未生成，前序节点可能未完成');
      return [{ variantId: variant.id, variantLabel: variant.label, nodeId: node.id,
        nodeLabel: node.label, nodeType: node.type, taskId: state?.taskId || '', status, reason }];
    }));
}
