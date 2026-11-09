export function inventoryNumberTitle(value) {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(String(value || '').trim());
  if (match && (Number(match[1]) === 0 || Number(match[2]) === 0)) {
    return '核心品名或品牌待核对；完善商品资料后会重新发号，旧号仍可搜索';
  }
  return value ? '核心品名或品牌变更后会重新发号，旧号仍可搜索' : '请打开编辑库存，补齐核心品名、品牌与适配资料后保存';
}
