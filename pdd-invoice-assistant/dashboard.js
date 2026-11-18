const C = globalThis.PddInvoice;
const $ = id => document.getElementById(id);
let model = {accounts: [], active: "", queue: null};
let selected = new Set();
let titleDirty = false;
let titleAccount = "";
let editAccount = "";
let ledgerRef = null;
let locked = false;
let pollRunning = false;
let pageIndex = 0;
let pageSize = 50;
function active() { return model.accounts.find(a => a.id === model.active); }
function notice(text, error = false) { $("notice").textContent = text; $("notice").classList.toggle("error", error); }
async function request(type, payload = {}) {
  let timer;
  const pending=chrome.runtime.sendMessage({module: "PDD_INVOICE", type, ...payload});
  const longTask=["SCAN_HISTORY","SCAN","IMPORT_INVOICES","ERP_SYNC","ERP_RESTORE"].includes(type);
  const result=longTask ? await pending : await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("助手后台12秒未响应，请查看拼多多处理窗口；页面会继续刷新状态，请勿重复申请")),12000);})]).finally(()=>clearTimeout(timer));
  if (!result?.ok) throw new Error(result?.error || "助手后台暂时无响应，请重新打开插件");
  return result.value;
}
async function action(fn) {
  if (locked) { notice("当前任务正在处理，可使用停止读取或查看进度"); return; }
  locked = true;
  document.body.setAttribute("aria-busy", "true");
  try { await fn(); }
  catch (error) { notice(error.message, true); }
  finally { locked = false; document.body.removeAttribute("aria-busy"); render(); }
}
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, fn, className = "", independent = false) {
  const el = node("button", className, text);
  el.addEventListener("click", () => independent ? Promise.resolve().then(fn).catch(error => notice(error.message, true)) : action(fn));
  return el;
}
function setModel(next) {
  const changed = model.active !== next.active;
  model = next;
  if (changed) { selected.clear(); titleDirty = false; pageIndex = 0; }
  render();
}
function filter() { return {query: $("query").value.trim(), status: $("status").value, from: $("from").value, to: $("to").value, dateBasis: $("dateBasis").value}; }
function scopedRows() {
  return model.accounts.filter(a => $("scope").value === "all" || a.id === model.active).flatMap(a => a.orders.map(row => ({...row, accountId: a.id, accountName: a.name})));
}
function rows() { return C.visibleRows(scopedRows(), filter()); }
function selectedIds() { return rows().filter(row => selected.has(row.id)).map(row => row.id); }
function resetTableScroll() { document.querySelector('.table-wrap').scrollTop = 0; }
function openAccount(id = "") {
  editAccount = id;
  $("accountName").value = model.accounts.find(a => a.id === id)?.name || "";
  $("accountDialogTitle").textContent = id ? "确认当前登录账号并重新绑定" : "绑定当前拼多多登录";
  $("accountDialog").showModal();
}
function render() {
  const a = active();
  const companyPicker=$("erpCompany"), companyValue=String(a?.titleCompanyId||"");
  companyPicker.replaceChildren();const placeholder=node("option","","请选择 ERP 开票公司");placeholder.value="";companyPicker.append(placeholder);
  for(const c of model.erp?.companies||[]){const o=node("option","",`${c.name} · ${c.tax_number||"税号未设置"}`);o.value=c.id;companyPicker.append(o);}companyPicker.value=companyValue;
  $("cloudStatus").textContent=a?.erpError || model.erpError || (a?.erpSyncedAt ? `账号备注与台账已同步：${C.beijing(a.erpSyncedAt)}${a.erpUploading?" · 正在更新系统记录":""}` : "使用统一插件已绑定的企业密钥读取公司。选择抬头后自动同步台账，也可点击顶部同步系统。");
  $("storageStatus").textContent=model.erp?.storagePolicy?.version===2 ? (model.erp.storagePolicy.configured ? "文件位置：私有 OSS；台账及附件索引：MySQL。" : "私有 OSS 尚未配置，系统文件归档不可用，可先本地下载。") : "后台尚未提供私有 OSS 归档能力，请升级后台后再保存系统附件；本地下载不受影响。";
  $("cloudSync").disabled=!a || locked || a.erpUploading;
  companyPicker.disabled=!a || model.queue?.state === "running";
  const scan = model.scanProgress;
  $("scanStop").hidden = !scan?.running;
  $("scanOpen").hidden = !scan?.tabId;
  if(a?.erpSyncProgress?.running){const p=a.erpSyncProgress;notice(`正在同步系统台账 ${p.saved} / ${p.total} 笔 · 最近响应 ${Math.max(0,Math.floor((Date.now()-p.updatedAt)/1000))} 秒前`);}
  if (scan?.running) notice(`${scan.note}${scan.updatedAt ? `（最近响应 ${Math.max(0,Math.floor((Date.now()-scan.updatedAt)/1000))} 秒前）` : ""}；已保留 ${scan.count || 0} 笔${scan.oldest ? `，最早日期 ${scan.oldest}` : "，平台暂未提供下单日期"}`);
  const q = model.queue;
  const running = q?.state === "running";
  $("accounts").replaceChildren();
  for (const item of model.accounts) {
    const el = button("", async () => {
      if (titleDirty && !confirm("发票抬头有未保存修改，切换账号将放弃这些修改。继续吗？")) return;
      setModel(await request("ACCOUNT_SELECT", {accountId: item.id}));
    }, `account${item.id === model.active ? " active" : ""}`);
    el.append(node("span", "account-name", item.name));
    const status = node("span", `account-status${item.connected ? " connected" : ""}`);
    status.append(node("i", "dot"), document.createTextNode(item.connected ? "当前已登录" : "请切换至该拼多多账号"));
    el.append(status);
    $("accounts").append(el);
    if (item.id === model.active) {
      const rebind = button("重新绑定登录", async () => openAccount(item.id), "text-button rebind");
      rebind.disabled = running;
      $("accounts").append(rebind);
    }
  }
  $("accountCount").textContent = `${model.accounts.length} / 3`;
  $("addAccount").disabled = model.accounts.length >= 3 || running;
  $("onboarding").hidden = Boolean(a);
  if (!titleDirty || titleAccount !== a?.id) {
    for (const key of ["company", "taxId", "email"]) $(key).value = a?.title?.[key] || "";
    titleAccount = a?.id;
  }
  $("titleHint").textContent = titleDirty ? "有未保存修改" : "每个采购账号独立保存抬头";
  $("titleHint").classList.toggle("dirty", titleDirty);
  for (const key of ["company", "taxId", "email", "saveTitle"]) $(key).disabled = !a || running;
  $("scan").disabled = !a?.connected || running || locked;
  $("importInvoices").disabled = $("scan").disabled;
  $("refreshProgress").disabled = !a?.connected || running || locked || $("scope").value === "all";
  $("lastScan").textContent = a?.scannedAt ? `上次读取 ${C.beijing(a.scannedAt)}${a.purchaseHistory ? ` · 采购 ${a.purchaseHistory.count} 笔 · 最早 ${a.purchaseHistory.oldest || "日期未知"} · ${a.purchaseHistory.complete ? "已读到末尾" : "尚未读完"}` : ""}` : "尚未读取订单";
  $("queueCard").hidden = !q;
  if (q) {
    const qa = model.accounts.find(a => a.id === q.accountId);
    const done = q.items.filter(j => !["pending", "processing"].includes(j.status)).length;
    $("queueTitle").textContent = `${qa?.name || "采购账号"} · ${({apply: "批量申请", download: "批量下载", refresh: "刷新开票状态"})[q.kind]}`;
    $("queueBadge").textContent = ({running: "处理中", paused: "已暂停", done: "本批已结束", stopped: "已结束"})[q.state] || "任务";
    $("queueProgress").max = q.items.length || 1;
    $("queueProgress").value = done;
    $("queueCounts").textContent = `${done} / ${q.items.length} 单`;
    $("queueNote").textContent = `${q.note || ""}${q.heartbeatAt ? ` · 最近响应 ${Math.max(0,Math.floor((Date.now()-q.heartbeatAt)/1000))} 秒前` : ""}`;
    $("pause").disabled = !running;
    $("resume").disabled = q.state !== "paused";
    $("stop").disabled = running || ["done", "stopped"].includes(q.state);
    $("openTask").disabled = !q.tabId;
  }
  renderRows();
}
function renderRows() {
  const scroller = document.querySelector('.table-wrap');
  const scrollTop = scroller.scrollTop;
  const list = rows();
  const overview = C.visibleRows(scopedRows(), {...filter(), status: ""});
  $("total").textContent = overview.length;
  $("pending").textContent = overview.filter(row => row.status === "pending").length;
  $("review").textContent = overview.filter(row => ["review", "failed", "rejected"].includes(row.status) || ["review", "failed"].includes(row.taskStatus)).length;
  const a = active();
  const allAccounts = $("scope").value === "all";
  const ids = selectedIds();
  $("rows").replaceChildren();
  $("empty").hidden = list.length > 0;
  $("listCount").textContent = `显示 ${list.length} / ${scopedRows().length} 单`;
  $("selection").textContent = `已选 ${ids.length} 单`;
  $("selectAll").checked = list.length > 0 && ids.length === list.length;
  $("selectAll").indeterminate = ids.length > 0 && ids.length < list.length;
  $("selectAll").disabled = allAccounts;
  $("apply").disabled = !ids.length || !a?.connected || model.queue?.state === "running" || allAccounts;
  $("download").disabled = $("apply").disabled;
  $("archiveSystem").disabled = $("download").disabled || !a?.erpTenant;
  $("refreshStatus").disabled = $("apply").disabled;
  $("export").disabled = !list.length;
  $("exportSummary").disabled = !list.length;
  $("exportHistory").disabled = !list.length;
  const totals = C.summarize(list);
  for (const [status, amountId, hintId] of [["issued", "issuedAmount", "issuedAmountHint"], ["submitted", "appliedAmount", "appliedAmountHint"], ["rejected", "rejectedAmount", "rejectedAmountHint"]]) {
    const bucket = totals[status];
    $(amountId).textContent = bucket.count && bucket.missing === bucket.count ? "待补充金额" : `¥ ${C.money(bucket.cents)}`;
    $(hintId).textContent = `${bucket.count} 单${bucket.missing ? ` · ${bucket.missing} 单金额缺失，未计入` : " · 金额已纳入汇总"}`;
  }
  const f = filter();
  $("periodLabel").textContent = f.from || f.to ? `${f.from || "不限起日"} — ${f.to || "不限止日"} ⌄` : "全部时间 ⌄";
  const missingDates = C.visibleRows(scopedRows(), {...f, from: "", to: ""}).filter(row => !row[f.dateBasis]).length;
  $("filterHint").textContent = [allAccounts ? "全部账号可汇总导出；批量申请请选当前账号" : "", (f.from || f.to) && missingDates ? `${missingDates} 单缺少所选时间，未参与本次筛选` : ""].filter(Boolean).join("；") || "支持按申请、开票或下单时间重新筛选";
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  pageIndex = Math.min(pageIndex, pages - 1);
  for (const suffix of ["", "Top"]) {
    $("pageInfo" + suffix).textContent = `第 ${pageIndex + 1} / ${pages} 页，共 ${list.length} 条记录`;
    $("previousPage" + suffix).disabled = pageIndex === 0;
    $("nextPage" + suffix).disabled = pageIndex >= pages - 1;
    $("pageSize" + suffix).value = String(pageSize);
    $("pageJump" + suffix).max = pages;
    if (document.activeElement !== $("pageJump" + suffix)) $("pageJump" + suffix).value = pageIndex + 1;
  }
  for (const row of list.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)) {
    const tr = node("tr");
    const checkCell = node("td");
    const check = node("input"); check.type = "checkbox"; check.checked = selected.has(row.id); check.disabled = allAccounts; check.setAttribute("aria-label", `选择订单 ${row.id}`);
    check.addEventListener("change", () => { check.checked ? selected.add(row.id) : selected.delete(row.id); renderRows(); });
    checkCell.append(check);
    const product = node("td");
    const card = node("div", "product-card"), thumb = node("button", "thumbnail", "无图"), description = node("div");
    if (/^https:\/\//.test(row.thumbnail || "")) {
      const img = node("img"); img.src = row.thumbnail; img.alt = row.product || "商品主图"; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => thumb.replaceChildren(document.createTextNode("无图")));
      thumb.replaceChildren(img); thumb.addEventListener("click", () => { $("imagePreview").src = row.thumbnail; $("imageDialog").showModal(); });
    }
    card.append(thumb, description); product.append(card); description.append(node("span", "product", row.product || "商品名称待补充"), node("span", "order-id", row.id));
    const shop = node("td", "row-shop", row.accountName); shop.append(node("span", "order-id", row.shop || "店铺未读取"));
    const amount = node("td"); amount.append(node("span", "", row.amount ? `¥ ${row.amount}` : "金额未读取"), node("span", "order-id", row.date || "日期未读取"));
    const status = node("td"); status.append(node("span", `status ${row.status}`, C.labels[row.status] || row.status));
    status.append(node("span", "invoice-amount", Number.isSafeInteger(row.invoiceAmountCents) ? `¥ ${C.money(row.invoiceAmountCents)}` : row.status === "issued" ? "票面金额待补充" : Number.isSafeInteger(row.applicationAmountCents) ? `申请 ¥ ${C.money(row.applicationAmountCents)}` : "申请金额待核对"));
    if(row.invoiceCompany?.name)status.append(node("span","order-id",`抬头：${row.invoiceCompany.name}`));
    if (row.taskStatus) status.append(node("span", "order-id", `助手：${C.labels[row.taskStatus] || row.taskStatus}`));
    const dates = node("td", "invoice-dates"); dates.append(node("div", "", `申请 ${row.appliedAt || "平台未提供"}`), node("div", "", `开票 ${row.issuedAt || "平台未提供"}`));
    const note = node("td", "row-note", row.note || "尚未处理");
    if (row.platformCheckedAt) note.append(node("div", "order-id", `最近核对 ${C.beijing(row.platformCheckedAt)}`));
    if (row.downloads?.length) note.append(node("div", "", row.downloads.every(d => d.state === "complete") ? "票据下载完成" : "请查看 Chrome 下载记录"));
    const actions = node("td"); const actionBox = node("div", "row-actions");
    for (const extra of new Set([row.rejectionReason, row.ledgerNote].filter(Boolean))) if (extra !== row.note) note.append(node("div", "", extra));
    actionBox.append(button("打开订单 ↗", async () => { notice("正在打开订单页面…"); await request("OPEN_ORDER", {accountId: row.accountId, orderId: row.id}); }, "", true));
    actionBox.append(button("查看发票 ↗", async () => request("OPEN_INVOICE", {accountId: row.accountId, orderId: row.id}), "", true));
    if (["failed", "review"].includes(row.taskStatus || row.status)) {
      const retry = button("重试读取状态", async () => { setModel(await request("START", {accountId: row.accountId, ids: [row.id], kind: "refresh"})); notice("正在重新读取状态，不会重复提交申请"); });
      retry.disabled = !a?.connected || model.queue?.state === "running" || allAccounts;
      actionBox.append(retry);
    }
    const resolve = button("编辑台账 / 历史", async () => openLedger(row));
    resolve.disabled = model.queue?.state === "running";
    actionBox.append(resolve);
    for(const file of row.cloudFiles||[]){
      actionBox.append(button(`${file.storage?.driver === "oss" ? "OSS 附件" : "旧系统附件"} · ${file.ext.toUpperCase()}`,async()=>request("ERP_FILE",{accountId:row.accountId,fileId:file.id}),"",true));
      if(file.storage?.driver !== "oss")actionBox.append(button("迁移此附件到私有 OSS",async()=>{
        await request("ERP_MIGRATE_FILE",{accountId:row.accountId,orderId:row.id,fileId:file.id,apply:false});
        if(!confirm("已校验旧系统附件。将此文件迁移到私有 OSS 并更新索引？本地原件不会删除。"))return;
        await request("ERP_MIGRATE_FILE",{accountId:row.accountId,orderId:row.id,fileId:file.id,apply:true});setModel(await request("STATE"));notice("附件已迁移到私有 OSS，本地原件仍保留");
      }));
    }
    actions.append(actionBox);
    tr.append(checkCell, product, shop, amount, status, dates, note, actions);
    $("rows").append(tr);
  }
  scroller.scrollTop = scrollTop;
}
const fieldLabels = {status: "开票状态", appliedAt: "申请时间", issuedAt: "开票时间", invoiceAmountCents: "票面金额", applicationAmountCents: "申请金额", invoiceNo: "发票号码", rejectionReason: "开票失败原因", ledgerNote: "台账备注"};
function historyValue(field, value) {
  if (value === null || value === undefined || value === "") return "未记录";
  if (field === "status") return C.labels[value] || value;
  if (field.endsWith("Cents")) return `¥ ${C.money(value)}`;
  return String(value);
}
function openLedger(row) {
  ledgerRef = {accountId: row.accountId, orderId: row.id};
  $("ledgerOrder").textContent = `${row.accountName} · ${row.id}`;
  $("ledgerStatus").value = ["pending", "submitted", "issued", "rejected"].includes(row.status) ? row.status : "";
  $("ledgerAppliedAt").value = row.appliedAt || "";
  $("ledgerIssuedAt").value = row.issuedAt || "";
  $("ledgerAmount").value = C.money(row.invoiceAmountCents);
  $("ledgerInvoiceNo").value = row.invoiceNo || "";
  $("ledgerReason").value = row.rejectionReason || "";
  $("ledgerNote").value = row.ledgerNote || "";
  $("ledgerHistory").replaceChildren();
  for (const entry of [...(row.history || [])].reverse()) {
    const line = node("div", "history-entry");
    line.append(node("strong", "", `${C.beijing(entry.at)} · ${entry.source === "manual" ? "人工核对" : "平台读取 / 申请结果"}`));
    for (const change of entry.changes) line.append(node("p", "", `${fieldLabels[change.field] || change.field}：${historyValue(change.field, change.before)} → ${historyValue(change.field, change.after)}`));
    $("ledgerHistory").append(line);
  }
  if (!row.history?.length) $("ledgerHistory").append(node("p", "help", "暂无变更记录"));
  $("ledgerDialog").showModal();
}
async function refreshTabs() {
  const previous = $("sourceTab").value;
  const tabs = await request("TABS");
  $("sourceTab").replaceChildren();
  if (!tabs.length) { const option = node("option", "", "请先打开拼多多订单页"); option.value = ""; $("sourceTab").append(option); }
  for (const tab of tabs) { const option = node("option", "", tab.title); option.value = tab.id; $("sourceTab").append(option); }
  if (tabs.some(t => String(t.id) === previous)) $("sourceTab").value = previous;
}
async function confirmBatch(kind, destination = "local") {
  if ($("scope").value === "all") throw new Error("请先选择当前采购账号，再开始批量处理");
  if (titleDirty && kind === "apply") throw new Error("请先保存发票抬头，再开始申请");
  const a = active();
  const chosen=selectedIds();
  const ids=kind === "apply" ? rows().filter(r=>chosen.includes(r.id) && r.status === "pending" && !["review","failed"].includes(r.taskStatus)).map(r=>r.id) : chosen;
  const skipped=chosen.length-ids.length;
  if (!ids.length) throw new Error(kind === "apply" ? "所选记录没有可申请订单，已申请、已开票及待核对记录保持原状态" : "请先勾选订单");
  if(destination === "system" && !a.titleCompanyId) throw new Error("请在设置中先选择 ERP 公司抬头并同步台账");
  const title = kind === "apply" ? C.validateTitle(a.title) : null;
  $("confirmTitle").textContent = kind === "apply" ? `申请 ${ids.length} 笔订单的发票` : `下载 ${ids.length} 笔订单的票据`;
  $("confirmBody").textContent = `采购账号：${a.name}。只处理本次可执行的 ${ids.length} 笔${skipped ? `，其余 ${skipped} 笔保留原状态并跳过` : ""}。`;
  $("confirmDetails").textContent = title ? `申请金额合计：¥ ${C.money(rows().filter(r => ids.includes(r.id)).reduce((n,r) => n + (r.applicationAmountCents ?? C.cents(r.amount) ?? 0), 0))}（仅已知金额）\n抬头：${title.company}\n税号：${title.taxId}\n备查邮箱：${title.email || "未设置"}\n类型：企业普通发票` : "文件将保存到 Chrome 下载目录下的「采购发票 / 账号备注」文件夹，按订单号命名。平台仅展示图片时，下载的是预览图；PDF 原件请在发票详情领取。";
  if(destination === "system") $("confirmDetails").textContent="发票原文件将保存到当前企业的私有 OSS，MySQL 仅保存台账和附件索引，单份上限5MB。OSS 不可用时明确报错；平台图片不会冒充 PDF。";
  $("confirmHint").textContent = kind === "apply" ? "已申请、已开票和待核对订单会跳过。平台表单未提供邮箱字段时，不随申请提交邮箱；原件领取时可另填。" : "仅保存平台提供的票据文件或发票预览图，不截取网页。";
  const dialog = $("confirmDialog");
  dialog.returnValue = "cancel";
  dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue), {once: true}));
  if (result !== "confirm") return;
  setModel(await request("START", {accountId: a.id, ids, kind, concurrency:Number($("concurrency").value),destination}));
  selected.clear();
  notice("任务已开始，可以在下方查看进度；请保持 Chrome 运行。");
}
$("cloudSync").addEventListener("click",()=>action(async()=>{notice("正在同步账号备注与台账到 ERP…");setModel(await request("ERP_SYNC",{accountId:model.active}));notice("系统台账同步完成，账号名称与开票记录已保存");}));
$("erpRefresh").addEventListener("click",()=>action(async()=>{setModel(await request("ERP_COMPANIES"));notice("ERP 公司信息已读取，请选择开票公司");}));
$("erpCompany").addEventListener("change",()=>action(async()=>{if(!$("erpCompany").value)return;setModel(await request("ERP_TITLE",{accountId:model.active,companyId:Number($("erpCompany").value)}));titleDirty=false;notice("已使用 ERP 的正式公司名称和税号，账号台账将自动同步");}));
$("erpRestore").addEventListener("click",()=>action(async()=>{if(!confirm("从当前企业系统恢复采购账号和台账？同一账号的本地记录会替换为系统版本；未同步修改请先导出备份。"))return;setModel(await request("ERP_RESTORE"));notice("已恢复系统采购账号与记录，操作拼多多前请核对并重新绑定登录");}));
$("archiveSystem").addEventListener("click",()=>action(()=>confirmBatch("download","system")));
$("version").textContent = `v${chrome.runtime.getManifest().version}`;
$("settingsOpen").addEventListener("click", () => { $("settingsDialog").showModal(); action(refreshTabs); });
$("closeSettings").addEventListener("click", () => $("settingsDialog").close());
for (const metric of document.querySelectorAll(".metric[data-status]")) metric.addEventListener("click", () => {
    $("status").value = metric.dataset.status;
  selected.clear(); pageIndex = 0; renderRows(); resetTableScroll();
});
document.addEventListener("click", event => {
  for (const menu of document.querySelectorAll(".toolbar-menu[open]")) {
    if (!menu.contains(event.target) || event.target.closest(".menu-popover button")) menu.open = false;
  }
});
$("addAccount").addEventListener("click", () => openAccount());
$("cancelAccount").addEventListener("click", () => $("accountDialog").close());
$("cancelLedger").addEventListener("click", () => $("ledgerDialog").close());
$("ledgerForm").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  const ledger = {status: $("ledgerStatus").value, appliedAt: $("ledgerAppliedAt").value.trim(), issuedAt: $("ledgerIssuedAt").value.trim(), invoiceAmount: $("ledgerAmount").value.trim(), invoiceNo: $("ledgerInvoiceNo").value, rejectionReason: $("ledgerReason").value, ledgerNote: $("ledgerNote").value};
  setModel(await request("LEDGER_SAVE", {...ledgerRef, ledger}));
  $("ledgerDialog").close(); notice("台账已更新，已保留本次变更记录。汇总金额同步更新。");
}); });
$("accountForm").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  const value = await request("ACCOUNT_SAVE", {accountId: editAccount, name: $("accountName").value});
  $("accountDialog").close(); setModel(value); notice("账号已绑定。请保存抬头，再读取订单。"); await refreshTabs();
}); });
for (const key of ["company", "taxId", "email"]) $(key).addEventListener("input", () => { titleDirty = true; $("titleHint").textContent = "有未保存修改"; $("titleHint").classList.add("dirty"); });
$("titleForm").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  const value = await request("TITLE_SAVE", {accountId: model.active, title: Object.fromEntries(["company", "taxId", "email"].map(key => [key, $(key).value]))});
  titleDirty = false; setModel(value); notice("发票抬头已保存。");
}); });
for (const id of ["openOrders", "firstOpen"]) $(id).addEventListener("click", () => action(async () => { await request("OPEN_ORDERS"); }));
$("openInvoices").addEventListener("click", () => action(() => request("OPEN_INVOICES")));
$("refreshTabs").addEventListener("click", () => action(refreshTabs));
$("scan").addEventListener("click", () => $("scanDialog").showModal());
$("scanCancel").addEventListener("click", () => $("scanDialog").close());
$("imageClose").addEventListener("click", () => $("imageDialog").close());
$("scanRange").addEventListener("change", () => { $("scanDates").hidden = $("scanRange").value !== "range"; });
$("scanOpen").addEventListener("click",async()=>{try{await request("OPEN_SCAN");}catch(error){notice(error.message,true);}});
$("scanStop").addEventListener("click", async () => { try { await request("SCAN_STOP"); notice("正在停止，已读取记录会保留"); } catch(e) { notice(e.message, true); } });
$("scanForm").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  const range = $("scanRange").value === "range";
  const from = range ? $("scanFrom").value : "", to = range ? $("scanTo").value : "";
  if (range && (!from || !to || from > to)) throw new Error("请选择有效的开始和结束日期");
  $("scanDialog").close(); notice("正在打开官方待申请历史订单…");
  const next = await request("SCAN_HISTORY", {accountId: model.active, from, to});
  setModel(next); notice(`${next.scan.note}${next.scanProgress?.missingDates ? `；${next.scanProgress.missingDates} 笔平台未提供下单日期，已保留供核对` : ""}`);
}); });
$("refreshProgress").addEventListener("click", () => action(async () => {
  const ids = selectedIds().length ? selectedIds() : active()?.orders.filter(r => ["submitted", "issued", "rejected"].includes(r.status)).map(r => r.id) || [];
  if (!ids.length) {
    notice("正在同步官方开票记录…");
    const next = await request("IMPORT_INVOICES", {accountId: model.active});
    setModel(next); notice(`已同步 ${next.scan.count} 条开票记录，可勾选订单继续更新详细进度`); return;
  }
  setModel(await request("START", {accountId: model.active, ids, kind: "refresh"})); notice("正在更新开票进度，具体结果在处理记录中显示");
}));
$("importInvoices").addEventListener("click", () => action(async () => {
  notice("正在读取官方已有发票记录和金额…");
  const next = await request("IMPORT_INVOICES", {accountId: model.active});
  setModel(next); notice(`已同步 ${next.scan.count} 条平台发票记录。选择订单后可刷新状态，补齐申请和开票日期。`);
  await refreshTabs();
}));
for (const id of ["query", "status", "from", "to", "dateBasis", "scope"]) $(id).addEventListener("input", () => { selected.clear(); pageIndex = 0; renderRows(); resetTableScroll(); });
$("clearFilters").addEventListener("click", () => { for (const id of ["query", "status", "from", "to"]) $(id).value = ""; selected.clear(); pageIndex = 0; renderRows(); resetTableScroll(); });
for (const suffix of ["", "Top"]) {
  $("previousPage" + suffix).addEventListener("click", () => { if (pageIndex > 0) pageIndex--; renderRows(); resetTableScroll(); });
  $("nextPage" + suffix).addEventListener("click", () => { pageIndex++; renderRows(); resetTableScroll(); });
  $("pageSize" + suffix).addEventListener("change", event => {
    pageSize = [20, 50, 100].includes(Number(event.target.value)) ? Number(event.target.value) : 50;
    pageIndex = 0; renderRows(); resetTableScroll();
  });
  $("pageJump" + suffix).addEventListener("change", event => {
    pageIndex = Math.max(0, Math.min(Math.ceil(rows().length / pageSize) - 1, Math.floor(Number(event.target.value) || 1) - 1));
    renderRows(); resetTableScroll();
  });
}
$("selectAll").addEventListener("change", () => { for (const row of rows()) $("selectAll").checked ? selected.add(row.id) : selected.delete(row.id); renderRows(); });
$("apply").addEventListener("click", () => action(() => confirmBatch("apply")));
$("download").addEventListener("click", () => action(() => confirmBatch("download")));
$("refreshStatus").addEventListener("click", () => action(async () => {
  if ($("scope").value === "all") throw new Error("请先选择当前采购账号，再刷新平台状态");
  setModel(await request("START", {accountId: model.active, ids: selectedIds(), kind: "refresh"}));
  selected.clear(); notice("正在查询平台上的开票状态，不提交申请。");
}));
for (const [id, type] of [["pause", "PAUSE"], ["resume", "RESUME"], ["stop", "STOP"]]) $(id).addEventListener("click", () => action(async () => setModel(await request(type))));
$("openTask").addEventListener("click", () => action(() => request("OPEN_TASK")));
function exportCsv(table, name) {
  const url = URL.createObjectURL(new Blob([C.csv(table)], {type: "text/csv;charset=utf-8"}));
  const link = node("a"); link.href = url; link.download = `${name}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function reportName() { return C.safeFilePart($("scope").value === "all" ? "全部账号" : active()?.name || "采购账号"); }
$("export").addEventListener("click", () => {
  const table = [["采购账号", "订单号", "店铺", "商品", "订单实付金额（元）", "下单日期（北京）", "发票状态", "申请时间（北京）", "开票时间（北京）", "票面金额（元）", "申请金额（元）", "发票号码", "开票失败原因", "台账备注", "助手处理状态", "处理记录", "最近平台核对时间（北京）", "更新时间（北京）", "订单链接"],
    ...rows().map(r => [r.accountName, r.id, r.shop, r.product, r.amount, r.date, C.labels[r.status] || r.status, r.appliedAt, r.issuedAt, C.money(r.invoiceAmountCents), C.money(r.applicationAmountCents), r.invoiceNo, r.rejectionReason, r.ledgerNote, C.labels[r.taskStatus] || "", r.note, C.beijing(r.platformCheckedAt), C.beijing(r.updated), r.url])];
  exportCsv(table, `采购开票明细_${reportName()}`);
});
$("exportSummary").addEventListener("click", () => {
  const totals = C.summarize(rows());
  const f = filter();
  exportCsv([["统计范围", "时间口径", "开始日期", "结束日期", "筛选状态", "汇总项目", "订单数", "已知金额合计（元）", "金额缺失未计入订单数"],
    ...[["issued", "成功票面金额"], ["submitted", "申请中订单金额"], ["rejected", "失败申请金额"]].map(([key, label]) => [reportName(), $("dateBasis").selectedOptions[0].textContent, f.from, f.to, f.status ? C.labels[f.status] : "全部状态", label, totals[key].count, C.money(totals[key].cents), totals[key].missing])], `采购开票汇总_${reportName()}`);
});
$("exportHistory").addEventListener("click", () => {
  exportCsv([["采购账号", "订单号", "变更时间（北京）", "来源", "变更字段", "变更前", "变更后"],
    ...rows().flatMap(row => (row.history || []).flatMap(entry => entry.changes.map(change => [row.accountName, row.id, C.beijing(entry.at), entry.source === "manual" ? "人工核对" : "平台", fieldLabels[change.field] || change.field, historyValue(change.field, change.before), historyValue(change.field, change.after)])))], `采购开票变更记录_${reportName()}`);
});
async function poll() {
  if (pollRunning) return;
  pollRunning = true;
  try { setModel(await request("STATE")); }
  catch (error) { notice(error.message, true); }
  finally { pollRunning = false; }
}
action(async () => { setModel(await request("STATE")); await refreshTabs(); try{setModel(await request("ERP_COMPANIES"));if(!model.accounts.length)setModel(await request("ERP_RESTORE"));}catch{} notice(active() ? "助手已就绪。核对当前账号和发票抬头后，可读取订单。" : "先打开拼多多订单页并登录，再绑定第一个采购账号。"); });
setInterval(poll, 2500);
