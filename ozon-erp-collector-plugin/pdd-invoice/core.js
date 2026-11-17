/* Shared by the extension worker, dashboard, content script, and Node tests. */
(() => {
  const ORIGIN = "https://mobile.pinduoduo.com";
  const labels = {
    pending: "待申请", processing: "处理中", submitted: "已申请", issued: "已开票",
    skipped: "已跳过", rejected: "开票失败", failed: "处理异常", review: "待核对", needs_review: "待核对（含失败及异常）", downloading: "下载中", downloaded: "已下载"
  };
  function pddUrl(value) {
    try {
      const url = new URL(value, ORIGIN);
      return url.origin === ORIGIN && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function orderId(value) {
    try {
      const url = new URL(value, ORIGIN);
      const id = url.searchParams.get("order_sn") || "";
      return /^[\d-]{10,40}$/.test(id) ? id : "";
    } catch { return ""; }
  }
  function invoiceUrl(id, kind = "detail", mallId = "") {
    if (!/^[\d-]{10,40}$/.test(id)) throw new Error("订单号格式不正确");
    const url = new URL("/transac_return_compensation.html", ORIGIN);
    url.searchParams.set("_t_timestamp", kind === "apply" ? "transac_modify_invoice" : "transac_invoice");
    url.searchParams.set("order_sn", id);
    if (/^\d+$/.test(String(mallId))) url.searchParams.set("mall_id", mallId);
    if (kind === "apply") url.searchParams.set("from_invoice", "1");
    return url.href;
  }
  function validateTitle(value) {
    const title = {
      company: String(value?.company || "").trim(),
      taxId: String(value?.taxId || "").trim().toUpperCase(),
      email: String(value?.email || "").trim()
    };
    if (title.company.length < 2 || title.company.length > 100) throw new Error("请在右上角「设置 → 发票抬头」填写完整公司名称");
    if (!/^(?:[A-Z0-9]{15}|[A-Z0-9]{18}|[A-Z0-9]{20})$/.test(title.taxId)) throw new Error("请在右上角「设置 → 发票抬头」填写 15、18 或 20 位纳税人识别号");
    if (title.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(title.email)) throw new Error("请在右上角「设置 → 发票抬头」检查收票邮箱格式");
    return title;
  }
  function safeFilePart(value) {
    return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 80) || "未命名";
  }
  function invoiceFile(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const ext = url.pathname.match(/\.(pdf|ofd|xml|png|jpe?g)$/i)?.[1]?.toLowerCase();
      return ext ? {url: url.href, ext} : null;
    } catch { return null; }
  }
  function csvCell(value) {
    // Spreadsheet apps must not execute formulas from shop/product/order text.
    const text = String(value ?? "");
    const guarded = /^[=+\-@\t\r\n]/.test(text) || /^\d{15,}$/.test(text) ? `'${text}` : text;
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  function csv(rows) { return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n"); }
  function beijing(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}).format(new Date(value));
  }
  function normalizeDate(value) {
    const match = String(value || "").trim().match(/^(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return "";
    const [, y, m, d, hour, minute, second] = match;
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d || +(hour || 0) > 23 || +(minute || 0) > 59 || +(second || 0) > 59) return "";
    const day = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return hour ? `${day} ${hour.padStart(2, "0")}:${minute}:${second || "00"}` : day;
  }
  function localTime(value = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}).formatToParts(new Date(value)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  function cents(value) {
    const text = String(value ?? "").trim();
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    const amount = +whole * 100 + +fraction.padEnd(2, "0");
    return Number.isSafeInteger(amount) ? amount : null;
  }
  function money(value) { return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : ""; }
  const ledgerFields = ["status", "appliedAt", "issuedAt", "invoiceAmountCents", "applicationAmountCents", "invoiceNo", "rejectionReason", "ledgerNote"];
  function recordLedger(row, patch, source = "platform", now = Date.now()) {
    const changes = [];
    for (const key of ledgerFields) {
      if (patch[key] === undefined || patch[key] === row[key]) continue;
      if (source === "platform" && key === "appliedAt" && patch[key]?.length === 10 && row[key]?.length > 10 && row[key].startsWith(patch[key])) continue;
      changes.push({field: key, before: row[key] ?? null, after: patch[key]});
      row[key] = patch[key];
    }
    if (changes.length) {
      row.history ||= [];
      row.history.push({at: now, source, changes});
      row.updated = now;
    }
    if (patch.platformCheckedAt) row.platformCheckedAt = patch.platformCheckedAt;
    return row;
  }
  function summarize(rows) {
    const result = {issued: {count: 0, cents: 0, missing: 0}, submitted: {count: 0, cents: 0, missing: 0}, rejected: {count: 0, cents: 0, missing: 0}};
    for (const row of rows) {
      const bucket = result[row.status];
      if (!bucket) continue;
      bucket.count++;
      const value = row.status === "issued" ? row.invoiceAmountCents : row.applicationAmountCents ?? cents(row.amount);
      if (Number.isSafeInteger(value) && value >= 0) bucket.cents += value;
      else bucket.missing++;
    }
    return result;
  }
  function visibleRows(rows, filter) {
    return rows.filter(row => {
      if (filter.query && !`${row.id} ${row.shop} ${row.product}`.toLowerCase().includes(filter.query.toLowerCase())) return false;
      if (filter.status === "needs_review") {
        if (!["review", "failed", "rejected"].includes(row.status) && !["review", "failed"].includes(row.taskStatus)) return false;
      } else if (filter.status && row.status !== filter.status && row.taskStatus !== filter.status) return false;
      // Unknown dates are excluded when a date filter is active; never invent dates.
      const date = String(row[filter.dateBasis || "date"] || "").slice(0, 10);
      if ((filter.from || filter.to) && !date) return false;
      return (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to);
    });
  }
  function mergeOrders(oldRows, incoming) {
    const map = new Map(oldRows.map(row => [row.id, row]));
    for (const item of incoming) {
      const url = pddUrl(item.url);
      if (!url || orderId(url) !== item.id) continue;
      const old = map.get(item.id);
      // A refreshed page must not erase submitted/uncertain/download history.
      const preserve = old && !["pending", "skipped"].includes(old.status);
      const merged = {...old, id: item.id, url: old?.url || url, shop: item.shop || old?.shop || "", product: item.product || old?.product || "",
        thumbnail: /^https:\/\//.test(item.thumbnail || "") ? item.thumbnail : old?.thumbnail || "",
        mallId: item.mallId || old?.mallId || "", applicationUrl: pddUrl(item.applicationUrl) && orderId(item.applicationUrl) === item.id ? pddUrl(item.applicationUrl) : old?.applicationUrl || "",
        amount: item.amount || old?.amount || "", date: item.date || old?.date || "",
        status: preserve ? old.status : item.status || old?.status || "pending", note: preserve ? old.note : item.note || ""};
      if (item.invoiceFacts) recordLedger(merged, {...item.invoiceFacts, status: item.status}, "platform");
      map.set(item.id, merged);
    }
    return [...map.values()];
  }
  function recoverQueue(queue) {
    if (!queue) return null;
    // A worker can disappear between submit and response. Never replay that item.
    for (const item of queue.items) {
      if (item.status === "processing") { item.status = "review"; item.note = "上次处理被中断，请打开发票页面核对，确认结果前不会自动重试"; }
    }
    if (queue.state === "running") queue.state = "paused";
    return queue;
  }
  globalThis.PddInvoice = {ORIGIN, labels, pddUrl, orderId, invoiceUrl, validateTitle, safeFilePart, invoiceFile, csv, beijing, normalizeDate, localTime, cents, money, recordLedger, summarize, visibleRows, mergeOrders, recoverQueue};
})();
