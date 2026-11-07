import {mysqlQuery,mysqlExecute} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {hasPermission} from '../shared/permissions.js';
import {PRODUCT_IDENTITY_FIELDS,PRODUCT_EDIT_SOURCES} from '../shared/product-edit-history.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';

const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const numeric=new Set(['id','inventory_number_version','product_quantity','is_accessory','is_consumable','package_weight_g','length_cm','width_cm','height_cm']);
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
let aliasSchemaReady=false;

// Reuse the existing search-alias table; this is its original schema, not a new
// history table. Call preparation only before a business transaction.
export async function ensureProductNameAliasSchema(execute=mysqlExecute){
 if(aliasSchemaReady)return;
 await execute(`CREATE TABLE IF NOT EXISTS product_name_aliases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED NOT NULL,
  alias_name VARCHAR(500) NOT NULL,alias_type VARCHAR(32) NOT NULL DEFAULT 'previous_name',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_name_alias (product_id,alias_name),
  KEY idx_product_name_alias_tenant_search (tenant_id,product_id,active,alias_name(191)),
  KEY idx_product_name_alias_search (product_id,active,alias_name(191)),
  CONSTRAINT fk_product_name_alias_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
 aliasSchemaReady=true;
}

export function productIdentitySnapshot(product={},components=[]){
 return Object.fromEntries(PRODUCT_IDENTITY_FIELDS.map(({key})=>{
  const value=product[key];
  if(key==='components')return[key,(Array.isArray(components)?components:[]).map(row=>({product_id:Number(row.product_id??row.component_product_id),quantity:Number(row.quantity),component_role:row.component_role==='gift'?'gift':'included'})).sort((a,b)=>a.product_id-b.product_id||a.component_role.localeCompare(b.component_role))];
  if(key==='vehicle_models_json'){const models=parse(value);return[key,Array.isArray(models)?models.filter(item=>typeof item==='string'):null];}
  if(value===null||value===undefined)return[key,null];
  return[key,numeric.has(key)?(Number.isFinite(Number(value))?Number(value):null):String(value)];
 }));
}

export async function readProductIdentity(query,scope,id,product=null){
 if(!product){
  const columns=PRODUCT_IDENTITY_FIELDS.filter(row=>row.key!=='components').map(row=>`p.${row.key}`).join(',');
  [product]=await query(`SELECT ${columns} FROM products p WHERE p.id=? AND ${inventoryTenantSql(scope,'p')}`,[id]);
  if(!product)throw fail('库存商品不存在或不属于当前企业',404);
 }
 const components=await query(`SELECT pc.component_product_id AS product_id,pc.quantity,pc.component_role
  FROM product_components pc JOIN products child ON child.id=pc.component_product_id AND ${inventoryTenantSql(scope,'child')}
  WHERE pc.product_id=? AND ${inventoryTenantSql(scope,'pc')} ORDER BY pc.component_product_id,pc.component_role`,[id]);
 return productIdentitySnapshot(product,components);
}

export async function recordProductEdit(query,scope,before,after,{personId=null,source='catalog_edit'}={}){
 if(!PRODUCT_EDIT_SOURCES[source]||before.id!==after.id)throw fail('库存编辑历史的商品或来源无效');
 const changed_fields=PRODUCT_IDENTITY_FIELDS.map(row=>row.key).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
 if(!changed_fields.length)return false;
 const oldName=String(before.name||'').trim();
 if(oldName&&oldName!==String(after.name||'').trim()){
  const [alias]=await query('SELECT tenant_id FROM product_name_aliases WHERE product_id=? AND alias_name=? LIMIT 1 FOR UPDATE',[before.id,oldName]);
  if(alias&&!(Number(alias.tenant_id)===scope.id||alias.tenant_id==null&&scope.isDefault))throw fail('原商品名称别名归属异常，请联系管理员核对后再编辑',409);
  // An existing disabled alias remains disabled; never change its owner/status.
  if(!alias)await query("INSERT INTO product_name_aliases(tenant_id,product_id,alias_name,alias_type,active) VALUES(?,?,?,'previous_name',1)",[scope.id,before.id,oldName]);
 }
 await query('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,before.id,personId,'product_edit',JSON.stringify({schema_version:1,source,before,after,changed_fields})]);
 return true;
}

function savedIdentity(value){
 const projected=productIdentitySnapshot(value,value.components);
 // A missing historical field is different from a recorded empty field.
 return Object.fromEntries(PRODUCT_IDENTITY_FIELDS.filter(({key})=>Object.hasOwn(value,key)).map(({key})=>[key,key==='components'&&!Array.isArray(value.components)?null:projected[key]]));
}

export function createProductEditHistory({query=mysqlQuery,authorize=authorizeBusinessTaskSession}={}){
 async function read(id,params={},session){
  const current=await authorize(session,query);
  if(!hasPermission(current,'inventory.read'))throw fail('查看库存编辑历史需要本企业库存查看权限',403);
  const scope=await resolveInventoryTenantScope(current.tenant.id,query),product=await assertInventoryRecord(scope,'product',id,query);
  const productId=Number(product.id),page=Number(params.page??1),requestedSize=Number(params.pageSize??20);
  if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(requestedSize)||requestedSize<1)throw fail('历史页码须为1至1000000的整数，每页条数须为正整数');
  const pageSize=Math.min(100,requestedSize);
  const where="e.tenant_id=? AND e.product_id=? AND e.action='product_edit'";
  const [identity,numbers,names,counts,events]=await Promise.all([
   readProductIdentity(query,scope,productId,product),
   query('SELECT alias_number,created_at FROM inventory_number_aliases WHERE product_id=? AND tenant_id=? ORDER BY created_at DESC,alias_number',[productId,scope.id]),
   query(`SELECT alias_name,alias_type,active,created_at FROM product_name_aliases WHERE product_id=? AND ${inventoryTenantSql(scope)} ORDER BY created_at DESC,id DESC`,[productId]),
   query(`SELECT COUNT(*) AS n FROM inventory_flow_events e WHERE ${where}`,[scope.id,productId]),
   query(`SELECT e.id,e.person_id,e.created_at,e.detail_json,actor.name AS actor_name FROM inventory_flow_events e
    LEFT JOIN people actor ON actor.id=e.person_id AND EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=e.tenant_id AND tm.person_id=actor.id)
    WHERE ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`,[scope.id,productId,pageSize,(page-1)*pageSize])
  ]);
  const rows=events.map(event=>{
   const saved=parse(event.detail_json),valid=saved?.before?.id===productId&&saved?.after?.id===productId;
   const before=valid?savedIdentity(saved.before):null,after=valid?savedIdentity(saved.after):null;
   const source=Object.hasOwn(PRODUCT_EDIT_SOURCES,saved?.source)?saved.source:'';
   return{id:Number(event.id),recorded_at:event.created_at,actor:{id:event.person_id==null?null:Number(event.person_id),name:event.actor_name||null},source,source_label:PRODUCT_EDIT_SOURCES[source]||'库存资料记录',before,after,changed_fields:valid?PRODUCT_IDENTITY_FIELDS.map(row=>row.key).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])):[],unavailable:!valid};
  });
  return{product_id:productId,current:identity,number_aliases:numbers.map(row=>({number:row.alias_number,recorded_at:row.created_at})),name_aliases:names.map(row=>({name:row.alias_name,type:row.alias_type,active:Number(row.active),recorded_at:row.created_at})),rows,total:Number(counts[0]?.n||0),page,pageSize,history_complete:false,
   history_notice:'编辑版本从本功能启用后的库存资料、核心品名编辑开始留存，仅覆盖身份资料和主档组成，不含库存数量、采购账或财务快照。旧编号、旧名称仅展示已有别名及其留存时间，不能据此配对或还原没有保存的历史版本。'};
 }
 return{read};
}

export const productEditHistory=createProductEditHistory().read;
