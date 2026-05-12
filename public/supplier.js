function renderSuppliers() {
  const target = document.querySelector("#suppliersTable");
  if (!target) return;
  const suppliers = state.suppliers || [];
  if (!suppliers.length) {
    target.innerHTML = `<div class="empty">暂无供应商，请点击上方“新增供应商”添加。</div>`;
    return;
  }
  target.innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>供应商名称</th><th>联系人</th><th>联系电话</th><th>微信ID</th><th>主营业务</th><th>绑定产品数</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${suppliers.map((s) => `<tr data-id="${s.id}">
        <td><strong>${escape(s.name)}</strong></td>
        <td>${escape(s.contact_person || "-")}</td>
        <td>${escape(s.contact_phone || "-")}</td>
        <td>${escape(s.wechat_id || "-")}</td>
        <td>${escape(s.business_note || "-")}</td>
        <td>${s.product_count || 0}</td>
        <td>${date(s.created_at)}</td>
        <td><span class="action-row">
          <button class="linklike edit-supplier-btn" data-id="${s.id}">编辑</button>
          <button class="linklike danger delete-supplier-btn" data-id="${s.id}">删除</button>
        </span></td>
      </tr>`).join("")}</tbody>
    </table></div>
  `;
}

function openSupplierDialog(supplierId) {
  const dialog = document.querySelector("#supplierDialog");
  const title = document.querySelector("#supplierDialogTitle");
  const form = document.querySelector("#supplierForm");
  if (!dialog || !form) return;
  form.reset();
  const idInput = form.querySelector("[name='id']");
  if (idInput) idInput.value = "";
  if (supplierId) {
    const supplier = state.suppliers.find((s) => Number(s.id) === Number(supplierId));
    if (supplier) {
      if (title) title.textContent = "编辑供应商";
      form.querySelector("[name='name']").value = supplier.name || "";
      form.querySelector("[name='contact_person']").value = supplier.contact_person || "";
      form.querySelector("[name='contact_phone']").value = supplier.contact_phone || "";
      form.querySelector("[name='wechat_id']").value = supplier.wechat_id || "";
      form.querySelector("[name='business_note']").value = supplier.business_note || "";
      if (idInput) idInput.value = supplier.id;
    }
  } else if (title) {
    title.textContent = "新增供应商";
  }
  openInlineDialog(dialog, "supplier-backdrop", closeSupplierDialog);
}

function closeSupplierDialog() {
  closeInlineDialog("#supplierDialog", ".supplier-backdrop");
}

function bindSupplierControls() {
  document.querySelector("#createSupplierBtn")?.addEventListener("click", () => openSupplierDialog(null));
  document.querySelector("#supplierDialogClose")?.addEventListener("click", closeSupplierDialog);
  document.querySelector("#supplierDialogCancel")?.addEventListener("click", closeSupplierDialog);
  document.querySelector("#stock")?.addEventListener("click", async (event) => {
    const editBtn = event.target.closest(".edit-supplier-btn");
    if (editBtn) {
      openSupplierDialog(editBtn.dataset.id);
      return;
    }
    const deleteBtn = event.target.closest(".delete-supplier-btn");
    if (!deleteBtn) return;
    if (!(await window.appConfirm("确定要删除该供应商吗？"))) return;
    try {
      await api(`/api/suppliers/${deleteBtn.dataset.id}`, { method: "DELETE" });
      await loadAll();
      if (state.stockViewMode === "suppliers") renderSuppliers();
    } catch (error) {
      await window.appAlert(`删除失败：${error.message}`);
    }
  });
  document.querySelector("#supplierForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const id = form.querySelector("[name='id']")?.value;
    const body = Object.fromEntries(new FormData(form));
    delete body.id;
    try {
      if (id) {
        await api(`/api/suppliers/${id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/api/suppliers", { method: "POST", body: JSON.stringify(body) });
      }
      closeSupplierDialog();
      await loadAll();
      if (state.stockViewMode === "suppliers") renderSuppliers();
    } catch (error) {
      await window.appAlert(`保存失败：${error.message}`);
    }
  });
}

function populateSupplierSelect(selectId) {
  const select = document.querySelector(`#${selectId}`);
  if (!select) return;
  const suppliers = state.suppliers || [];
  select.innerHTML = `<option value="">-- 选择供应商 --</option>` +
    suppliers.map((s) => `<option value="${s.id}">${escape(s.name)}</option>`).join("");
}

document.addEventListener("DOMContentLoaded", () => {
  bindSupplierControls();
});
