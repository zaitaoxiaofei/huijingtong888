import {hasPermission} from '../shared/permissions.js';
import {effectiveTenantMembershipRole} from './tenant-membership-authority.js';
import {broadcastGlobalEvent} from '../server/notifications.js';

export function inventoryRequestRecipient(row,tenant){
 const subject={roles:row.business_roles_json??row.roles_json??row.role,tenant:{id:tenant.id,role:effectiveTenantMembershipRole({...row,legacy_role:row.role,tenant_slug:tenant.isDefault?'default':row.tenant_slug})}};
 return hasPermission(subject,'inventory.review');
}

// Persist the inbox entry in the same transaction as its application state.
export async function writeInventoryProductRequestNotices(connection,tenant,row){
 const pending=row.status==='pending',route=`/inventory/product-requests?requestId=${Number(row.id)}`;
 if(!pending)await connection.execute("UPDATE system_notifications SET status='resolved',read_at=COALESCE(read_at,CURRENT_TIMESTAMP),resolved_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND entity_type='inventory_product_request' AND entity_id=? AND notification_type='inventory_product_request' AND status<>'resolved'",[tenant.id,String(row.id)]);
 const [members]=await connection.query('SELECT p.id,p.role,p.roles_json,tm.role AS tenant_role,tm.business_roles_json,t.slug AS tenant_slug FROM tenant_members tm JOIN people p ON p.id=tm.person_id AND p.active=1 JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=? AND tm.active=1',[tenant.id]);
 const payload=typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json;
 const targets=[];
 for(const member of members){
  const reviewer=inventoryRequestRecipient(member,tenant),own=Number(member.id)===Number(row.applicant_id);
  if(pending?!reviewer&&!own:!own)continue;
  const title=pending?(reviewer?'库存申请待审核':'库存申请已提交'):row.status==='approved'?'库存申请已通过':'库存申请已退回';
  const content=`申请 #${row.id} · ${payload.name||'库存建品'} · ${row.applicant_name||'申请人'}${row.status==='returned'?`；退回原因：${row.review_note}`:''}`;
  const [inserted]=await connection.execute("INSERT IGNORE INTO system_notifications(tenant_id,recipient_person_id,notification_type,title,content,severity,route,entity_type,entity_id,dedupe_key,status) VALUES(?,?,?,?,?,?,?,'inventory_product_request',?,?,'unread')",[tenant.id,member.id,pending?'inventory_product_request':'inventory_product_request_result',title,content,pending?'warning':row.status==='approved'?'info':'warning',route,String(row.id),`${tenant.id}:inventory-request:${row.id}:${row.revision}:${member.id}`]);
  if(Number(inserted.affectedRows)>0)targets.push({personId:Number(member.id),title,message:content,route});
 }
 return targets;
}

export function publishInventoryProductRequestNotices(tenantId,targets=[]){
 for(const target of targets)void broadcastGlobalEvent('system-notification',{refresh:true,type:'inventory_product_request',title:target.title,message:target.message,route:target.route},{tenantId,personId:target.personId});
 void broadcastGlobalEvent('system-notification',{refresh:true},{tenantId});
 // Counts are derived from request state, independently of notification read state.
 void broadcastGlobalEvent('inventory-product-request',{refresh:true},{tenantId});
}
