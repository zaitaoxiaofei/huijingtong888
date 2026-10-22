import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parse } from "acorn";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const key = id => id === 1 ? "admin" : id;
const session = id => ({ personId: 7, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });

test("real FBP replenishment, transfers and PDF imports keep A/B/default inventory independent", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TENANT_TEST_MYSQL_SOCKET", timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture("fbp");
  let closeMysqlPool;
  const previousFetch = globalThis.fetch;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("External Ozon calls disabled in FBP fixture"); };
    const query = fixture.query;
    const service = await import("../src/services/mysql-cutover.js");
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    await query("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people(id,name,role) VALUES (7,'Applicant','admin'),(8,'Reviewer','admin'),(30,'Private B','admin')");
    for (const id of [1,2,3]) for (const person of [7,8]) await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (?,?,'admin',JSON_ARRAY('admin'))", [id,person]);
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (3,30,'admin',JSON_ARRAY('admin'))");
    await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id) VALUES (10,NULL,'Legacy','legacy'),(11,1,'Default','seller-1'),(20,2,'A','seller-2'),(30,3,'B','seller-3')");
    await service.warmCoreInventoryRuntimeMysql("admin");
    const entries = new Map();
    for (const [id, shop] of [[1,11],[2,20],[3,30],[1,10]]) {
      const product = await service.createProductMysql({ name: `FBP ${shop}`, purchase_cost: 1, owner_person_id: 7, created_by_person_id: 7 }, null, key(id));
      if (shop === 10) await query("UPDATE products SET tenant_id=NULL WHERE id=?", [product.id]);
      const mapping = await query("INSERT INTO sku_mappings(tenant_id,shop_id,product_id,ozon_sku,offer_id) VALUES (?,?,?,'OZN12345678','12345678')", [shop===10?null:id, shop, product.id]);
      await service.createInventoryMovementMysql({ product_id: product.id, quantity_delta: 30, source_type: "opening_stock", stock_location: "LOCAL" }, 7, key(id));
      entries.set(shop, { tenant: id, shop, product: product.id, mapping: mapping.insertId });
    }
    const create = async (entry, date="2026-10-01") => {
      const result = await service.createFbpReplenishmentOrdersMysql({ order_date: date, rows: [{ shop_id: entry.shop, ozon_sku: "OZN12345678", product_id: entry.product, mapping_id: entry.mapping, requested_qty: 5 }] }, 7, key(entry.tenant));
      return result.rows[0].id;
    };
    const orders = new Map();
    for (const entry of entries.values()) orders.set(entry.shop, await create(entry));

    await t.test("schema preparation has no global date repair and legacy order-date backfill stays in the current enterprise",async()=>{
      const seeds=[];
      for(const shop of[10,11,20,30]){
        const row=await query("INSERT INTO fbp_replenishment_orders(order_no,shop_id,created_at) VALUES (?,?,'2026-10-01 20:00:00')",[`legacy-date-${shop}`,shop]);
        seeds.push(row.insertId);
      }
      await service.fbpReplenishmentOrdersMysql({},2);
      let rows=await query("SELECT shop_id,DATE_FORMAT(order_date,'%Y-%m-%d') day FROM fbp_replenishment_orders WHERE id IN (?,?,?,?) ORDER BY shop_id",seeds);
      assert.deepEqual(rows.map(row=>[Number(row.shop_id),row.day]),[[10,null],[11,null],[20,'2026-10-02'],[30,null]]);
      await service.fbpReplenishmentOrdersMysql({},'admin');
      rows=await query("SELECT shop_id,DATE_FORMAT(order_date,'%Y-%m-%d') day FROM fbp_replenishment_orders WHERE id IN (?,?,?,?) ORDER BY shop_id",seeds);
      assert.deepEqual(rows.map(row=>[Number(row.shop_id),row.day]),[[10,'2026-10-02'],[11,'2026-10-02'],[20,'2026-10-02'],[30,null]]);
      await query("DELETE FROM fbp_replenishment_orders WHERE id IN (?,?,?,?)",seeds);
    });

    await t.test("draft, review, dispatch and partial receipt work for each enterprise including legacy NULL owners", async () => {
      for (const entry of entries.values()) {
        const orderId = orders.get(entry.shop), tenant = key(entry.tenant);
        await assert.rejects(service.updateFbpReplenishmentOrderStatusMysql({ id: orderId, status: "approved" }, 7, tenant), /申请人/);
        await service.updateFbpReplenishmentOrderStatusMysql({ id: orderId, status: "pending_review" }, 7, tenant);
        const approved = await service.updateFbpReplenishmentOrderStatusMysql({ id: orderId, status: "approved" }, 8, tenant);
        assert.equal(approved.reservedQuantity, 5);
        await service.updateFbpReplenishmentOrderStatusMysql({ id: orderId, status: "sent" }, 8, tenant);
        const [transfer] = await query("SELECT * FROM fbp_transfer_records WHERE source_type='fbp_replenishment' AND shop_id=?", [entry.shop]);
        assert.equal(Number(transfer.quantity), 5);
        await assert.rejects(service.confirmFbpTransferReceivedMysql({ id: transfer.id, confirm_all:true }, 8, entry.tenant===3?2:3), { statusCode:404 });
        const partial = await service.confirmFbpTransferReceivedMysql({ id: transfer.id, received_quantity:2, expected_listed_quantity:0 }, 8, tenant);
        assert.equal(partial.remaining_quantity, 3);
        await assert.rejects(service.confirmFbpTransferReceivedMysql({ id:transfer.id, confirm_all:true, expected_listed_quantity:0 },8,tenant), /已更新/);
        await service.confirmFbpTransferReceivedMysql({ id:transfer.id, confirm_all:true, expected_listed_quantity:2 },8,tenant);
        assert.equal((await query("SELECT status FROM fbp_replenishment_orders WHERE id=?",[orderId]))[0].status,"completed");
        const ledger = await query("SELECT tenant_id, SUM(CASE WHEN stock_location='LOCAL' AND COALESCE(movement_type,'') NOT IN ('ORDER_RESERVED','CANCEL_RESTORE') THEN quantity_delta ELSE 0 END) local_quantity FROM inventory_movements WHERE product_id=? GROUP BY tenant_id",[entry.product]);
        assert.deepEqual(ledger.map(row=>[Number(row.tenant_id),Number(row.local_quantity)]),[[entry.tenant,25]]);
      }
      for (const id of [1,2,3]) {
        const result=await service.fbpReplenishmentOrdersMysql({},key(id));
        assert.ok(result.rows.length);
        assert.ok(result.rows.every(row=>entries.get(Number(row.shop_id))?.tenant===id));
        const transfers=await service.fbpTransferRecordsMysql({},key(id));
        assert.ok(transfers.rows.every(row=>entries.get(Number(row.shop_id))?.tenant===id));
      }
    });

    await t.test("foreign IDs, actors and mapping substitutions fail before inventory writes",async()=>{
      const a=entries.get(20),b=entries.get(30), before=await query("SELECT COUNT(*) n FROM inventory_movements");
      await assert.rejects(service.createFbpTransferRecordMysql({product_id:b.product,shop_id:b.shop,mapping_id:b.mapping,quantity:2},7,2));
      await assert.rejects(service.createFbpTransferRecordMysql({product_id:a.product,shop_id:a.shop,mapping_id:b.mapping,quantity:2},7,2));
      await assert.rejects(service.createFbpTransferRecordMysql({product_id:a.product,shop_id:a.shop,mapping_id:a.mapping,person_id:30,quantity:2},7,2));
      await assert.rejects(service.createFbpReplenishmentOrdersMysql({rows:[{shop_id:b.shop,ozon_sku:"OZN12345678"}]},7,"admin"));
      await assert.rejects(service.createFbpReplenishmentOrdersMysql({rows:[{shop_id:a.shop,ozon_sku:"OZN12345678"}]},30,2));
      assert.deepEqual(await query("SELECT COUNT(*) n FROM inventory_movements"),before);
      for(const entry of entries.values()){
        const transfer=await service.createFbpTransferRecordMysql({product_id:entry.product,shop_id:entry.shop,mapping_id:entry.mapping,quantity:2,listed_quantity:1,person_id:8},7,key(entry.tenant));
        const result=await service.confirmFbpTransferReceivedMysql({id:transfer.id,confirm_all:true,expected_listed_quantity:1},8,key(entry.tenant));
        assert.equal(result.received_quantity,1);
        assert.equal(result.remaining_quantity,0);
      }
    });

    await t.test("printing is idempotent within owned details and warehouse totals reject poisoned foreign facts",async()=>{
      const {loadWarehouseFacts}=await import("../src/services/fbp-warehouse.js");
      const {resolveInventoryTenantScope}=await import("../src/services/inventory-tenant-scope.js");
      for(const entry of entries.values()){
        const orderId=orders.get(entry.shop);
        const[item]=await query("SELECT id FROM fbp_replenishment_order_items WHERE order_id=?",[orderId]);
        const body={order_id:orderId,item_id:item.id,quantity:7,preparation_quantity:5,request_key:`tenant-print-${entry.shop}-000001`};
        assert.equal((await service.markFbpReplenishmentItemBarcodePrintedMysql(body,7,key(entry.tenant))).barcode_printed_qty,7);
        assert.equal((await service.markFbpReplenishmentItemBarcodePrintedMysql(body,7,key(entry.tenant))).duplicate,true);
        await assert.rejects(service.markFbpReplenishmentItemBarcodePrintedMysql(body,7,entry.tenant===3?2:3));
        const history=await service.fbpReplenishmentOrdersMysql({print_item_id:item.id},key(entry.tenant));
        assert.equal(history.print_records.length,1);
        assert.equal((await service.fbpReplenishmentOrdersMysql({print_item_id:item.id},entry.tenant===3?2:3)).print_records.length,0);
        const baseline=await loadWarehouseFacts(query,[entry.product],"stock_location='LOCAL'",await resolveInventoryTenantScope(key(entry.tenant)));
        const foreign=entry.tenant===3?2:3;
        const movement=await query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,status,stock_location,source_type) VALUES (?,?,999,'posted','LOCAL','opening_stock')",[foreign,entry.product]);
        const inbound=await query("INSERT INTO inbound_records(tenant_id,product_id,quantity,status) VALUES (?,?,999,'pending_arrival')",[foreign,entry.product]);
        const transfer=await query("INSERT INTO fbp_transfer_records(product_id,shop_id,ozon_sku,quantity,status,shipped_at) VALUES (?,?,'FOREIGN',999,'sent',CURRENT_TIMESTAMP)",[entry.product,foreign===3?30:20]);
        const result=await service.fbpReplenishmentOrdersMysql({inventory:'1'},key(entry.tenant));
        const own=result.rows.find(row=>Number(row.id)===orderId).items[0];
        assert.equal(own.warehouse.ledger_stock,baseline.get(entry.product).ledger_stock);
        assert.equal(own.warehouse.procurement_incoming,baseline.get(entry.product).procurement_incoming);
        assert.equal(own.warehouse.fbp_pending,baseline.get(entry.product).fbp_pending);
        await query("DELETE FROM inventory_movements WHERE id=?",[movement.insertId]);
        await query("DELETE FROM inbound_records WHERE id=?",[inbound.insertId]);
        await query("DELETE FROM fbp_transfer_records WHERE id=?",[transfer.insertId]);
      }
    });

    await t.test("cancel restores only the owned reservation despite poisoned foreign source references",async()=>{
      const a=entries.get(20),b=entries.get(30),id=await create(a,"2026-10-02");
      await service.updateFbpReplenishmentOrderStatusMysql({id,status:"approved"},8,2);
      const [item]=await query("SELECT id FROM fbp_replenishment_order_items WHERE order_id=?",[id]);
      const ref=`fbp_replenishment:${id}:${item.id}`;
      const foreign=await query("INSERT INTO inventory_movements(tenant_id,product_id,shop_id,sku_mapping_id,quantity_delta,source_type,source_ref,status,movement_type) VALUES (3,?,?,?,999,'fbp_replenishment_reserve',?,'posted','ORDER_RESERVED')",[b.product,b.shop,b.mapping,`${ref}:reserve`]);
      const transfer=await query("INSERT INTO fbp_transfer_records(product_id,mapping_id,shop_id,ozon_sku,quantity,status,source_type,source_ref) VALUES (?,?,?,'OZN12345678',999,'sent','fbp_replenishment',?)",[b.product,b.mapping,b.shop,ref]);
      const before=await query("SELECT id,quantity_delta,source_type FROM inventory_movements WHERE product_id=? ORDER BY id",[b.product]);
      const cancelled=await service.updateFbpReplenishmentOrderStatusMysql({id,status:"cancelled"},8,2);
      assert.equal(cancelled.outboundQuantity,5);
      assert.deepEqual(await query("SELECT id,quantity_delta,source_type FROM inventory_movements WHERE product_id=? ORDER BY id",[b.product]),before);
      assert.equal((await query("SELECT status FROM fbp_transfer_records WHERE id=?",[transfer.insertId]))[0].status,"sent");
      await query("DELETE FROM inventory_movements WHERE id=?",[foreign.insertId]);
      await query("DELETE FROM fbp_transfer_records WHERE id=?",[transfer.insertId]);
    });

    await t.test("batch preview and result registration ignore poisoned foreign members and reject foreign SKU results",async()=>{
      const a=entries.get(20),a1=await create(a,"2026-10-03"),a2=await create(a,"2026-10-04");
      for(const id of[a1,a2])await service.updateFbpReplenishmentOrderStatusMysql({id,status:"approved"},8,2);
      const batch=await service.linkFbpReplenishmentOrdersMysql({order_ids:[a1,a2]},8,2);
      await query("INSERT INTO fbp_replenishment_batch_members(batch_id,order_id) VALUES (?,?)",[batch.id,orders.get(30)]);
      await query("UPDATE fbp_replenishment_orders SET status='sent' WHERE id=?",[orders.get(30)]);
      const preview=await service.fbpReplenishmentBatchFillPreviewMysql({batchId:batch.id},2);
      assert.equal(preview.batch.order_count,2);
      assert.equal(preview.items[0].final_qty,10);
      await assert.rejects(service.fbpReplenishmentBatchFillPreviewMysql({batchId:batch.id},"admin"));
      await assert.rejects(service.recordFbpReplenishmentBatchFillMysql({batch_id:batch.id,results:[{sku:"PRIVATE-B",quantity:9,success:false}]},8,2));
      await service.recordFbpReplenishmentBatchFillMysql({batch_id:batch.id,results:[{sku:"OZN12345678",quantity:3,success:true}]},8,2);
      assert.equal((await service.fbpReplenishmentBatchFillPreviewMysql({batchId:batch.id},2)).items[0].pending_qty,7);
    });

    await t.test("PDF mapping, same external IDs, reimports and actor revocation use fresh session ownership",async()=>{
      const url=new URL("../src/services/fbp-supply-pdf-import.js",import.meta.url);
      let source=readFileSync(url,"utf8");
      const declarations=parse(source,{ecmaVersion:"latest",sourceType:"module"}).body.filter(node=>node.type==="ImportDeclaration");
      const globals={console,process,Buffer,Date,Set,Map,URL};
      for(const declaration of declarations){
        const name=declaration.source.value,module=await import(name.startsWith(".")?new URL(name,url).href:name);
        for(const binding of declaration.specifiers)globals[binding.local.name]=binding.type==="ImportDefaultSpecifier"?module.default:module[binding.imported.name];
      }
      for(const declaration of declarations.reverse())source=source.slice(0,declaration.start)+source.slice(declaration.end);
      const context=vm.createContext(globals);
      vm.runInContext(source.replaceAll("export ",""),context);
      let parserCalls=0, seller="";
      context.parseFbpSupplyPdf=async()=>{parserCalls++;return{header:{supply_order_id:"same-supply",seller_id:seller},items:[{ozon_sku:"OZN12345678",sku_number:"12345678",quantity:4}],checks:{total_quantity_matched:true}};};
      const body={pdf_base64:Buffer.from("%PDF-fixture").toString("base64")};
      await assert.rejects(context.previewFbpSupplyPdfMysql({...body,shop_id:30},session(2)));
      assert.equal(parserCalls,0);
      for(const[id,shop]of[[1,11],[2,20],[3,30]]){
        seller=`seller-${id}`;
        const result=await context.importFbpSupplyPdfMysql({...body,shop_id:shop,tenant_id:"3"},30,session(id));
        assert.equal(result.inserted,1);
        assert.equal(Number(result.preview.items[0].product_id),entries.get(shop).product);
        const repeat=await context.importFbpSupplyPdfMysql({...body,shop_id:shop},30,session(id));
        assert.equal(repeat.updated,1);
      }
      const rows=await query("SELECT shop_id,person_id FROM fbp_transfer_records WHERE source_type='seller_fbp_supply_pdf' ORDER BY shop_id");
      assert.deepEqual(rows.map(row=>[Number(row.shop_id),Number(row.person_id)]),[[11,7],[20,7],[30,7]]);
      await query("UPDATE fbp_transfer_records SET listed_quantity=2,status='received' WHERE shop_id=20 AND source_type='seller_fbp_supply_pdf'");
      seller="seller-2";
      await context.importFbpSupplyPdfMysql({...body,shop_id:20},30,session(2));
      assert.equal(Number((await query("SELECT listed_quantity FROM fbp_transfer_records WHERE shop_id=20 AND source_type='seller_fbp_supply_pdf'"))[0].listed_quantity),2);
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7");
      const calls=parserCalls;
      await assert.rejects(context.importFbpSupplyPdfMysql({...body,shop_id:20},7,session(2)),{statusCode:403});
      assert.equal(parserCalls,calls);
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7");
    });

    await t.test("draft edits, merging, allocation, adjustments and shortage procurement retain their enterprise",async()=>{
      for(const[id,shop]of[[1,11],[2,20],[3,30]]){
        const entry=entries.get(shop),tenant=key(id),foreign=id===3?2:3;
        const first=await create(entry,'2026-11-01'),second=await create(entry,'2026-11-02');
        let[item]=await query("SELECT id FROM fbp_replenishment_order_items WHERE order_id=?",[first]);
        await assert.rejects(service.updateFbpReplenishmentOrderItemsMysql({order_id:first,items:[{id:item.id,requested_qty:99}]},key(foreign)));
        await service.updateFbpReplenishmentOrderItemsMysql({order_id:first,items:[{id:item.id,requested_qty:4}]},tenant);
        await service.mergeFbpReplenishmentOrdersMysql({order_ids:[first,second],target_order_id:first},7,tenant);
        [item]=await query("SELECT id,approved_qty FROM fbp_replenishment_order_items WHERE order_id=?",[first]);
        assert.equal(Number(item.approved_qty),9);
        await service.saveFbpReplenishmentInventoryAllocationMysql({inventory_key:String(entry.product),reason:'Fixture allocation',items:[{item_id:item.id,order_id:first,final_qty:8,expected_final_qty:9}],allow_shortage:true},8,tenant);
        await service.updateFbpReplenishmentOrderStatusMysql({id:first,status:'approved'},8,tenant);
        const adjusted=await service.addFbpReplenishmentItemAdjustmentMysql({order_id:first,item_id:item.id,adjustment_qty:-2,reason_code:'stock_shortage',reason_note:'Fixture shortage'},8,tenant);
        assert.equal(adjusted.final_qty,6);
        const changes=await service.fbpReplenishmentItemAdjustmentsMysql({order_id:first,item_id:item.id},tenant);
        assert.equal(Number(changes[0].procurement_request_id),adjusted.procurement_request_id);
        await assert.rejects(service.fbpReplenishmentItemAdjustmentsMysql({order_id:first,item_id:item.id},key(foreign)));
        await service.updateFbpReplenishmentItemAdjustmentReasonMysql({adjustment_id:changes[0].id,reason_code:'stock_shortage',reason_note:'Confirmed fixture shortage'},8,tenant);
        const drafts=await service.fbpShortageProcurementDraftsMysql(tenant);
        const own=drafts.find(row=>Number(row.product_id)===entry.product);
        assert.ok(own.request_ids.includes(adjusted.procurement_request_id));
        assert.ok(drafts.every(row=>[...entries.values()].some(value=>value.product===Number(row.product_id)&&value.tenant===id)));
        await assert.rejects(service.submitFbpShortageProcurementDraftsMysql({items:[{request_ids:own.request_ids,quantity:2}]},8,key(foreign)));
        await service.submitFbpShortageProcurementDraftsMysql({items:[{request_ids:own.request_ids,quantity:2}]},8,tenant);
        assert.equal((await query("SELECT tenant_id,status FROM procurement_requests WHERE id=?",[adjusted.procurement_request_id]))[0].status,'submitted');
        await service.ignoreFbpReplenishmentMysql({shop_id:shop,product_id:entry.product,mapping_id:entry.mapping,ozon_sku:'OZN12345678'},7,tenant);
        await assert.rejects(service.restoreFbpReplenishmentMysql({shop_id:shop,ozon_sku:'OZN12345678'},key(foreign)));
        await service.restoreFbpReplenishmentMysql({shop_id:shop,ozon_sku:'OZN12345678'},tenant);
        const left=await create(entry,'2026-11-03'),right=await create(entry,'2026-11-04');
        const linked=await service.linkFbpReplenishmentOrdersMysql({order_ids:[left,right]},7,tenant);
        assert.equal(linked.order_count,2);
        await service.unlinkFbpReplenishmentOrderMysql({order_id:left},tenant);
        await service.deleteFbpReplenishmentOrderMysql({id:left},7,tenant);
        const[detail]=await query("SELECT id FROM fbp_replenishment_order_items WHERE order_id=?",[right]);
        assert.equal((await service.deleteFbpReplenishmentOrderItemMysql({order_id:right,item_id:detail.id},7,tenant)).order_deleted,true);
      }
    });

    await t.test("online product updates and edit drafts reject foreign ownership before external fetch",async()=>{
      for(const entry of entries.values())await query("INSERT INTO online_products(id,shop_id,product_id,ozon_sku,name) VALUES (?,?,?,'OZN12345678',?)",[entry.shop,entry.shop,entry.product,`Online ${entry.shop}`]);
      await assert.rejects(service.updateOnlineProductMysql(30,{name:"forged"},"admin"),{statusCode:404});
      await assert.rejects(service.updateOnlineProductMysql(20,{product_id:entries.get(30).product},2),{statusCode:404});
      await assert.rejects(service.onlineProductEditDraftMysql(30,2),{statusCode:404});
      await assert.rejects(service.onlineProductEditDraftMysql(20,"admin"),{statusCode:404});
      const updated=await service.updateOnlineProductMysql(20,{name:"Own A"},2);
      assert.equal((await query("SELECT name FROM online_products WHERE id=?",[updated.id]))[0].name,"Own A");
      assert.equal((await query("SELECT name FROM online_products WHERE id=30"))[0].name,"Online 30");
      const calls=[];
      await query("UPDATE shops SET api_key_hint='fixture-only-key' WHERE id IN (11,20,30)");
      globalThis.fetch=async(url,options)=>{
        calls.push({url:String(url),client:options.headers["Client-Id"]});
        return{ok:true,status:200,text:async()=>JSON.stringify({result:[{id:123,offer_id:'12345678',name:'Live own item',attributes:[],images:[]}]})};
      };
      for(const[id,onlineId]of[[1,11],[2,updated.id],[3,30]]){
        const draft=await service.onlineProductEditDraftMysql(onlineId,key(id));
        assert.equal(draft.shop_id,id===1?11:id===2?20:30);
        assert.equal(calls.at(-1).client,`seller-${id}`);
      }
      const n=calls.length;
      await assert.rejects(service.onlineProductEditDraftMysql(30,2));
      assert.equal(calls.length,n);
      globalThis.fetch=async()=>{throw new Error("External Ozon calls disabled in FBP fixture");};
    });

    await t.test("stock synchronization uses only owned Ozon credentials and cannot auto-confirm transfer receipts",async()=>{
      const calls=[];
      const before=await query("SELECT id,listed_quantity,status FROM fbp_transfer_records ORDER BY id");
      globalThis.fetch=async(url,options)=>{
        calls.push({url:String(url),client:options.headers["Client-Id"]});
        assert.ok(String(url).endsWith('/v4/product/info/stocks'));
        return{ok:true,status:200,text:async()=>JSON.stringify({result:{items:[{product_id:123,offer_id:'12345678',sku:'OZN12345678',stocks:[{type:'fbp',warehouse_id:'w1',warehouse_name:'FBP',present:10,reserved:0}]}]}})};
      };
      for(const[id,shop]of[[1,11],[2,20],[3,30]]){
        const n=calls.length;
        await service.syncOzonStocksMysql({shop_id:shop,tenant_id:3},{tenantId:key(id)});
        assert.ok(calls.length>n);
        assert.ok(calls.slice(n).every(call=>call.client===`seller-${id}`));
      }
      assert.deepEqual(await query("SELECT id,listed_quantity,status FROM fbp_transfer_records ORDER BY id"),before);
      const n=calls.length;
      await assert.rejects(service.syncOzonStocksMysql({shop_id:30},{tenantId:'admin'}));
      assert.equal(calls.length,n);
      const snapshots=await query("SELECT DISTINCT shop_id FROM ozon_stock_snapshots ORDER BY shop_id");
      assert.deepEqual(snapshots.map(row=>Number(row.shop_id)),[11,20,30]);
      globalThis.fetch=async()=>{throw new Error("External Ozon calls disabled in FBP fixture");};
    });
  } finally {
    globalThis.fetch=previousFetch;
    if(closeMysqlPool)await closeMysqlPool();
    await fixture.cleanup();
  }
});
