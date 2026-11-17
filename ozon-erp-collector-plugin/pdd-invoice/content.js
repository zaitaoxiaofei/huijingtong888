(() => {
  if (globalThis.__pddInvoiceInstalled) return;
  globalThis.__pddInvoiceInstalled = true;
  const C = globalThis.PddInvoice;
  const rpc = message => chrome.runtime.sendMessage({module: "PDD_INVOICE", ...message});
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const text = () => clean(document.body?.innerText);
  const visible = el => Boolean(el?.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
  let executing = false;

  function blocker() {
    if (/\/login\.html/.test(location.pathname) || document.querySelector('input[placeholder="验证码"]')) return "请在拼多多页面完成登录，然后重新绑定当前采购账号";
    if (/请完成.{0,8}验证|拖动.{0,12}滑块|安全验证|访问过于频繁|操作过于频繁/.test(text())) return "拼多多要求安全验证或限制访问，请在处理窗口人工完成后继续";
    return "";
  }
  function targets(names) {
    // Include div/span buttons used by PDD, but only exact, compact text matches.
    return [...document.querySelectorAll("button,a,[role=button],span,div")].filter(el => {
      if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (!names.includes(clean(el.innerText))) return false;
      return ![...el.children].some(child => visible(child) && clean(child.innerText) === clean(el.innerText));
    });
  }
  function uniqueTarget(names) {
    const found = targets(names);
    return found.length === 1 ? found[0] : null;
  }
  function getRowContainer(anchor, id) {
    let current = anchor;
    let best = anchor;
    for (let i = 0; current && i < 10; i++, current = current.parentElement) {
      const ids = new Set([...current.querySelectorAll("a[href]")].map(a => C.orderId(a.href)).filter(Boolean));
      if ([...ids].some(value => value !== id) || clean(current.innerText).length > 1800) break;
      if (ids.size === 1) best = current;
    }
    return best;
  }
  function extractOrders() {
    const rows = new Map();
    for (const anchor of document.querySelectorAll("a[href]")) {
      const url = C.pddUrl(anchor.href);
      const id = C.orderId(url);
      if (!url || !id || !/order|invoice/i.test(new URL(url).pathname)) continue;
      const container = getRowContainer(anchor, id);
      const value = clean(container.innerText);
      const status = /已开票/.test(value) ? "issued" : /开票申请已提交|申请中|等待商家开票/.test(value) ? "submitted" : /待发货|退款成功|交易关闭|待付款|待支付|售后中/.test(value) ? "skipped" : "pending";
      const date = value.match(/(?:下单|订单|创建|成交)时间[：:\s]*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
      const amount = value.match(/(?:实付|实付款|实际付款|付款金额|合计)[：:\s]*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/)?.[1] || "";
      const lines = (container.innerText || "").split(/\n/).map(clean).filter(Boolean);
      const shop = container.querySelector('[class*="mall-name"], [class*="mallName"], [class*="shop-name"]')?.textContent || lines.find(line => /旗舰店|专营店|专卖店|店铺/.test(line)) || "";
      const product = container.querySelector('img[alt]:not([alt=""])')?.alt || lines.find(line => line.length > 8 && !/订单号|订单编号|申请|发票|实付|付款|收货|物流/.test(line)) || "";
      const candidate = {id, url, shop: clean(shop), product: clean(product).slice(0, 180), amount,
        date: date ? `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}` : "", status,
        note: status === "skipped" ? "页面显示退款、关闭、待付款或售后状态" : ""};
      if (!rows.has(id) || /order\.html|order_detail/i.test(new URL(url).pathname)) rows.set(id, candidate);
    }
    // A detail page is also a valid import source when the list uses JS-only navigation.
    const currentId = C.orderId(location.href);
    if (currentId && !rows.has(currentId)) {
      const value = text();
      rows.set(currentId, {id: currentId, url: C.pddUrl(location.href), shop: "", product: "", amount: "", date: "",
        status: /已开票/.test(value) ? "issued" : /开票申请已提交|等待商家开票/.test(value) ? "submitted" : "pending", note: "从当前详情页导入"});
    }
    return [...rows.values()];
  }
  async function scan(loadMore) {
    const error = blocker();
    if (error) throw new Error(error);
    const all = new Map();
    const originalY = window.scrollY;
    let unchanged = 0;
    const passes = loadMore ? 18 : 1;
    try {
      for (let i = 0; i < passes; i++) {
        const before = all.size;
        for (const row of extractOrders()) all.set(row.id, row);
        const rendered = await rpc({type: "PDD_INVOICE_RENDERED_ROWS"});
        if (!rendered?.ok) throw new Error(rendered?.error || "读取页面订单失败");
        for (const row of rendered.value) all.set(row.id, row);
        if (!loadMore) break;
        unchanged = all.size === before ? unchanged + 1 : 0;
        if (unchanged >= 3 || blocker()) break;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(700);
      }
      if (blocker()) throw new Error(blocker());
    } finally { window.scrollTo(0, originalY); }
    if (!all.size) throw new Error("当前页面没有可识别的订单链接。请打开「我的订单」并加载订单；也可进入单笔订单详情后读取。若仍无法读取，请保留该页用于适配");
    return {rows: [...all.values()], note: loadMore ? "已滚动读取本次加载的订单；历史订单是否完整以拼多多页面为准" : "已读取当前页面已加载的订单"};
  }
  function nextLink(id, kind) {
    const links = [...document.querySelectorAll("a[href]")].map(el => ({el, url: C.pddUrl(el.href)}))
      .filter(item => item.url && C.orderId(item.url) === id && item.url !== location.href);
    const invoice = links.filter(({el, url}) => /invoice|发票|开票/.test(url + clean(el.innerText)));
    const named = invoice.filter(({el}) => kind === "apply" ? /申请.*发票|申请.*开票/.test(clean(el.innerText)) : /查看发票|发票详情/.test(clean(el.innerText)));
    if (named.length === 1) return named[0].url;
    if (invoice.length === 1) return invoice[0].url;
    return "";
  }
  function fieldText(input) {
    const labels = [...(input.labels || [])].map(l => l.textContent);
    const labelled = (input.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent);
    const nearby = input.parentElement?.innerText?.length < 120 ? input.parentElement.innerText : "";
    return clean([input.placeholder, input.getAttribute("aria-label"), ...labels, ...labelled, nearby].join(" "));
  }
  function field(pattern) {
    const fields = [...document.querySelectorAll('input:not([type="hidden"]),textarea')].filter(input => visible(input) && !input.disabled && pattern.test(fieldText(input)));
    return fields.length === 1 ? fields[0] : null;
  }
  function setValue(input, value) {
    if (!input || input.readOnly) return false;
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
    return input.value === value;
  }
  function hasSummary(title) {
    const value = text();
    // Exact tax ID boundary prevents accepting another company's longer identifier.
    const tokens = value.toUpperCase().match(/[A-Z0-9]{15,}/g) || [];
    return value.includes(title.company) && tokens.includes(title.taxId);
  }
  async function prepareTitle(title) {
    const enterprise = uniqueTarget(["单位", "企业", "企业单位"]);
    if (enterprise) { enterprise.click(); await sleep(250); }
    const company = field(/单位名称|企业名称|公司名称|发票抬头|抬头名称/);
    const tax = field(/税号|纳税人识别号|社会信用代码/);
    const email = field(/收票邮箱|电子邮箱|邮箱地址|电子邮件|接收邮箱/);
    if (company && tax) {
      if (!setValue(company, title.company) || !setValue(tax, title.taxId)) return false;
      if (title.email && email && !setValue(email, title.email)) return false;
      await sleep(250);
      return company.value === title.company && tax.value.toUpperCase() === title.taxId && (!title.email || !email || email.value === title.email);
    }
    return hasSummary(title);
  }
  function fileLinks() {
    const links = [];
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (!visible(anchor)) continue;
      const file = C.invoiceFile(anchor.href);
      if (file && /发票|票据|PDF|OFD|XML|下载|电子票/i.test(clean(anchor.innerText) + " " + anchor.getAttribute("download"))) links.push(file.url);
    }
    // Verified official invoice image source. This is the platform's preview,
    // not a screenshot, and must not be represented as a PDF original.
    for (const img of document.images) {
      try {
        const url = new URL(img.currentSrc || img.src);
        if (url.hostname === "pfs.yangkeduo.com" && url.pathname.startsWith("/order_invoice/") && C.invoiceFile(url.href)) links.push(url.href);
      } catch { /* Ignore non-file images. */ }
    }
    return [...new Set(links)];
  }
  async function invoiceState() {
    for (let i = 0; i < 16; i++) {
      const response = await rpc({type: "PDD_INVOICE_PAGE_STATE"});
      if (!response?.ok) throw new Error(response?.error || "读取开票状态失败");
      if (response.value.ready) return response.value;
      if (blocker()) throw new Error(blocker());
      await sleep(300);
    }
    throw new Error("发票页面还没有加载完成，请检查处理窗口后继续");
  }
  async function inspectOrder(id) {
    const state = await invoiceState();
    if (state.orderId !== id) return {status: "review", note: "发票页面订单号不匹配"};
    let status = "pending";
    if (/开票成功|已开票/.test(state.displayText) && state.hasApplied) status = "issued";
    else if (state.rejected || /失败|拒绝|驳回|退款/.test(state.displayText)) status = "rejected";
    else if (state.hasApplied) status = fileLinks().length ? "issued" : "submitted";
    return {status, note: status === "pending" ? "平台显示尚未申请发票" : state.rejectionReason || state.displayText || C.labels[status], facts: factsFrom(state, status)};
  }
  function factsFrom(state, status) {
    const facts = {platformCheckedAt: Date.now()};
    if (state.hasApplied || status === "rejected") {
      const applied = C.normalizeDate(state.applicationTime);
      if (applied) facts.appliedAt = applied;
    }
    if (status === "issued") {
      const issued = C.normalizeDate(state.invoiceTime);
      if (issued) facts.issuedAt = issued;
      const amount = C.cents(state.invoiceAmount);
      if (amount !== null) facts.invoiceAmountCents = amount;
    }
    if (status === "rejected") facts.rejectionReason = state.rejectionReason || state.displayText || "平台显示开票失败";
    return facts;
  }
  async function processOrder(message) {
    const error = blocker();
    if (error) return {status: "review", note: error, block: true};
    if (C.orderId(location.href) !== message.orderId) return {status: "review", note: "当前页面的订单号不匹配，未进行操作", block: true};
    // Wait briefly for React/mobile page hydration, without calling private APIs.
    for (let i = 0; i < 8 && text().length < 30; i++) await sleep(250);
    const value = text();
    const state = await invoiceState();
    if (state.orderId !== message.orderId) return {status: "review", note: "平台返回的发票订单号不匹配", block: true};
    if (message.kind === "refresh") return inspectOrder(message.orderId);
    if (/预计拼单成功后.{0,12}发货|退款成功|交易关闭|售后处理中|退款处理中|等待付款/.test(value)) return {status: "skipped", note: "页面显示待发货、退款、关闭、售后或待付款，已跳过"};
    const next = nextLink(message.orderId, message.kind);
    if (next) return {next};
    if (!/发票|开票/.test(value)) return {status: "review", note: "没有识别到发票入口，请打开订单核对，当前页面需要适配"};
    if (message.kind === "download") {
      if (!state.hasApplied) return {status: "skipped", note: "平台显示尚未申请发票，没有可下载票据"};
      const files = fileLinks();
      if (files.length) return {files, facts: factsFrom(state, "issued")};
      return {status: /开票中|等待商家|申请已提交|申请成功/.test(value) ? "skipped" : "review",
        note: "没有找到可直接下载的原始票据链接，请进入发票详情检查。不会用页面截图代替原始发票"};
    }
    if (state.hasApplied || state.rejected || /失败|拒绝|驳回|退款/.test(state.displayText)) return inspectOrder(message.orderId);
    const module = new URLSearchParams(location.search).get("_t_timestamp");
    if (module === "transac_invoice") return {next: C.invoiceUrl(message.orderId, "apply", state.mallId)};
    if (module !== "transac_modify_invoice") return {status: "review", note: "当前不是已适配的官方申请表单，请核对页面"};
    if (/增值税专用发票|电子专用发票/.test(value) && !/普通发票/.test(value)) return {status: "review", note: "当前是专用发票页面，请人工核对开票信息"};
    const title = C.validateTitle(message.title);
    if (!await prepareTitle(title)) return {status: "review", note: "未能完整核对公司名称、税号或邮箱，请在拼多多开票页设置正确抬头后再处理"};
    if (state.invoiceKind !== 0) return {status: "review", note: "当前发票类型不是普通发票，请人工核对"};
    const submit = uniqueTarget(["申请发票", "向商家发送申请", "提交申请", "确认申请", "申请开票", "提交开票申请"]);
    if (!submit) return {status: "review", note: "未找到唯一的开票提交按钮，请在处理窗口人工核对"};
    const auth = await rpc({type: "PDD_INVOICE_AUTHORIZE", queueId: message.queueId, orderId: message.orderId});
    if (!auth?.ok || !auth.value?.authorized) return {status: "pending", note: auth?.error || "任务已暂停，未提交申请", block: true};
    // Re-check immediately before the irreversible click, including field values and page identity.
    if (blocker() || C.orderId(location.href) !== message.orderId) return {status: "review", note: "提交前页面状态发生变化，未点击提交", block: true};
    const company = field(/单位名称|企业名称|公司名称|发票抬头|抬头名称/);
    const tax = field(/税号|纳税人识别号|社会信用代码/);
    if (company && tax && (company.value !== title.company || tax.value.toUpperCase() !== title.taxId)) return {status: "review", note: "提交前抬头发生变化，未点击提交", block: true};
    submit.click();
    let confirmed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(350);
      if (blocker()) return {status: "review", note: blocker(), block: true};
      if (!confirmed && /确认.{0,5}发票信息无误后再提交/.test(text())) {
        if (company?.value !== title.company || tax?.value.toUpperCase() !== title.taxId) return {status: "review", note: "确认时抬头不匹配，未提交", block: true};
        const confirm = uniqueTarget(["确认", "提交", "确定"]);
        if (!confirm) return {status: "review", note: "未能唯一识别平台二次确认按钮，请人工核对", block: true};
        const permission = await rpc({type: "PDD_INVOICE_AUTHORIZE", phase: "confirm", queueId: message.queueId, orderId: message.orderId});
        if (!permission?.ok || !permission.value?.authorized) return {status: "review", note: permission?.error || "确认前任务已暂停", block: true};
        confirmed = true; confirm.click();
      }
      if (/开票申请已提交|开票申请提交成功|申请已提交|提交成功|申请成功|等待商家开票/.test(text())) return {status: "submitted", note: "已在拼多多页面确认申请提交成功；若需 PDF 原件，请在发票详情领取", facts: {appliedAt: C.localTime(), platformCheckedAt: Date.now()}};
    }
    return {status: "review", note: "已点击提交，但页面未返回明确成功状态，请核对后再处理，不会自动重复申请", block: true};
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !["PDD_INVOICE_SCAN", "PDD_INVOICE_PROCESS", "PDD_INVOICE_INSPECT"].includes(message?.type)) return;
    if (executing) { reply({ok: false, error: "当前页面正在处理另一项任务，请稍后重试"}); return; }
    executing = true;
    const task = message.type === "PDD_INVOICE_SCAN" ? scan(message.loadMore) : message.type === "PDD_INVOICE_INSPECT" ? inspectOrder(message.orderId) : processOrder(message);
    task.then(value => reply({ok: true, ...value}), error => reply({ok: false, error: error.message})).finally(() => { executing = false; });
    return true;
  });
})();
