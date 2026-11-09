export function workflowNodeSkipped(node,variant){
 return Boolean(node.requiresInput&&!variant.values[node.requiresInput]?.some(Boolean));
}
export const NO_KEY_REFERENCE_RULE='本次没有独立适配钥匙图片。不得从风格参考图提取、复制或推测裸钥匙、按键数量与适配结构。主图和其他详情不展示裸钥匙或适配对比卡片，保留产品主体与本分镜场景。文字只用已确认品牌型号，不声称已完成外形适配比对。';
