import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";

const dir = "pdd-invoice-assistant/";
const core = fs.readFileSync(dir + "core.js", "utf8");
const reader = fs.readFileSync(dir + "page-reader.js", "utf8").replaceAll("export function", "function");
const worker = fs.readFileSync(dir + "background.js", "utf8").replace(/^import .*;\n/gm, "");
const coreContext = vm.createContext({URL, Intl, Date});
vm.runInContext(core, coreContext);
const C = coreContext.PddInvoice;
const orderUrl = id => `https://mobile.pinduoduo.com/order.html?order_sn=${id}`;
const firstId = "261117-123456789012345";
const secondId = "261117-123456789012346";
const title = {company: "测试采购有限公司", taxId: "91310113MA12345678", email: "finance@example.com"};
const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }});
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(saved, processResult) {
  let token = "test-login-a";
  let disk = saved ? clone(saved) : undefined;
  let writesFail = false;
  const messages = [];
  const tabs = new Map([[1, {id: 1, url: orderUrl(firstId), status: "complete"}]]);
  let tabId = 10;
  let downloadId = 100;
  const chrome = {
    storage: {local: {setAccessLevel: async () => {}, get: async () => ({pddInvoiceV1: disk}), set: async value => {
      if (writesFail) throw new Error("磁盘写入失败");
      disk = clone(value.pddInvoiceV1);
    }}},
    cookies: {get: async () => token ? {value: token} : null, onChanged: event()},
    alarms: {get: async () => ({}), create: async () => {}, onAlarm: event()},
    action: {onClicked: event(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    runtime: {id: "test", getURL: path => `chrome-extension://test/${path}`, onMessage: event()},
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); },
      query: async () => [...tabs.values()],
      create: async options => { const tab = {id: ++tabId, status: "complete", ...options}; tabs.set(tab.id, tab); return tab; },
      update: async (id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); },
      sendMessage: async (id, message) => {
        messages.push(message);
        if (message.type === "PDD_INVOICE_SCAN") return {ok: true, rows: [{id: firstId, url: orderUrl(firstId)}]};
        return processResult ? processResult(message, id) : {ok: true, status: "submitted", note: "已确认"};
      }
    },
    downloads: {download: async () => ++downloadId, onChanged: event()},
    scripting: {executeScript: async () => [{result: []}]}
  };
  const context = vm.createContext({chrome, crypto: webcrypto, URL, TextEncoder, Uint8Array, Date, Intl, structuredClone, console,
    setTimeout: (fn,ms) => setTimeout(fn, ms >= 12000 ? ms : 0), clearTimeout});
  vm.runInContext(core + "\n" + reader + "\n" + worker, context);
  await vm.runInContext("boot", context);
  const sender = {id: "test", url: "chrome-extension://test/dashboard.html"};
  return {
    chrome, messages, context,
    send: (type, payload = {}, origin = sender) => context.handle({type, ...payload}, origin),
    data: () => clone(disk),
    eval: code => vm.runInContext(code, context),
    token: value => { token = value; },
    failWrites: () => { writesFail = true; },
    async done() { for (let i = 0; i < 80; i++) { await settle(); if (!vm.runInContext("runner", context)) return; await new Promise(r => setTimeout(r, 1)); } throw new Error("worker did not settle"); }
  };
}
async function bound(h) {
  const state = await h.send("ACCOUNT_SAVE", {name: "采购一号"});
  const id = state.active;
  await h.send("TITLE_SAVE", {accountId: id, title});
  await h.send("SCAN", {accountId: id, tabId: 1});
  return id;
}

test("only PDD URLs and supported invoice file types are accepted", () => {
  assert.equal(C.pddUrl("https://mobile.pinduoduo.com.evil.test/order.html"), "");
  assert.equal(C.pddUrl("https://user:pass@mobile.pinduoduo.com/order.html"), "");
  assert.equal(C.pddUrl("javascript:alert(1)"), "");
  assert.equal(C.orderId(orderUrl(firstId)), firstId);
  assert.equal(C.orderId("https://mobile.pinduoduo.com/order.html?order_sn=abc"), "");
  assert.equal(C.invoiceFile("https://files.example.test/invoice.exe"), null);
  assert.equal(C.invoiceFile("http://files.example.test/invoice.pdf"), null);
  assert.equal(C.invoiceFile("https://files.example.test/invoice.pdf?signature=x").ext, "pdf");
  assert.equal(C.safeFilePart("../采购/甲:*"), "_采购_甲__");
});
test("company title validation rejects missing or malformed tax ID/email", () => {
  assert.throws(() => C.validateTitle({company: "测试公司", taxId: "123"}), /纳税人/);
  assert.throws(() => C.validateTitle({...title, email: "wrong"}), /邮箱/);
  assert.equal(C.validateTitle({...title, taxId: title.taxId.toLowerCase()}).taxId, title.taxId);
});
test("CSV protects formulas and long identifiers, dates use Beijing days", () => {
  const value = C.csv([["=WEBSERVICE(1)", "1234567890123456789", 'a"b', "普通商品"]]);
  assert.ok(value.startsWith("\uFEFF"));
  assert.match(value, /'=WEBSERVICE/);
  assert.match(value, /'1234567890123456789/);
  assert.match(value, /a""b/);
  assert.match(C.beijing("2026-11-16T16:30:00Z"), /2026\/11\/17 00:30:00/);
  assert.equal(C.visibleRows([{id: "1", date: ""}, {id: "2", date: "2026-11-17"}], {from: "2026-11-17"}).length, 1);
});
test("refresh cannot erase an uncertain submission or accept a mismatched order URL", () => {
  const merged = C.mergeOrders([{id: firstId, url: orderUrl(firstId), status: "review", note: "待核对"}],
    [{id: firstId, url: orderUrl(firstId), status: "pending", shop: "采购店"}, {id: secondId, url: orderUrl(firstId)}]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "review");
  assert.equal(merged[0].note, "待核对");
});
test("rendered order reader uses observed order props and cents, excludes unrelated data", () => {
  const el = {__reactFiberTest: {memoizedProps: {}, return: {memoizedProps: {list: {
    orderSn: firstId, orderLinkUrl: `order.html?order_sn=${firstId}`, displayAmount: 2270,
    orderTime: Date.parse("2026-11-16T16:30:00Z") / 1000, orderStatusPrompt: "待收货",
    mall: {mallName: "测试店"}, orderGoods: [{goodsName: "采购物料"}], address: "不应读取", token: "不应读取"
  }}}}};
  const ctx = vm.createContext({document: {querySelectorAll: selector => selector.includes("data-test") ? [el] : []}, location: {origin: "https://mobile.pinduoduo.com"}, URL, Intl, Date});
  vm.runInContext(reader, ctx);
  const [row] = ctx.readRenderedOrders();
  assert.equal(row.amount, "22.70");
  assert.equal(row.date, "2026-11-17");
  assert.equal(row.product, "采购物料");
  assert.ok(!JSON.stringify(row).includes("不应读取"));
});
test("account binding stores only a login hash and keeps 3 account datasets separate", async () => {
  const h = await harness();
  const a = await bound(h);
  await assert.rejects(h.send("ACCOUNT_SAVE", {name: "重复账号"}), /已绑定/);
  h.token("test-login-b"); const b = (await h.send("ACCOUNT_SAVE", {name: "采购二号"})).active;
  assert.notEqual(a, b);
  assert.equal(h.data().accounts[0].orders.length, 1);
  assert.equal(h.data().accounts[1].orders.length, 0);
  h.token("test-login-c"); await h.send("ACCOUNT_SAVE", {name: "采购三号"});
  h.token("test-login-d"); await assert.rejects(h.send("ACCOUNT_SAVE", {name: "第四个"}), /三个/);
  assert.ok(!JSON.stringify(h.data()).includes("test-login"));
  assert.ok(!JSON.stringify(await h.send("STATE")).includes("fingerprint"));
});
test("wrong account and non-dashboard senders cannot start a batch", async () => {
  const h = await harness(); const id = await bound(h);
  h.token("different-account");
  await assert.rejects(h.send("START", {accountId: id, ids: [firstId], kind: "apply"}), /登录状态已改变/);
  assert.equal(h.messages.filter(m => m.type === "PDD_INVOICE_PROCESS").length, 0);
  await assert.rejects(h.send("STATE", {}, {id: "test", url: orderUrl(firstId), tab: {id: 1}}), /只能在/);
});
test("worker restart pauses pending tasks and marks interrupted submission for review", async () => {
  const h = await harness(); const id = await bound(h);
  const data = h.data();
  data.queue = {id: "old", accountId: id, fingerprint: data.accounts[0].fingerprint, state: "running", kind: "apply",
    items: [{id: firstId, status: "processing"}, {id: secondId, status: "pending"}]};
  const restarted = await harness(data);
  assert.equal(restarted.data().queue.state, "paused");
  assert.equal(restarted.data().queue.items[0].status, "review");
  assert.equal(restarted.data().queue.items[1].status, "pending");
  await assert.rejects(restarted.send("RESUME"), /先打开待核对/);
});
test("a submission authorization is tied to queue, tab, frame, order, session and can run only once", async () => {
  const h = await harness(); const id = await bound(h);
  await h.eval(`store.queue = {id:"q",accountId:${JSON.stringify(id)}, fingerprint:store.accounts[0].fingerprint,kind:"apply",state:"running",tabId:7,items:[{id:${JSON.stringify(firstId)},status:"processing",stage:"open"}]}`);
  const payload = {queueId: "q", orderId: firstId};
  const sender = {id: "test", frameId: 0, tab: {id: 7}, url: orderUrl(firstId)};
  await assert.rejects(h.send("PDD_INVOICE_AUTHORIZE", payload, {...sender, frameId: 1}), /不匹配/);
  await assert.rejects(h.send("PDD_INVOICE_AUTHORIZE", payload, {...sender, url: orderUrl(secondId)}), /不匹配/);
  const reply = await h.send("PDD_INVOICE_AUTHORIZE", payload, sender);
  assert.equal(reply.authorized, true);
  assert.equal(h.data().queue.items[0].stage, "authorized");
  await assert.rejects(h.send("PDD_INVOICE_AUTHORIZE", payload, sender), /禁止重复提交/);
  assert.equal((await h.send("PDD_INVOICE_AUTHORIZE", {...payload, phase: "confirm"}, sender)).authorized, true);
  await assert.rejects(h.send("PDD_INVOICE_AUTHORIZE", {...payload, phase: "confirm"}, sender), /禁止重复提交/);
});
test("storage failure prevents authorization from reaching the submit click", async () => {
  const h = await harness(); const id = await bound(h);
  await h.eval(`store.queue={id:"q",accountId:${JSON.stringify(id)},fingerprint:store.accounts[0].fingerprint,kind:"apply",state:"running",tabId:7,items:[{id:${JSON.stringify(firstId)},status:"processing",stage:"open"}]}`);
  h.failWrites();
  await assert.rejects(h.send("PDD_INVOICE_AUTHORIZE", {queueId: "q", orderId: firstId}, {id: "test", frameId: 0, tab: {id: 7}, url: orderUrl(firstId)}), /磁盘写入失败/);
});
test("uncertain page result pauses queue and is never automatically replayed", async () => {
  const h = await harness(undefined, async () => ({ok: true, status: "review", note: "已点击，结果不明确", block: true}));
  const id = await bound(h);
  await h.send("START", {accountId: id, ids: [firstId], kind: "apply"}); await h.done();
  assert.equal(h.data().queue.state, "paused");
  assert.equal(h.data().accounts[0].orders[0].status, "review");
  await assert.rejects(h.send("RESUME"), /先打开待核对/);
  assert.equal(h.messages.filter(m => m.type === "PDD_INVOICE_PROCESS").length, 1);
});
test("selecting an already issued order never downgrades its status or submits again", async () => {
  const h = await harness(); const id = await bound(h);
  await h.send("LEDGER_SAVE", {accountId: id, orderId: firstId, ledger: {status: "issued"}});
  await h.send("START", {accountId: id, ids: [firstId], kind: "apply"}); await h.done();
  assert.equal(h.data().accounts[0].orders[0].status, "issued");
  assert.equal(h.messages.filter(m => m.type === "PDD_INVOICE_PROCESS").length, 0);
});

test("ledger date filters use the chosen application or issue date, not purchase date", () => {
  const rows = [{id: "one", date: "2026-09-01", appliedAt: "2026-10-31 23:55:00", issuedAt: "2026-11-17"},
    {id: "two", date: "2026-11-17", appliedAt: "2026-11-17", issuedAt: ""}];
  assert.equal(C.visibleRows(rows, {dateBasis: "issuedAt", from: "2026-11-01", to: "2026-11-30"})[0].id, "one");
  assert.equal(C.visibleRows(rows, {dateBasis: "appliedAt", from: "2026-11-01", to: "2026-11-30"})[0].id, "two");
  assert.equal(C.normalizeDate("预计2026年11月28日前开票"), "");
  assert.equal(C.normalizeDate("2026-02-31"), "");
  assert.equal(C.normalizeDate("2026年11月17日"), "2026-11-17");
  assert.equal(C.visibleRows([{status: "review"}, {status: "rejected"}, {status: "issued", taskStatus: "failed"}, {status: "issued"}], {status: "needs_review"}).length, 3);
});
test("period totals sum cents exactly and never substitute order value for missing invoice value", () => {
  const totals = C.summarize([
    {status: "issued", invoiceAmountCents: C.cents("100.10"), amount: "120.00"},
    {status: "issued", invoiceAmountCents: C.cents("20.02")},
    {status: "issued", amount: "999.99"},
    {status: "submitted", amount: "12.34"},
    {status: "rejected", applicationAmountCents: 999}
  ]);
  assert.equal(totals.issued.cents, 12012);
  assert.equal(totals.issued.count, 3);
  assert.equal(totals.issued.missing, 1);
  assert.equal(totals.submitted.cents, 1234);
  assert.equal(totals.rejected.cents, 999);
  assert.equal(C.cents("1.001"), null);
  assert.equal(C.cents("-1.00"), null);
});
test("authoritative invoice refresh resolves statuses and preserves known amounts/history", () => {
  const old = {id: firstId, url: orderUrl(firstId), status: "submitted", invoiceAmountCents: 4650, appliedAt: "2026-11-17 12:13:14"};
  const [row] = C.mergeOrders([old], [{id: firstId, url: orderUrl(firstId), status: "issued", invoiceFacts: {appliedAt: "2026-11-17", issuedAt: "2026-11-17", platformCheckedAt: 12345}}]);
  assert.equal(row.status, "issued");
  assert.equal(row.invoiceAmountCents, 4650);
  assert.equal(row.appliedAt, "2026-11-17 12:13:14");
  assert.equal(row.issuedAt, "2026-11-17");
  assert.equal(row.history.length, 1);
  assert.ok(row.history[0].changes.some(c => c.field === "status" && c.before === "submitted" && c.after === "issued"));
  C.recordLedger(row, {status: "issued", issuedAt: "2026-11-17"}, "platform");
  assert.equal(row.history.length, 1);
});
test("manual ledger corrections persist dates, invoice value, reason and audit trail", async () => {
  const h = await harness(); const id = await bound(h);
  await h.send("LEDGER_SAVE", {accountId: id, orderId: firstId, ledger: {status: "issued", appliedAt: "2026-11-16 15:30:00", issuedAt: "2026-11-17", invoiceAmount: "46.50", invoiceNo: "12345678901234567890", ledgerNote: "已按原件核对"}});
  let row = h.data().accounts[0].orders[0];
  assert.equal(row.invoiceAmountCents, 4650);
  assert.equal(row.issuedAt, "2026-11-17");
  assert.equal(row.invoiceNo, "12345678901234567890");
  assert.equal(row.history.at(-1).source, "manual");
  await assert.rejects(h.send("LEDGER_SAVE", {accountId: id, orderId: firstId, ledger: {status: "issued", invoiceAmount: "NaN"}}), /票面金额/);
  await assert.rejects(h.send("LEDGER_SAVE", {accountId: id, orderId: firstId, ledger: {status: "issued", issuedAt: "2026-02-31"}}), /开票时间/);
  const restarted = await harness(h.data());
  row = restarted.data().accounts[0].orders[0];
  assert.equal(row.invoiceAmountCents, 4650);
  assert.equal(row.ledgerNote, "已按原件核对");
});
test("merchant rejection is distinct from automation error and continues the batch", async () => {
  const h = await harness(undefined, async () => ({ok: true, status: "rejected", note: "商家拒绝", facts: {rejectionReason: "订单已全额退款", appliedAt: "2026-11-16"}}));
  const id = await bound(h);
  await h.send("START", {accountId: id, ids: [firstId], kind: "refresh"}); await h.done();
  const row = h.data().accounts[0].orders[0];
  assert.equal(row.status, "rejected");
  assert.equal(row.rejectionReason, "订单已全额退款");
  assert.equal(h.data().queue.state, "done");
});
test("a failed status refresh keeps a previously confirmed invoice and amount intact", async () => {
  const h = await harness(undefined, async () => { throw new Error("页面加载超时"); });
  const id = await bound(h);
  await h.send("LEDGER_SAVE", {accountId: id, orderId: firstId, ledger: {status: "issued", invoiceAmount: "46.50", issuedAt: "2026-11-17"}});
  await h.send("START", {accountId: id, ids: [firstId], kind: "refresh"}); await h.done();
  const row = h.data().accounts[0].orders[0];
  assert.equal(row.status, "issued");
  assert.equal(row.taskStatus, "failed");
  assert.equal(row.invoiceAmountCents, 4650);
  assert.equal(C.summarize([row]).issued.cents, 4650);
});

test("official invoice list uses yuan strings and preserves rejected business status", () => {
  const card = {children: [], textContent: "发票详情", __reactFiberTest: {memoizedProps: {data: {
    order_sn: firstId, invoice_status: 0, invoice_amount: "27.83", reject_reason: "订单已全额退款", goods_name: "测试标签纸"
  }}}};
  const ctx = vm.createContext({document: {querySelectorAll: selector => selector === "div,span" ? [card] : []}, location: {origin: "https://mobile.pinduoduo.com"}, URL, Intl, Date});
  vm.runInContext(reader, ctx);
  const [row] = ctx.readRenderedOrders();
  assert.equal(row.status, "rejected");
  assert.equal(row.invoiceFacts.applicationAmountCents, 2783);
  assert.equal(row.invoiceFacts.invoiceAmountCents, undefined);
  assert.equal(row.invoiceFacts.rejectionReason, "订单已全额退款");
});
test("download completion comes from Chrome and an existing record prevents duplicate downloads", async () => {
  const h = await harness(undefined, async () => ({ok: true, files: ["https://pfs.yangkeduo.com/order_invoice/example.png"], facts: {issuedAt: "2026-11-17"}}));
  const id = await bound(h);
  await h.send("START", {accountId: id, ids: [firstId], kind: "download"}); await h.done();
  assert.equal(h.data().queue.items[0].status, "downloading");
  assert.equal(h.data().accounts[0].orders[0].status, "issued");
  assert.equal(h.data().accounts[0].orders[0].downloads[0].state, "in_progress");
  await h.chrome.downloads.onChanged.listeners[0]({id: 101, state: {current: "complete"}});
  assert.equal(h.data().queue.items[0].status, "downloaded");
  assert.equal(h.data().accounts[0].orders[0].status, "issued");
  const before = h.messages.filter(m => m.type === "PDD_INVOICE_PROCESS").length;
  await h.send("START", {accountId: id, ids: [firstId], kind: "download"}); await h.done();
  assert.equal(h.messages.filter(m => m.type === "PDD_INVOICE_PROCESS").length, before);
});

test("pending contact-merchant cards retain thumbnail and the observed application route", () => {
  const el = {children: [], textContent: "申请发票", __reactFiberTest: {memoizedProps: {data: {order_sn: firstId, mall_id: 123, goods_name: "采购包装袋", thumb_url: "https://img.pddpic.com/sample.jpeg", invoice_amount: "185.85", order_time: null}}}};
  const ctx = vm.createContext({document: {querySelectorAll: selector => selector.includes("data-test") ? [] : [el]}, location: {origin: C.ORIGIN}, URL, Intl, Date});
  vm.runInContext(reader, ctx);
  const [row] = ctx.readRenderedOrders();
  assert.equal(row.status, "pending");
  assert.equal(row.thumbnail, "https://img.pddpic.com/sample.jpeg");
  assert.equal(new URL(row.applicationUrl).searchParams.get("mall_id"), "123");
  assert.equal(row.invoiceFacts.applicationAmountCents, 18585);
  assert.equal(row.date, "");
  assert.equal(row.invoiceFacts.invoiceAmountCents, undefined);
});
test("history merge enriches pending cards without erasing purchase dates or accepting another order application route", () => {
  const base = [{id: firstId, url: orderUrl(firstId), date: "2026-11-17", amount: "185.85", status: "pending"}];
  const [row] = C.mergeOrders(base, [{id: firstId, url: orderUrl(firstId), thumbnail: "https://img.pddpic.com/a.jpeg", applicationUrl: C.invoiceUrl(secondId, "apply", "123")}]);
  assert.equal(row.date, "2026-11-17");
  assert.equal(row.amount, "185.85");
  assert.equal(row.applicationUrl, "");
});
test("batch application navigates directly to the matched official merchant application form", async () => {
  const h = await harness(); const id = await bound(h);
  const url = C.invoiceUrl(firstId, "apply", "123");
  await h.eval(`store.accounts[0].orders[0].applicationUrl=${JSON.stringify(url)}`);
  await h.send("START", {accountId:id, ids:[firstId], kind:"apply"}); await h.done();
  assert.equal([...await h.chrome.tabs.query()].at(-1).url, url);
  assert.equal(h.data().accounts[0].orders[0].status, "submitted");
});

test("history scanner scrolls the popup beyond 18 pages and only reports completion at a visible end marker", async () => {
  let listener, page = 0, progress = [];
  const popup = {classList: {contains: n => n === "common-pop-panel"}, getClientRects: () => [1], clientHeight: 100, scrollHeight: 1000, scrollTop: 900, get innerText() {return page >= 25 ? "没有更多订单" : "历史待申请订单";}, scrollTo() {page++;}};
  const doc = {body: {innerText: "官方发票助手"}, querySelector: () => null, querySelectorAll: selector => selector === "*" ? [popup] : [], scrollingElement: {scrollTo() {throw Error("must not scroll outer page");}}};
  const chrome = {runtime: {id:"qa", onMessage:{addListener:f=>listener=f}, sendMessage:async m => {
    if(m.type === "PDD_INVOICE_RENDERED_ROWS") return {ok:true,value:[{id:String(Math.min(page,25)),url:orderUrl(firstId),applicationUrl:C.invoiceUrl(firstId,"apply","1")}]};
    if(m.type === "PDD_INVOICE_SCAN_PROGRESS") {progress.push(m.progress);return {ok:true};}
    throw Error("unexpected action");
  }}};
  const ctx = vm.createContext({chrome,document:doc,location:{pathname:"/commercial_pre_orders.html"},getComputedStyle:()=>({visibility:"visible",overflowY:"auto"}),Date,URL,setTimeout:fn=>{fn();}});
  vm.runInContext(core + "\n" + fs.readFileSync(dir+"content.js","utf8"),ctx);
  const result = await new Promise(resolve => listener({type:"PDD_INVOICE_SCAN",history:true,loadMore:true},{id:"qa"},resolve));
  assert.equal(result.ok,true);assert.equal(result.complete,true);assert.ok(progress.at(-1).loaded > 18);assert.match(result.note,/末尾/);
});

test("content application fills and checks the title, authorizes once, then confirms observed platform state", async () => {
  let listener, clicks = 0, authorizations = 0;
  class Input {constructor(placeholder) {this.placeholder=placeholder;this.labels=[];this.children=[];this.parentElement={innerText:""};this.tagName="INPUT";this._value="";}get value(){return this._value;}set value(v){this._value=v;}getClientRects(){return [1];}getAttribute(){return "";}dispatchEvent(){}}
  const company=new Input("请输入抬头名称"),tax=new Input("请输入纳税人识别号");
  const submit={innerText:"向商家发送申请",children:[],getClientRects:()=>[1],getAttribute:()=>"",click:()=>{clicks++;}};
  const document={getElementById:()=>null,body:{innerText:"发票 电子发票（普通发票）"},querySelector:()=>null,querySelectorAll:s=>s.startsWith("input:not")?[company,tax]:s==="button,a,[role=button],span,div"?[submit]:[],images:[]};
  const chrome={runtime:{id:"qa",onMessage:{addListener:f=>listener=f},sendMessage:async m=>{
    if(m.type==="PDD_INVOICE_AUTHORIZE"){authorizations++;assert.equal(company.value,title.company);assert.equal(tax.value,title.taxId);return {ok:true,value:{authorized:true}};}
    if(m.type==="PDD_INVOICE_PAGE_STATE")return {ok:true,value:{ready:true,orderId:firstId,hasApplied:clicks>0,invoiceKind:0,displayText:clicks?"申请已发送":"",mallId:"123"}};
    throw Error("unexpected request");
  }}};
  const ctx=vm.createContext({chrome,document,location:new URL(C.invoiceUrl(firstId,"apply","123")),getComputedStyle:()=>({visibility:"visible"}),HTMLInputElement:Input,HTMLTextAreaElement:Input,Event:class{},URL,URLSearchParams,Intl,Date,setTimeout:fn=>fn()});
  vm.runInContext(core+"\n"+fs.readFileSync(dir+"content.js","utf8"),ctx);
  const result=await new Promise(resolve=>listener({type:"PDD_INVOICE_PROCESS",kind:"apply",orderId:firstId,queueId:"q",title},{id:"qa"},resolve));
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.status,"submitted",JSON.stringify(result));assert.equal(clicks,1);assert.equal(authorizations,1);
});

test("purchase pagination reads past six months without leaking personal fields and detects the real end", async () => {
  let request;
  const ctx = vm.createContext({location:new URL("https://mobile.pinduoduo.com/orders.html"),AbortController,setTimeout,clearTimeout,URL,Intl,Date,
    fetch:async(url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({orders:[{order_sn:firstId,order_time:Date.parse("2024-02-03T02:00:00Z")/1000,offset:"older-page",display_amount:2270,mall:{mall_name:"测试商家"},order_goods:[{goods_name:"包装袋",thumb_url:"https://img.pddpic.com/a.jpg"}],address_id:"private-address",tracking_number:"private-tracking"}]})};}});
  vm.runInContext(reader,ctx);const result=await ctx.readPurchasePage("cursor");
  assert.equal(request.offset,"cursor");assert.equal(request.size,50);assert.equal(result.rows[0].date,"2024-02-03");assert.equal(result.rows[0].amount,"22.70");assert.equal(result.nextOffset,"older-page");assert.equal(result.complete,false);assert.ok(!JSON.stringify(result).includes("private"));
  ctx.fetch=async()=>({ok:true,json:async()=>({orders:[]})});assert.equal((await ctx.readPurchasePage("older-page")).complete,true);
  ctx.fetch=async()=>({ok:true,json:async()=>({orders:[{order_sn:firstId,offset:"cursor"}]})});await assert.rejects(ctx.readPurchasePage("cursor"),/游标未推进/);
  ctx.fetch=async()=>({ok:true,json:async()=>({error_code:40001,error_msg:"请重新登录"})});await assert.rejects(ctx.readPurchasePage("cursor"),/重新登录/);
});

test("merchant chat navigation after an authorized submit recovers through invoice detail without replaying application", async () => {
  let h, processCalls=0;
  h=await harness(undefined,async(message,tabId)=>{
    if(message.type==="PDD_INVOICE_PROCESS") {
      processCalls++;
      await h.send("PDD_INVOICE_AUTHORIZE",{queueId:h.data().queue.id,orderId:firstId},{id:"test",frameId:0,tab:{id:tabId},url:C.invoiceUrl(firstId,"apply","123")});
      throw Error("The message port closed before a response was received");
    }
    if(message.type==="PDD_INVOICE_INSPECT") {
      const tab=await h.chrome.tabs.get(tabId);assert.equal(new URL(tab.url).searchParams.get("_t_timestamp"),"transac_invoice");
      return {ok:true,status:"submitted",note:"商家处理中",facts:{appliedAt:"2026-11-17"}};
    }
  });
  const id=await bound(h);await h.send("START",{accountId:id,ids:[firstId],kind:"apply"});await h.done();
  assert.equal(processCalls,1);assert.equal(h.data().queue.state,"done");assert.equal(h.data().accounts[0].orders[0].status,"submitted");
});

test("mixed selection applies only pending rows, preserving issued and submitted states",async()=>{
 const h=await harness();const id=await bound(h);
 await h.eval(`store.accounts[0].orders.push({id:${JSON.stringify(secondId)},url:${JSON.stringify(orderUrl(secondId))},status:"issued",invoiceAmountCents:2270})`);
 await h.send("START",{accountId:id,ids:[firstId,secondId],kind:"apply",concurrency:8});await h.done();
 assert.equal(h.messages.filter(m=>m.type==='PDD_INVOICE_PROCESS').length,1);assert.equal(h.data().accounts[0].orders.find(r=>r.id===secondId).status,'issued');assert.equal(h.data().queue.items.find(r=>r.id===secondId).status,'skipped');
});
test("parallel queue uses separate tabs, caps concurrency at eight and processes each order once",async()=>{
 let current=0,peak=0;const calls=new Map();
 const h=await harness(undefined,async(message,tabId)=>{
  if(message.type!=='PDD_INVOICE_PROCESS')return {ok:true};
  current++;peak=Math.max(peak,current);calls.set(message.orderId,(calls.get(message.orderId)||0)+1);
  await new Promise(r=>setTimeout(r,5));current--;return {ok:true,status:'submitted',note:'已确认'};
 });const id=await bound(h);const ids=Array.from({length:20},(_,i)=>'261118-'+String(123456789012345+i));
 await h.eval(`store.accounts[0].orders=${JSON.stringify(ids.map(id=>({id,url:orderUrl(id),status:'pending'})))}`);
 await h.send('START',{accountId:id,ids,kind:'apply',concurrency:1000});await h.done();
 assert.ok(peak>1);assert.ok(peak<=8);assert.equal(calls.size,20);assert.ok([...calls.values()].every(n=>n===1));assert.equal(h.data().queue.tabIds.length,8);assert.equal(h.data().queue.state,'done');
});
test("parallel submission authorization rejects a different lane's tab",async()=>{
 const h=await harness();const id=await bound(h);
 await h.eval(`store.queue={id:"q",accountId:${JSON.stringify(id)},fingerprint:store.accounts[0].fingerprint,kind:"apply",state:"running",tabId:7,tabIds:[7,8],items:[{id:${JSON.stringify(firstId)},status:"processing",stage:"open",tabId:8}]}`);
 const sender={id:'test',frameId:0,tab:{id:7},url:orderUrl(firstId)};
 await assert.rejects(h.send('PDD_INVOICE_AUTHORIZE',{queueId:'q',orderId:firstId},sender),/任务已暂停或订单不匹配/);
 assert.equal((await h.send('PDD_INVOICE_AUTHORIZE',{queueId:'q',orderId:firstId},{...sender,tab:{id:8}})).authorized,true);
});

test('a page that never replies times out visibly and pauses without replaying the order',async()=>{
 const h=await harness(undefined,async()=>new Promise(()=>{}));const id=await bound(h);
 await h.eval('globalThis.realTimer=setTimeout;setTimeout=(fn,ms)=>realTimer(fn,ms===45000?0:ms)');
 await h.send('START',{accountId:id,ids:[firstId],kind:'apply'});await h.done();
 assert.equal(h.data().queue.state,'paused');assert.match(h.data().queue.note,/45秒未返回/);assert.equal(h.messages.filter(m=>m.type==='PDD_INVOICE_PROCESS').length,1);
});
test('lost reply after authorization is read back once and stays paused after timeout',async()=>{
 let h;h=await harness(undefined,async(message,tabId)=>{
  if(message.type==='PDD_INVOICE_PROCESS'){
   await h.send('PDD_INVOICE_AUTHORIZE',{queueId:h.data().queue.id,orderId:firstId},{id:'test',frameId:0,tab:{id:tabId},url:C.invoiceUrl(firstId,'apply','123')});return new Promise(()=>{});
  }
  return {ok:true,status:'submitted',note:'商家处理中',facts:{appliedAt:'2026-11-18'}};
 });const id=await bound(h);await h.eval('globalThis.realTimer=setTimeout;setTimeout=(fn,ms)=>realTimer(fn,ms===45000?0:ms)');
 await h.send('START',{accountId:id,ids:[firstId],kind:'apply'});await h.done();
 assert.equal(h.data().accounts[0].orders[0].status,'submitted');assert.equal(h.data().queue.state,'paused');assert.equal(h.messages.filter(m=>m.type==='PDD_INVOICE_PROCESS').length,1);assert.equal(h.messages.filter(m=>m.type==='PDD_INVOICE_INSPECT').length,1);
});

test('a stalled history scan keeps previously read records and reports an explicit timeout',async()=>{
 const h=await harness();const id=await bound(h);
 h.chrome.tabs.sendMessage=async(_id,m)=>m.type==='PDD_INVOICE_SCAN'?new Promise(()=>{}):{ok:true};
 const pending=h.send('SCAN',{accountId:id,tabId:1,loadMore:true});const checked=assert.rejects(pending,/45秒无响应/);
 for(let i=0;i<100&&!h.eval("Boolean(scanContext)");i++)await settle();
 await h.eval('scanContext.heartbeatAt=Date.now()-46000;scanContext.progress={count:1,loaded:1,note:"已读取1笔"}');
 await checked;assert.equal(h.data().accounts[0].orders.length,1);assert.equal(h.data().lastScanProgress.running,false);assert.equal(h.data().lastScanProgress.count,1);assert.match(h.data().lastScanProgress.note,/已保存已读记录/);
});

test('ERP bridge reuses the enterprise key, stores account names without login fingerprints and rejects another tenant',async()=>{
 const h=await harness();const id=await bound(h);let tenant=10,revision=0;const uploads=[];
 h.context.AbortController=AbortController;
 h.context.OzonUnifiedConfig={get:async()=>({localPluginToken:'private-key',tenantId:String(tenant)})};
 h.context.fetch=async(url,options)=>{
  assert.equal(options.headers['x-local-plugin-token'],'private-key');let data;
  if(url.endsWith('/companies'))data={tenant_id:tenant,companies:[{id:101,name:title.company,tax_number:title.taxId}]};
  else {const body=JSON.parse(options.body);uploads.push(body);data={revision:++revision};}
  return{ok:true,headers:{get:()=> 'application/json'},json:async()=>({success:true,data})};
 };
 await h.send('ERP_TITLE',{accountId:id,companyId:101});await h.send('ERP_SYNC',{accountId:id});
 assert.ok(uploads.length>0);assert.equal(uploads.at(-1).name,'采购一号');assert.ok(!JSON.stringify(uploads).includes('fingerprint'));assert.ok(!JSON.stringify(await h.send('STATE')).includes('private-key'));
 tenant=20;await assert.rejects(h.send('ERP_SYNC',{accountId:id}),/另一企业/);
 assert.equal((await h.send('STATE')).accounts.length,0);
});
test('restoring cloud account metadata preserves names and records but never restores a PDD login',async()=>{
 const h=await harness();h.context.AbortController=AbortController;
 h.context.OzonUnifiedConfig={get:async()=>({localPluginToken:'private-key',tenantId:'10'})};
 h.context.fetch=async(url)=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({success:true,data:url.endsWith('/companies')?{tenant_id:10,companies:[{id:101,name:title.company,tax_number:title.taxId}]}:{accounts:[{id:'cloud-account-1',name:'已保存的采购账号',companyId:101,revision:5,orders:[{id:firstId,status:'issued',url:orderUrl(firstId),invoiceAmountCents:18585}]}]}})});
 const state=await h.send('ERP_RESTORE');assert.equal(state.accounts[0].name,'已保存的采购账号');assert.equal(state.accounts[0].orders[0].invoiceAmountCents,18585);assert.equal(state.accounts[0].connected,false);assert.equal(h.data().accounts[0].fingerprint,'');
});

test('private OSS archival refuses older backends before starting a download or writing a file',async()=>{
 const h=await harness();const id=await bound(h);h.context.AbortController=AbortController;
 h.context.OzonUnifiedConfig={get:async()=>({localPluginToken:'private-key',tenantId:'10'})};
 h.context.fetch=async(url)=>{assert.ok(url.endsWith('/companies'));return{ok:true,headers:{get:()=> 'application/json'},json:async()=>({success:true,data:{tenant_id:10,companies:[{id:101,name:title.company,tax_number:title.taxId}]}})};};
 await h.eval('store.accounts[0].erpTenant=10;store.accounts[0].titleCompanyId=101');
 await assert.rejects(h.send('START',{accountId:id,ids:[firstId],kind:'download',destination:'system'}),/尚未提供私有 OSS/);
 assert.equal(h.messages.filter(m=>m.type==='PDD_INVOICE_PROCESS').length,0);assert.equal(h.data().queue,null);
});
