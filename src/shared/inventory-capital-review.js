// Review filters describe evidence gaps; they never change stock or valuation.
export const INVENTORY_CAPITAL_REVIEWS = Object.freeze([
  {key:'cost',label:'采购成本待核',count:'missing_cost_count',help:'用于估值的采购单价未填写或小于等于0，请核对采购成本并编辑库存；这不代表缺少采购记录，不能直接认定为免费。',tab:'purchases'},
  {key:'location',label:'仓库归属待核',count:'unclassified_count',help:'部分历史出入库记录没有注明属于国内仓还是其他仓，请查看库存流水核对；这里不是指货架库位缺失。',tab:'movements'},
  {key:'availability',label:'库存数量待核',count:'availability_unknown_count',help:'先核对实物、待发订单、FBP锁定和安全保障规则；账面为负时请盘点，不能直接把未知数量当成零。',tab:'current',local:true},
  {key:'binding',label:'未绑定库存',count:'unmapped_count',help:'在SKU绑定中将平台SKU关联到正确库存商品，再返回本页刷新。',tab:'current'}
]);
export function inventoryCapitalReviewMatches(row,key){
  if(key==='all')return true;
  if(key==='cost')return Boolean(Number(row.cost_missing));
  if(key==='location')return Number(row.unclassified_movements)>0;
  if(key==='availability')return Boolean(row.availability_unknown);
  if(key==='binding')return !row.product_id;
  return false;
}
export function inventoryCapitalReviewItems(row){
  return INVENTORY_CAPITAL_REVIEWS.filter(item=>inventoryCapitalReviewMatches(row,item.key)).map(item=>({...item,
    detail:item.key==='cost'?`当前成本单价${row.unit_cost==null?'未填写':Number(row.unit_cost)+'元'}。${item.help}`:
      item.key==='location'?`有${Number(row.unclassified_movements)}条历史出入库记录未注明仓库。${item.help}`:
      item.key==='availability'&&Number(row.physical_quantity)<0?`账面实物为${row.physical_quantity}件。请仓库盘点后更新数量，再核对扣减与安全保障规则。`:item.help}));
}
