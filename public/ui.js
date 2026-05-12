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

  function emptyState(message = "暂无数据", action = "") {
    return `<div class="ds-empty"><span>${escapeHtml(message)}</span>${action ? `<div class="ds-empty-action">${action}</div>` : ""}</div>`;
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

  const ozonUI = {
    attrs,
    badge,
    button,
    card,
    classNames,
    emptyState,
    escapeHtml,
    input,
    modalShell,
    pageHeader,
    select,
    table,
    tabs,
    textarea
  };
  window.OzonUI = ozonUI;
  window.OzoneUI = ozonUI;
})();
