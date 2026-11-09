import { createWorkflowNode } from '../../../src/shared/product-workflow.js';
import { isWorkflowInput } from '../../../src/shared/product-workflow-inputs.js';

export function createImageReference(node) {
  return {
    ...createWorkflowNode('images'), label: `${node.label} · 独立参考图`,
    scope: 'shared', valueSource: 'engineer', required: false,
    count: 1, slots: ['本张图片参考图（可选）'], defaultValue: [''], referenceRole: 'style'
  };
}

export function createIndependentImageNode(nodes) {
  const node = createWorkflowNode('image');
  node.label = '新图片';
  const reference = createImageReference(node);
  // Product facts and actual product/compatibility photos can be reused;
  // template style sheets and other shot references require explicit selection.
  node.inputs = nodes.filter(isWorkflowInput).filter(input => input.valueSource !== 'generated'
    && (input.type !== 'images' || ['product', 'compatibility'].includes(input.referenceRole))).map(input => input.id);
  node.inputs.push(reference.id);
  return { node, reference };
}
