(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function attrs(values = {}) {
    return Object.entries(values)
      .filter(([, value]) => value !== false && value !== null && value !== undefined)
      .map(([key, value]) => value === true ? ` ${key}` : ` ${key}="${escapeHtml(value)}"`)
      .join("");
  }

  function classNames(...items) {
    return items.flatMap((item) => {
      if (!item) return [];
      if (typeof item === "string") return [item];
      if (Array.isArray(item)) return item.filter(Boolean);
      return Object.entries(item).filter(([, ok]) => ok).map(([key]) => key);
    }).join(" ");
  }

  function button({ text = "", variant = "secondary", size = "", className = "", attrs: extra = {} } = {}) {
    const cls = classNames("ds-btn", variant && `ds-btn-${variant}`, size && `ds-btn-${size}`, className);
    return `<button type="button"${attrs({ ...extra, class: cls })}>${escapeHtml(text)}</button>`;
  }

  function input({ label = "", name = "", value = "", placeholder = "", type = "text", className = "", attrs: extra = {} } = {}) {
    const control = `<input${attrs({ ...extra, class: classNames("ds-input", className), type, name, value, placeholder })} />`;
    return label ? `<label class="ds-field"><span>${escapeHtml(label)}</span>${control}</label>` : control;
  }

  function select({ label = "", name = "", value = "", options = [], className = "", attrs: extra = {} } = {}) {
    const opts = options.map((option) => {
      const item = typeof option === "object" ? option : { value: option, label: option };
      return `<option${attrs({ value: item.value, selected: String(item.value) === String(value) })}>${escapeHtml(item.label)}</option>`;
    }).join("");
    const control = `<select${attrs({ ...extra, class: classNames("ds-select", className), name })}>${opts}</select>`;
    return label ? `<label class="ds-field"><span>${escapeHtml(label)}</span>${control}</label>` : control;
  }

  function textarea({ label = "", name = "", value = "", placeholder = "", className = "", attrs: extra = {} } = {}) {
    const control = `<textarea${attrs({ ...extra, class: classNames("ds-textarea", className), name, placeholder })}>${escapeHtml(value)}</textarea>`;
    return label ? `<label class="ds-field ds-field-full"><span>${escapeHtml(label)}</span>${control}</label>` : control;
  }

  function card({ title = "", actions = "", body = "", className = "" } = {}) {
    const head = title || actions ? `<div class="ds-card-header"><h2>${escapeHtml(title)}</h2><div class="ds-card-actions">${actions}</div></div>` : "";
    return `<section class="${classNames("ds-card", className)}">${head}<div class="ds-card-body">${body}</div></section>`;
  }

  function emptyState(message = "暂无数据", action = "") {
    return `<div class="ds-empty"><span>${escapeHtml(message)}</span>${action ? `<div class="ds-empty-action">${action}</div>` : ""}</div>`;
  }

  function table({ columns = [], rows = [], empty = "暂无数据", className = "" } = {}) {
    if (!rows.length) return emptyState(empty);
    const head = columns.map((column) => `<th>${escapeHtml(column.label || column.key || "")}</th>`).join("");
    const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${typeof column.render === "function" ? column.render(row) : escapeHtml(row[column.key])}</td>`).join("")}</tr>`).join("");
    return `<div class="ds-table-wrap"><table class="${classNames("ds-table", className)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function badge(text, tone = "info", className = "") {
    return `<span class="${classNames("ds-badge", tone && `ds-badge-${tone}`, className)}">${escapeHtml(text)}</span>`;
  }

  function tabs({ tabs: rows = [], active = "", className = "" } = {}) {
    return `<div class="${classNames("ds-tabs", className)}">${rows.map((item) => {
      const key = item.key ?? item.value;
      return `<button type="button"${attrs({ class: classNames("ds-tab", String(key) === String(active) && "active"), "data-tab": key })}>${escapeHtml(item.label ?? key)}</button>`;
    }).join("")}</div>`;
  }

  function pageHeader({ title = "", subtitle = "", actions = "" } = {}) {
    return `<div class="ds-page-header"><div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div><div class="ds-page-actions">${actions}</div></div>`;
  }

  function modalShell({ id = "", title = "", body = "", actions = "", className = "" } = {}) {
    return `<div${attrs({ id, class: classNames("ds-modal", className) })}>
      <div class="ds-modal-header"><h2>${escapeHtml(title)}</h2><button type="button" class="dialog-close" data-modal-close="${escapeHtml(id)}">×</button></div>
      <div class="ds-modal-body">${body}</div>
      ${actions ? `<div class="ds-modal-actions">${actions}</div>` : ""}
    </div>`;
  }

  function clampPage(page, totalPages) {
    return Math.min(Math.max(1, Number(page || 1)), Math.max(Number(totalPages || 1), 1));
  }

  function totalPagesFor(rows, pageSize) {
    return Math.max(1, Math.ceil((rows?.length || 0) / Math.max(Number(pageSize || 1), 1)));
  }

  function paginateRows(rows, page, pageSize) {
    const size = Math.max(Number(pageSize || 1), 1);
    const start = (clampPage(page, totalPagesFor(rows, size)) - 1) * size;
    return (rows || []).slice(start, start + size);
  }

  function syncSimplePager(prefix, page, totalPages, total, pageSize = null) {
    const info = document.querySelector(`#${prefix}PageInfo`);
    const prev = document.querySelector(`#${prefix}PrevPage`);
    const next = document.querySelector(`#${prefix}NextPage`);
    const size = document.querySelector(`#${prefix}PageSize`);
    if (info) info.textContent = `第 ${page} / ${totalPages} 页，共 ${total} 条`;
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= totalPages;
    if (size && pageSize != null) size.value = String(pageSize);
  }

  function erpPagerHtml(prefix, page, pageSize, total, options = [10, 20, 50, 100]) {
    const totalPages = Math.max(1, Math.ceil(Number(total || 0) / Math.max(Number(pageSize || 1), 1)));
    const current = clampPage(page, totalPages);
    const windowStart = Math.floor((current - 1) / 5) * 5 + 1;
    const windowEnd = Math.min(totalPages, windowStart + 4);
    const pageButtons = [];
    for (let index = windowStart; index <= windowEnd; index += 1) {
      pageButtons.push(`<button class="pager-number ${index === current ? "active" : ""}" data-pager-prefix="${prefix}" data-pager-action="page" data-page="${index}" type="button">${index}</button>`);
    }
    const disabledPrev = current <= 1 ? "disabled" : "";
    const disabledNext = current >= totalPages ? "disabled" : "";
    return `<div class="table-footer pager erp-pager">
      <div class="erp-pager-meta">
        <span>共 ${escapeHtml(total)} 条记录</span>
        <label><select data-pager-size="${prefix}">
          ${options.map((value) => `<option value="${value}" ${Number(value) === Number(pageSize) ? "selected" : ""}>${value}条/页</option>`).join("")}
        </select></label>
        <span>第 ${current} / ${totalPages} 页</span>
      </div>
      <div class="erp-pager-actions">
        <button data-pager-prefix="${prefix}" data-pager-action="first" type="button" ${disabledPrev}>|&lt;</button>
        <button data-pager-prefix="${prefix}" data-pager-action="prev" type="button" ${disabledPrev}>&lt;</button>
        <button data-pager-prefix="${prefix}" data-pager-action="jump-prev" type="button" ${windowStart <= 1 ? "disabled" : ""}>&lt;&lt;</button>
        ${pageButtons.join("")}
        <button data-pager-prefix="${prefix}" data-pager-action="jump-next" type="button" ${windowEnd >= totalPages ? "disabled" : ""}>&gt;&gt;</button>
        <button data-pager-prefix="${prefix}" data-pager-action="next" type="button" ${disabledNext}>&gt;</button>
        <button data-pager-prefix="${prefix}" data-pager-action="last" type="button" ${disabledNext}>&gt;|</button>
      </div>
    </div>`;
  }

  function renderTable(target, rows, cols, options = {}) {
    const mount = document.querySelector(`#${target}`);
    if (!mount) return;
    const emptyText = options.emptyText || "当前区域暂无数据";
    const rowClassName = typeof options.rowClassName === "function" ? options.rowClassName : () => "";
    const rowAttrs = typeof options.rowAttrs === "function" ? options.rowAttrs : () => "";
    mount.innerHTML = !rows?.length
      ? `<div class="empty">${escapeHtml(emptyText)}</div>`
      : `<div class="table-wrap"><table class="table"><thead><tr>${cols.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr ${rowAttrs(row) || ""} class="${escapeHtml(rowClassName(row) || "")}">${cols.map(([, , getter]) => `<td>${getter(row) ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function openInlineDialog(dialog, backdropClass, closeFn) {
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.classList.add("visible");
    if (!document.querySelector(`.${backdropClass}`)) {
      const backdrop = document.createElement("div");
      backdrop.className = `edit-dialog-backdrop ${backdropClass}`;
      backdrop.addEventListener("click", closeFn);
      document.body.appendChild(backdrop);
    }
    dialog.querySelector("input, select, button, textarea")?.focus();
  }

  function closeInlineDialog(dialogSelector, backdropSelector) {
    const dialog = typeof dialogSelector === "string" ? document.querySelector(dialogSelector) : dialogSelector;
    if (dialog?.open) dialog.close();
    dialog?.classList.remove("visible");
    if (typeof backdropSelector === "string") document.querySelector(backdropSelector)?.remove();
  }

  function showToast(message, type = "info", duration = 4000) {
    const existing = document.querySelector(".proc-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `proc-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("fade-out");
      window.setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  const ozonUI = {
    attrs,
    badge,
    button,
    card,
    classNames,
    clampPage,
    closeInlineDialog,
    emptyState,
    erpPagerHtml,
    escapeHtml,
    input,
    modalShell,
    openInlineDialog,
    paginateRows,
    pageHeader,
    renderTable,
    select,
    showToast,
    syncSimplePager,
    table,
    tabs,
    textarea,
    totalPagesFor
  };

  window.OzonUI = ozonUI;
  window.OzoneUI = ozonUI;
})();
