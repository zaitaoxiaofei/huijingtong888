export const PROCUREMENT_PRICE_REASONS=['供应商涨价','采购数量较少','临时加急采购','更换供应商','商品规格或质量升级','包含额外商品或服务','历史价格不准确','其他原因'];
export function procurementPriceReason(row={}){
 const reason=String(row.anomaly_reason||'').trim();
 if(reason!=='其他原因')return reason;
 const note=String(row.anomaly_note||'').trim();
 if(!note)throw new Error('选择其他原因时，请填写具体的价格变动说明');
 return `${reason}：${note}`;
}

export function markProcurementPriceException(error,rows=[]){
 const detail=error?.payload?.validation;
 if(detail?.field!=='items.anomaly_reason')return -1;
 const index=rows.findIndex(row=>Number(row.product_id)===Number(detail.product_id));
 if(index<0)return -1;
 rows[index].price_confirmation_required=true;
 if(Number(detail.reference_unit_cost)>0)rows[index].historical_unit_cost=Number(detail.reference_unit_cost);
 return index;
}
