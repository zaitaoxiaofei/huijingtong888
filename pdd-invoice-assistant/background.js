import "./core.js";
import {readRenderedOrders, readInvoicePage, readPurchasePage} from "./page-reader.js";
const C = globalThis.PddInvoice;
const KEY = "pddInvoiceV1";
const ALARM = "pdd-invoice-recover";
let store;
let runner = false;
let scanBusy = false;
let scanContext = null;
let writeChain = Promise.resolve();
const boot = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  store = (await chrome.storage.local.get(KEY))[KEY] || {accounts: [], active: "", queue: null};
  C.recoverQueue(store.queue);
  if (store.lastScanProgress?.running) Object.assign(store.lastScanProgress, {running: false, complete: false, note: "上次读取中断，已保存记录；请重新同步继续读取"});
  if (store.queue) syncQueueRows();
  await save();
  if (!await chrome.alarms.get?.(ALARM)) await chrome.alarms.create(ALARM, {periodInMinutes: 0.5});
})();

function save() {
  const snapshot = structuredClone(store);
  writeChain = writeChain.catch(() => {}).then(() => chrome.storage.local.set({[KEY]: snapshot}));
  return writeChain;
}
function account(id) {
  const item = store.accounts.find(a => a.id === id);
  if (!item) throw new Error("请先在左侧添加并绑定采购账号");
  return item;
}
function busy() { return runner || scanBusy || store.queue?.state === "running"; }
function idleOnly() { if (busy()) throw new Error("请先暂停任务，并等待当前订单处理结束"); }
async function fingerprint() {
  const cookie = await chrome.cookies.get({url: C.ORIGIN, name: "PDDAccessToken"});
  if (!cookie?.value) throw new Error("未检测到拼多多登录状态，请打开订单页扫码登录后再绑定");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie.value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function assertSession(a, expected = a.fingerprint) {
  const current = await fingerprint();
  if (current !== expected || a.fingerprint !== expected) throw new Error("拼多多登录状态已改变。请切回该账号；如已重新登录，请在账号卡片中重新绑定并确认账号");
}
function syncQueueRows() {
  const q = store.queue;
  const a = store.accounts.find(item => item.id === q?.accountId);
  if (!a) return;
  for (const job of q.items) {
    const row = a.orders.find(item => item.id === job.id);
    if (!row) continue;
    row.note = job.note || "";
    const patch = {...job.facts};
    if (!["skipped", "processing", "downloading"].includes(job.status) && (job.status !== "pending" || job.facts?.platformCheckedAt)) {
      if (q.kind !== "download" || ["review", "failed"].includes(job.status)) {
        if (["review", "failed"].includes(job.status) && ["submitted", "issued", "rejected"].includes(row.status)) row.taskStatus = job.status;
        else patch.status = job.status;
      }
    }
    if (["submitted", "issued", "rejected"].includes(job.status) || job.status === "pending" && job.facts?.platformCheckedAt) row.taskStatus = "";
    if (q.kind === "download" && job.status === "downloaded") patch.status = "issued";
    if (q.kind === "download" && job.invoiceStatus === "issued") {
      patch.status = "issued";
      if (["review", "failed"].includes(job.status)) row.taskStatus = job.status;
    }
    C.recordLedger(row, patch, "platform", job.updated || Date.now());
    if (job.downloads) row.downloads = job.downloads;
    row.updated = job.updated;
  }
}
function publicState(current) {
  // Session fingerprints never go to page scripts, exports, or the dashboard.
  const result = structuredClone(store);
  result.scanProgress = scanContext ? {...scanContext.progress, running: true} : store.lastScanProgress;
  for (const a of result.accounts) { a.connected = a.fingerprint === current; delete a.fingerprint; }
  if (result.queue) delete result.queue.fingerprint;
  return result;
}
async function state() { return publicState(await fingerprint().catch(() => "")); }
function trustedUi(sender) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("dashboard.html"); }

async function pageMessage(tabId, message) {
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (!C.pddUrl(tab.url || "") && !C.pddUrl(tab.pendingUrl || "")) throw new Error("处理窗口已离开拼多多，请检查登录状态或验证码");
    if (tab.status === "complete" && !tab.pendingUrl) {
      try { return await chrome.tabs.sendMessage(tabId, message); }
      catch (error) {
        // Retry only connection setup; never repeat a potentially executed command.
        if (!/Receiving end does not exist|Could not establish connection/.test(error.message)) throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error("拼多多页面加载超时，请检查处理窗口后继续");
}
async function visit(tabId, url) {
  if (!C.pddUrl(url)) throw new Error("订单链接不是受支持的拼多多买家页面");
  await chrome.tabs.update(tabId, {url, active: false});
}
async function scan(message) {
  idleOnly();
  const a = account(message.accountId);
  await assertSession(a);
  const tab = await chrome.tabs.get(message.tabId);
  if (tab.incognito || !C.pddUrl(tab.url || tab.pendingUrl || "")) throw new Error("请选择普通 Chrome 窗口中已登录的拼多多订单页");
  scanBusy = true;
  scanContext = {tabId: tab.id, accountId: a.id, fingerprint: a.fingerprint, from: message.from || "", to: message.to || ""};
  try {
    const result = await pageMessage(tab.id, {type: "PDD_INVOICE_SCAN", loadMore: Boolean(message.loadMore), history: Boolean(message.history), purchase: Boolean(message.purchase), from: message.from || "", to: message.to || ""});
    await assertSession(a);
    if (!result?.ok) throw new Error(result?.error || "未能读取订单，请刷新拼多多页面后重试");
    a.orders = C.mergeOrders(a.orders, result.rows);
    store.lastScanProgress = {...scanContext.progress, running: false, note: result.note, complete: result.complete};
    a.scannedAt = Date.now();
    await save();
    return {...await state(), scanProgress: store.lastScanProgress, scan: {count: result.count ?? result.rows.length, note: result.note, complete: Boolean(result.complete)}};
  } catch (error) {
    store.lastScanProgress = {...scanContext?.progress, running: false, complete: false, note: error.message};
    await save(); throw error;
  } finally { scanBusy = false; scanContext = null; }
}

async function startQueue(message) {
  idleOnly();
  const a = account(message.accountId);
  await assertSession(a);
  if (!message.ids?.length) throw new Error("请先勾选要处理的订单");
  if (!["apply", "download", "refresh"].includes(message.kind)) throw new Error("未知任务类型");
  if (store.queue?.items.some(item => item.status === "pending")) throw new Error("上次任务还有待处理订单，请先继续或结束上次任务");
  const title = message.kind === "apply" ? C.validateTitle(a.title) : null;
  const selected = new Set(message.ids);
  const rows = a.orders.filter(row => selected.has(row.id));
  if (rows.length !== selected.size) throw new Error("部分订单已不存在，请刷新列表后重新勾选");
  const items = rows.map(row => {
    const skip = message.kind === "apply" && row.status !== "pending";
    const downloaded = message.kind === "download" && row.downloads?.length;
    return {id: row.id, url: row.url, status: skip || downloaded ? "skipped" : "pending",
      note: skip ? "该订单不是待申请状态，请先打开订单核对" : downloaded ? "该订单已有下载记录，请先在 Chrome 下载记录核对，本次跳过" : ""};
  });
  store.queue = {id: crypto.randomUUID(), accountId: a.id, fingerprint: a.fingerprint, kind: message.kind,
    title, items, state: "running", created: Date.now(), tabId: null, note: "正在准备处理窗口"};
  syncQueueRows();
  await save();
  void runQueue();
  return state();
}

async function runQueue() {
  await boot;
  if (runner || store.queue?.state !== "running") return;
  runner = true;
  const q = store.queue;
  try {
    const a = account(q.accountId);
    await assertSession(a, q.fingerprint);
    // Keep the tab for inspection. Never close a window containing an uncertain result.
    if (!q.tabId || !await chrome.tabs.get(q.tabId).catch(() => null)) {
      const tab = await chrome.tabs.create({url: C.ORIGIN + "/orders.html", active: false});
      q.tabId = tab.id;
      await save();
    }
    for (const item of q.items) {
      if (q.state !== "running") break;
      if (item.status !== "pending") continue;
      await assertSession(a, q.fingerprint);
      item.status = "processing";
      item.updated = Date.now();
      item.stage = "open";
      q.note = `正在${({apply: "申请", download: "下载", refresh: "查询状态"})[q.kind]}：${item.id}`;
      syncQueueRows();
      await save();
      try {
        await visit(q.tabId, q.kind === "apply" ? a.orders.find(row => row.id === item.id)?.applicationUrl || C.invoiceUrl(item.id) : C.invoiceUrl(item.id));
        let result;
        for (let hop = 0; hop < 4; hop++) {
          await assertSession(a, q.fingerprint);
          if (q.state !== "running") { result = {status: "pending", note: "已暂停，尚未提交"}; break; }
          result = await pageMessage(q.tabId, {type: "PDD_INVOICE_PROCESS", queueId: q.id, orderId: item.id, kind: q.kind, title: q.title});
          if (!result?.ok) throw new Error(result?.error || "页面未返回处理结果");
          if (!result.next) break;
          if (!C.pddUrl(result.next) || C.orderId(result.next) !== item.id) throw new Error("开票链接的订单号不匹配，请人工核对");
          await visit(q.tabId, result.next);
        }
        if (result?.next) result = {status: "review", note: "页面跳转次数超限，请打开订单手动核对"};
        if (result?.files?.length && q.kind === "download") {
          item.invoiceStatus = "issued";
          item.downloads = [];
          // Persist each download intent before starting it. An interrupted intent is never auto-retried.
          for (const [index, value] of result.files.entries()) {
            await assertSession(a, q.fingerprint);
            if (q.state !== "running") break;
            const file = C.invoiceFile(value);
            if (!file) continue;
            item.downloads.push({state: "starting", ext: file.ext});
            await save();
            const id = await chrome.downloads.download({url: file.url,
      filename: `采购发票/${C.safeFilePart(a.name)}/${C.safeFilePart(item.id)}_${index + 1}${["png", "jpg", "jpeg"].includes(file.ext) ? "_平台图片" : ""}.${file.ext}`, conflictAction: "uniquify", saveAs: false});
            Object.assign(item.downloads.at(-1), {id, state: "in_progress"});
            syncQueueRows();
            await save();
          }
          result = item.downloads.length ? {
            status: item.downloads.every(d => d.state === "complete") ? "downloaded" : item.downloads.some(d => d.state === "interrupted") ? "review" : "downloading",
            note: "已交给 Chrome 下载，请查看下载记录确认文件", facts: result.facts} : {status: "review", note: "下载前任务已暂停，请核对后重新选择"};
        }
        const allowed = ["pending", "submitted", "issued", "rejected", "skipped", "review", "downloading", "downloaded"];
        item.status = allowed.includes(result?.status) ? result.status : "review";
        item.note = result?.note || "页面没有可确认的结果，请人工核对";
        item.facts = result?.facts;
        if (result?.block || item.status === "review") { q.state = "paused"; q.note = item.note; }
      } catch (error) {
        item.status = ["authorized", "confirmed"].includes(item.stage) || q.kind === "download" ? "review" : "failed";
        item.note = error.message;
        // Successful submit may navigate and destroy the message channel. Inspect
        // the new page read-only; never re-run an application to recover its reply.
        if (["authorized", "confirmed"].includes(item.stage)) {
          try {
            await assertSession(a, q.fingerprint);
            // Merchant applications navigate to chat and destroy the reply channel.
            // Recover only through the official invoice detail, never by re-submitting.
            await visit(q.tabId, C.invoiceUrl(item.id));
            const inspected = await pageMessage(q.tabId, {type: "PDD_INVOICE_INSPECT", orderId: item.id});
            if (inspected?.ok && ["submitted", "issued", "rejected"].includes(inspected.status)) {
              item.status = inspected.status; item.note = inspected.note; item.facts = inspected.facts;
            }
          } catch { /* Preserve uncertain status. */ }
        }
        if (!["submitted", "issued", "rejected"].includes(item.status)) { q.state = "paused"; q.note = error.message; }
      }
      item.updated = Date.now();
      syncQueueRows();
      await save();
      if (q.state === "running") await new Promise(resolve => setTimeout(resolve, 2500));
    }
    if (q.state === "running") { q.state = "done"; q.note = "本批处理结束，请核对结果；已申请不代表商家已开票"; }
  } catch (error) { q.state = "paused"; q.note = error.message; }
  finally {
    runner = false;
    syncQueueRows();
    await save();
    await chrome.action.setBadgeText({text: q.state === "paused" ? "!" : ""});
    await chrome.action.setBadgeBackgroundColor({color: "#bd4a32"});
  }
}

async function authorize(message, sender) {
  const q = store.queue;
  const item = q?.items.find(row => row.id === message.orderId && row.status === "processing");
  if (!sender.tab || sender.tab.id !== q?.tabId || sender.frameId !== 0 || q?.id !== message.queueId || !item || q.state !== "running" || q.kind !== "apply") throw new Error("任务已暂停或订单不匹配，未提交申请");
  if (C.orderId(sender.url) !== item.id) throw new Error("当前开票页面的订单号不匹配");
  await assertSession(account(q.accountId), q.fingerprint);
  const confirming = message.phase === "confirm";
  if (q.state !== "running" || (confirming ? item.stage !== "authorized" : item.stage !== "open")) throw new Error("任务已暂停，或本单已授权提交，禁止重复提交");
  item.stage = confirming ? "confirmed" : "authorized";
  await save();
  return {authorized: true};
}

async function handle(message, sender) {
  await boot;
  if (message.type === "PDD_INVOICE_AUTHORIZE") return authorize(message, sender);
  if (message.type === "PDD_INVOICE_PAGE_STATE") {
    const q = store.queue;
    if (!q || sender.tab?.id !== q.tabId || sender.frameId !== 0 || !C.pddUrl(sender.url)) throw new Error("没有与该页面匹配的处理任务");
    await assertSession(account(q.accountId), q.fingerprint);
    const [result] = await chrome.scripting.executeScript({target: {tabId: sender.tab.id}, world: "MAIN", func: readInvoicePage});
    return result?.result || {ready: false};
  }
  if (message.type === "PDD_INVOICE_SCAN_PROGRESS") {
    if (!scanContext || sender.tab?.id !== scanContext.tabId || sender.frameId !== 0 || !C.pddUrl(sender.url)) throw new Error("没有匹配的读取任务");
    const a = account(scanContext.accountId);
    await assertSession(a, scanContext.fingerprint);
    const incoming = (message.rows || []).filter(row => {
      const date = row.date || a.orders.find(old => old.id === row.id)?.date;
      return !date || (!scanContext.from || date >= scanContext.from) && (!scanContext.to || date <= scanContext.to);
    });
    a.orders = C.mergeOrders(a.orders, incoming);
    const missingDates = incoming.filter(row => !(row.date || a.orders.find(old => old.id === row.id)?.date)).length;
    scanContext.progress = {...message.progress, missingDates};
    store.lastScanProgress = {...scanContext.progress, running: true};
    await save(); return {};
  }
  if (message.type === "PDD_INVOICE_PURCHASE_PAGE") {
    if (!scanContext || sender.tab?.id !== scanContext.tabId || sender.frameId !== 0 || !C.pddUrl(sender.url) || new URL(sender.url).pathname !== "/orders.html") throw new Error("没有匹配的采购读取任务");
    await assertSession(account(scanContext.accountId), scanContext.fingerprint);
    const [result] = await chrome.scripting.executeScript({target: {tabId: sender.tab.id}, world: "MAIN", func: readPurchasePage, args: [String(message.offset || "")]});
    return result?.result;
  }
  if (message.type === "PDD_INVOICE_RENDERED_ROWS") {
    if (!scanContext || sender.tab?.id !== scanContext.tabId || sender.frameId !== 0 || !C.pddUrl(sender.url)) throw new Error("没有进行中的订单读取任务");
    await assertSession(account(scanContext.accountId), scanContext.fingerprint);
    const [result] = await chrome.scripting.executeScript({target: {tabId: sender.tab.id}, world: "MAIN", func: readRenderedOrders});
    return result?.result || [];
  }
  if (!trustedUi(sender)) throw new Error("此操作只能在开票助手面板执行");
  switch (message.type) {
    case "STATE": return state();
    case "TABS": return (await chrome.tabs.query({url: C.ORIGIN + "/*"})).filter(t => !t.incognito && t.id !== store.queue?.tabId)
      .sort((a, b) => Number(!(a.url || "").includes("/orders.html")) - Number(!(b.url || "").includes("/orders.html")))
      .map(t => ({id: t.id, title: t.title || "拼多多页面"}));
    case "OPEN_ORDERS": await chrome.tabs.create({url: C.ORIGIN + "/orders.html"}); return {};
    case "OPEN_INVOICES": await chrome.tabs.create({url: C.ORIGIN + "/commercial_pre_orders.html?_t_module_name=psnl_invoice_assistant"}); return {};
    case "ACCOUNT_SAVE": {
      idleOnly();
      const name = String(message.name || "").trim().slice(0, 30);
      if (!name) throw new Error("请填写账号备注，例如「采购号 1」");
      const fp = await fingerprint();
      const duplicate = store.accounts.find(a => a.fingerprint === fp && a.id !== message.accountId);
      if (duplicate) throw new Error(`当前登录状态已绑定「${duplicate.name}」，请先切换拼多多账号`);
      let a;
      if (message.accountId) {
        a = account(message.accountId);
        if (store.queue?.accountId === a.id && store.queue.items.some(j => j.status === "pending")) throw new Error("此账号还有未完成任务，请先结束任务再重新绑定");
        // Rebinding confirms a renewed login only. No cookie jar or credential is copied.
        a.name = name; a.fingerprint = fp;
      } else {
        if (store.accounts.length >= 3) throw new Error("当前支持三个采购账号，请使用已有账号卡片");
        a = {id: crypto.randomUUID(), name, fingerprint: fp, title: {}, orders: []};
        store.accounts.push(a);
      }
      store.active = a.id;
      await save();
      return state();
    }
    case "ACCOUNT_SELECT": account(message.accountId); store.active = message.accountId; await save(); return state();
    case "TITLE_SAVE": idleOnly(); account(message.accountId).title = C.validateTitle(message.title); await save(); return state();
    case "SCAN_STOP": if (scanContext) await chrome.tabs.sendMessage(scanContext.tabId, {type: "PDD_INVOICE_SCAN_STOP"}); return {};
    case "SCAN_HISTORY": {
      idleOnly();
      if (message.from && !C.normalizeDate(message.from) || message.to && !C.normalizeDate(message.to) || message.from && message.to && message.from > message.to) throw new Error("请选择有效的下单日期范围");
      await assertSession(account(message.accountId));
      // Read the purchase list first: invoice history often omits purchase dates,
      // shop names and paid amounts. Merge official records by exact order ID.
      const purchase = await chrome.tabs.create({url: C.ORIGIN + "/orders.html", active: false});
      const loaded = await scan({...message, tabId: purchase.id, history: false, purchase: true, loadMore: true});
      if (loaded.scan.note.startsWith("已停止")) return loaded;
      account(message.accountId).purchaseHistory = {...loaded.scanProgress, count: loaded.scan.count, checkedAt: Date.now()};
      await save();
      await chrome.tabs.update(purchase.id, {url: C.ORIGIN + "/commercial_pre_orders.html?_t_module_name=psnl_invoice_assistant&active_tab=3", active: false});
      const tab = purchase;
      const invoices = await scan({...message, tabId: tab.id, history: true, loadMore: true});
      const a = account(message.accountId);
      a.purchaseHistory = {...loaded.scanProgress, count: loaded.scan.count, checkedAt: Date.now()};
      store.lastScanProgress = {...invoices.scanProgress, running: false, purchaseComplete: Boolean(loaded.scan.complete),
        note: `采购订单 ${loaded.scan.count} 笔，${loaded.scan.complete ? "已读到实际最早记录" : "本次尚未确认全部读完"}；${invoices.scan.note}`};
      await save();
      return {...await state(), scanProgress: store.lastScanProgress, scan: {count: loaded.scan.count, note: store.lastScanProgress.note}};
    }
    case "SCAN": return scan(message);
    case "IMPORT_INVOICES": {
      idleOnly();
      await assertSession(account(message.accountId));
      const tab = await chrome.tabs.create({url: C.ORIGIN + "/commercial_pre_orders.html?_t_module_name=psnl_invoice_assistant", active: false});
      return scan({accountId: message.accountId, tabId: tab.id, loadMore: true});
    }
    case "START": return startQueue(message);
    case "PAUSE": if (store.queue) { store.queue.state = "paused"; store.queue.note = "已暂停；当前已提交的操作仍会记录结果"; await save(); } return state();
    case "RESUME": {
      idleOnly();
      const q = store.queue;
      if (!q || q.state !== "paused") throw new Error("没有可继续的暂停任务");
      if (q.items.some(j => j.status === "review")) throw new Error("请先打开待核对订单，在列表中确认实际状态，再继续任务");
      await assertSession(account(q.accountId), q.fingerprint);
      q.state = "running"; await save(); void runQueue(); return state();
    }
    case "STOP": {
      idleOnly();
      if (store.queue) { store.queue.state = "stopped"; for (const j of store.queue.items) if (j.status === "pending") { j.status = "skipped"; j.note = "本次任务已结束，未执行"; } await save(); }
      return state();
    }
    case "LEDGER_SAVE": {
      idleOnly();
      const a = account(message.accountId);
      const row = a.orders.find(o => o.id === message.orderId);
      if (!row) throw new Error("订单不存在，请刷新列表");
      const input = message.ledger || {};
      if (!["pending", "submitted", "issued", "rejected"].includes(input.status)) throw new Error("请选择实际开票状态");
      const amount = String(input.invoiceAmount || "").trim();
      const amountCents = amount ? C.cents(amount) : null;
      if (amount && amountCents === null) throw new Error("请在「票面金额」填写非负数字，最多保留两位小数");
      const appliedAt = C.normalizeDate(input.appliedAt);
      const issuedAt = C.normalizeDate(input.issuedAt);
      if (input.appliedAt && !appliedAt) throw new Error("请检查「申请时间」，使用有效日期或日期时间");
      if (input.issuedAt && !issuedAt) throw new Error("请检查「开票时间」，使用有效日期或日期时间");
      C.recordLedger(row, {status: input.status, appliedAt, issuedAt, invoiceAmountCents: amountCents,
        invoiceNo: String(input.invoiceNo || "").trim().slice(0, 80), rejectionReason: String(input.rejectionReason || "").trim().slice(0, 500), ledgerNote: String(input.ledgerNote || "").trim().slice(0, 1000)}, "manual");
      row.taskStatus = "";
      const job = store.queue?.accountId === a.id && store.queue.items.find(j => j.id === row.id);
      if (job) { job.status = "skipped"; job.note = "用户已核对并编辑台账，后续任务请重新选择"; job.facts = undefined; }
      await save(); return state();
    }
    case "OPEN_ORDER": {
      const row = account(message.accountId).orders.find(o => o.id === message.orderId);
      if (!row || !C.pddUrl(row.url)) throw new Error("没有可打开的订单链接");
      await chrome.tabs.create({url: row.url}); return {};
    }
    case "OPEN_INVOICE": {
      const row = account(message.accountId).orders.find(o => o.id === message.orderId);
      if (!row) throw new Error("订单不存在");
      await chrome.tabs.create({url: C.invoiceUrl(row.id)}); return {};
    }
    case "OPEN_TASK": if (store.queue?.tabId) await chrome.tabs.update(store.queue.tabId, {active: true}); return {};
    default: throw new Error("未知操作，请重新打开插件");
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.module !== "PDD_INVOICE") return false;
  handle(message, sender).then(value => reply({ok: true, value}), error => reply({ok: false, error: error.message}));
  return true;
});
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const [existing] = await chrome.tabs.query({url});
  if (existing) { await chrome.tabs.update(existing.id, {active: true}); await chrome.windows.update(existing.windowId, {focused: true}); }
  else await chrome.tabs.create({url});
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM) return;
  await boot;
  if (!runner && store.queue?.state === "running") void runQueue();
});
chrome.cookies.onChanged.addListener(async change => {
  if (change.cookie.name !== "PDDAccessToken" || !/(^|\.)pinduoduo\.com$/.test(change.cookie.domain.replace(/^\./, ""))) return;
  await boot;
  if (store.queue?.state === "running") {
    store.queue.state = "paused";
    store.queue.note = "拼多多登录状态发生变化，已暂停，请核对当前采购账号";
    await save();
  }
});
chrome.downloads?.onChanged?.addListener(async delta => {
  if (!delta.state) return;
  await boot;
  const q = store.queue;
  if (!q) return;
  for (const item of q.items) {
    const download = item.downloads?.find(d => d.id === delta.id);
    if (!download) continue;
    download.state = delta.state.current;
    if (item.downloads.every(d => d.state === "complete")) { item.status = "downloaded"; item.note = "票据已下载到 Chrome 下载目录下的「采购发票」文件夹"; }
    else if (item.downloads.some(d => d.state === "interrupted")) {
      item.status = "review"; item.note = "Chrome 下载中断，请打开下载记录检查";
      if (q.state === "running") { q.state = "paused"; q.note = item.note; }
    }
    syncQueueRows(); await save();
  }
  // Preserve download completion even if the user has started another batch.
  for (const a of store.accounts) for (const row of a.orders) {
    const download = row.downloads?.find(d => d.id === delta.id);
    if (download) { download.state = delta.state.current; await save(); }
  }
});
