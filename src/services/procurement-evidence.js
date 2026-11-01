const fail = message => Object.assign(new Error(message), {statusCode:400});
export function receiptEvidence(body = {}) {
  const result = {};
  for (const key of ['courier_company','tracking_number']) if (body[key] !== undefined) {
    const value=String(body[key]||'').trim();
    if(value.length>128||/[\x00-\x1f]/.test(value))throw fail('快递公司和快递单号最多128字，不能包含换行');
    result[key]=value;
  }
  if(body.receipt_images_json!==undefined){
    if(!Array.isArray(body.receipt_images_json)||body.receipt_images_json.length>6)throw fail('每个批次最多上传6张到货照片');
    const urls=body.receipt_images_json.map(value=>String(value||'').trim());
    if(urls.some(url=>!/^\/uploads\/team-attachments\/[A-Za-z0-9_.\-\u4e00-\u9fff]+$/.test(url)))throw fail('请使用本企业上传的照片，不能填写外部或其他类型的附件地址');
    result.receipt_images_json=[...new Set(urls)];
  }
  return result;
}
export async function assertEvidenceOwnership(urls, tenantId, query) {
  for(const url of urls||[]){
    const name=url.slice('/uploads/team-attachments/'.length);
    const [file]=await query("SELECT id FROM tenant_private_files WHERE tenant_id=? AND storage_name=? AND purpose='team' AND content_type IN ('image/jpeg','image/png','image/webp','image/gif') LIMIT 1",[Number(tenantId),name]);
    if(!file)throw Object.assign(new Error('照片不存在、不属于当前企业或不是图片，请重新上传'),{statusCode:403});
  }
}
export async function mobilePurchaseEvidence(body, tenantId, query) {
  if(body.mobile_input!==true)return body;
  const evidence=receiptEvidence({receipt_images_json:body.receipts||[]});
  await assertEvidenceOwnership(evidence.receipt_images_json,tenantId,query);
  const order=String(body.platform_order_no||'').trim();
  if(order.length>128||/[\x00-\x1f]/.test(order))throw fail('采购订单号最多128字，不能包含换行');
  const logistics=receiptEvidence(body);
  const note=[String(body.note||'').trim(),order?`平台订单号：${order}`:'',evidence.receipt_images_json.length?`采购凭证：${evidence.receipt_images_json.join('，')}`:''].filter(Boolean).join('\n');
  return {...body,note,receipts:evidence.receipt_images_json,shipments:order||logistics.tracking_number?[{platform_order_no:order,tracking_number:logistics.tracking_number||'',carrier_name:logistics.courier_company||''}]:[]};
}
