const state = {
  currentView: "selection",
  authToken: localStorage.getItem("authToken") || "",
  currentUserId: "1",
  products: [],
  hiddenProducts: [],
  people: [],
  shops: [],
  onlineProducts: [],
  onlineFilters: {
    shopId: localStorage.getItem("onlineFilter:shopId") || "all",
    pageSize: Number(localStorage.getItem("onlineFilter:pageSize") || 50),
    page: 1
  },
  orderFilters: {
    shopId: localStorage.getItem("orderFilter:shopId") || "all",
    status: ["all", "unbound", "stock_issue", "overdue", "outbound_ready", "delivering", "cancelled", "delivered"].includes(localStorage.getItem("orderFilter:status")) ? localStorage.getItem("orderFilter:status") : "all",
    pageSize: Number(localStorage.getItem("orderFilter:pageSize") || 30),
    page: 1,
    dateFrom: localStorage.getItem("orderFilter:dateFrom") || defaultDateFrom(30),
    dateTo: localStorage.getItem("orderFilter:dateTo") || todayInputValue()
  },
  bindTargetOnlineId: null,
  stockHighlightProductId: null,
  stockViewMode: "active",
  stockPageSize: 30,
  stockPage: 1,
  inboundRecords: [],
  outboundRecords: [],
  outboundFilters: {
    pageSize: [30, 50, 100].includes(Number(localStorage.getItem("outboundFilter:pageSize"))) ? Number(localStorage.getItem("outboundFilter:pageSize")) : 30,
    page: 1,
    dateFrom: localStorage.getItem("outboundFilter:dateFrom") || defaultDateFrom(30),
    dateTo: localStorage.getItem("outboundFilter:dateTo") || todayInputValue()
  },
  procurementSummary: [],
  procurementRequests: [],
  purchaseOrders: [],
  pendingInbound: [],
  selectedProcurementProductId: null,
  procurementSelectedRequestIds: new Set(),
  procurementTab: "orders",
  procurementFilters: { status: "pending", personId: "all", urgency: "all", query: "" },
  orders: [],
  profitSummary: null,
  exchangeRate: null,
  exchangeRates: [],
  systemInfo: null
};

const titles = {
  selection: ["选品计价表", "先创建选品，Ozon SKU 上架后再从在线商品里绑定。"],
  formula: ["计价公式", "按 CEL Ozon-rFBS 资费表，输入售价、重量和尺寸自动计算运费与利润。"],
  online: ["在线商品", "从 Ozon 店铺同步来的 SKU 池，负责和实际产品绑定。"],
  stock: ["产品库存表", "以实际产品为核心，展示库存、均价、采购投入和已绑定 SKU。"],
  procurement: ["采购工作台", "需求提交、合并采购、到货入库和库存更新都在这里完成。"],
  inbound: ["入库表", "采购完成不等于入库，到货质检通过后才增加库存。"],
  outbound: ["出库表", "订单同步后自动生成出库记录，未绑定产品会进入待处理。"],
  config: ["配置", "集中维护人员配置和店铺配置。"],
  orders: ["我的订单", "查看订单状态、SKU 绑定、库存处理和发货节点。"],
  profit: ["利润汇总", "按店铺、SKU 和真实产品汇总销售额、预估利润和已确认利润。"]
};

const orderStatusTabs = [
  ["all", "所有订单"],
  ["unbound", "待绑定 SKU"],
  ["stock_issue", "库存不足"],
  ["overdue", "超时发货"],
  ["outbound_ready", "可出库/已处理"],
  ["delivering", "运输中"],
  ["delivered", "已签收"],
  ["cancelled", "已取消"]
];

const columns = {
  selection: [
    ["selection_id", "选品ID", (r) => r.selection_id],
    ["stock_code", "库存产品ID", (r) => r.inventory_id || r.code],
    ["created", "创建信息", (r) => strong(r.creator_name || r.owner_name || "-", date(r.created_at))],
    ["owner", "人员", (r) => r.owner_name],
    ["name", "商品名称", (r) => strong(r.name, r.supplier_note)],
    ["image", "图片", (r) => image(r.image_url)],
    ["source", "货源平台", (r) => sourceName(r.source_platform)],
    ["shipping", "配送方式", (r) => tag(methodName(r.shipping_method), r.shipping_method === r.recommended_shipping_method ? "green" : "amber")],
    ["recommended", "推荐", (r) => methodName(r.recommended_shipping_method)],
    ["weight", "克重", (r) => `${num(r.package_weight_g, 0)}g`],
    ["size", "长宽高", (r) => `${num(r.length_cm, 1)} x ${num(r.width_cm, 1)} x ${num(r.height_cm, 1)}`],
    ["purchase_cost", "采购单价", (r) => money(r.purchase_cost)],
    ["domestic", "国内运费", (r) => money(r.domestic_shipping)],
    ["quantity", "采购数", (r) => r.purchase_quantity],
    ["sale", "售价(RMB)", (r) => money(r.air_sale_price_rmb)],
    ["listing", "上架参考价(RMB)", (r) => money(listingRubToRmb(r.listing_price_rub, r.exchange_rate))],
    ["suggested_air", "建议价-陆空(RMB)", (r) => suggestedCellRmb(r.pricing?.suggestedRub_air, r.exchange_rate, r.pricing?.targetMarginPct)],
    ["suggested_air_x2", "x2参考-陆空(RMB)", (r) => suggestedX2CellRmb(r.pricing?.suggestedRub_air_x2, r.exchange_rate)],
    ["suggested_land", "建议价-陆运(RMB)", (r) => suggestedCellRmb(r.pricing?.suggestedRub_land, r.exchange_rate, r.pricing?.targetMarginPct)],
    ["suggested_land_x2", "x2参考-陆运(RMB)", (r) => suggestedX2CellRmb(r.pricing?.suggestedRub_land_x2, r.exchange_rate)],
    ["avg_cost", "均摊采购成本", (r) => money(r.pricing?.purchaseCost)],
    ["air_profit", "陆空净利", (r) => profitCell(r.pricing?.air)],
    ["air_margin", "陆空净利率", (r) => marginCell(r.pricing?.air)],
    ["land_profit", "陆运净利", (r) => profitCell(r.pricing?.land)],
    ["link", "货源链接", (r) => link(r.purchase_url)],
    ["actions", "操作", (r) => `<span class="action-row"><button class="linklike edit-product-btn" data-id="${r.id}">编辑</button><button class="linklike danger delete-product-btn" data-id="${r.id}">删除</button></span>`]
  ],
  stock: [
    ["image", "图片", (r) => image(r.image_url)],
    ["product", "产品名称", (r) => strong(r.name, r.supplier_note)],
    ["stock", "库存", (r) => stockCell(r)],
    ["incoming", "即将入库", (r) => tag(r.incoming_stock || 0, Number(r.incoming_stock || 0) > 0 ? "blue" : "")],
    ["avg", "历史均价", (r) => money(r.avg_unit_cost || r.purchase_cost)],
    ["avg_sale", "历史平均售价", (r) => Number(r.avg_sale_price || 0) ? money(r.avg_sale_price) : tag("暂无有效订单", "amber")],
    ["purchase_amount", "总采购金额", (r) => money(r.total_purchase_amount)],
    ["purchase_qty", "总采购数量", (r) => r.total_purchase_quantity || 0],
    ["sales", "总销售额", (r) => salesCell(r)],
    ["profit", "订单总利润", (r) => stockProfitCell(r)],
    ["cancel", "总取消", (r) => cancelCell(r)],
    ["skus", "已绑定 SKU", (r) => collapsedSkuList(r.mapped_skus)],
    ["actions", "操作", (r) => `<span class="action-row"><button class="linklike edit-product-btn" data-id="${r.id}">编辑</button><button class="linklike danger delete-product-btn" data-id="${r.id}">删除</button></span>`]
  ]
};
function restoreCurrentView() {
  const saved = sessionStorage.getItem("currentView");
  if (saved && document.querySelector(`[data-view="${saved}"]`)) {
    showView(saved);
  } else {
    showView("profit");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  bindNavigation();
  bindForms();
  bindImageUpload();
  bindShippingRecommendation();
  bindCelFbsCalculator();
  bindEditDialog();
  bindSelectionCreatePanel();
  bindOnlineControls();
  bindOrderControls();
  bindOutboundControls();
  bindBindDialog();
  bindProductCreateDialog();
  bindProcurementControls();
  bindExchangeRateForm();
  bindAuthControls();
  const isAuthenticated = await checkAuthSession();
  if (isAuthenticated) {
    await loadAll();
    restoreCurrentView();
  }
});

function bindNavigation() {
  document.querySelectorAll("nav button").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  document.querySelector("#syncOzon")?.addEventListener("click", syncOzon);
  document.querySelector("#syncOrdersBtn")?.addEventListener("click", syncOzon);
  document.querySelector("#syncOnlineProducts")?.addEventListener("click", syncOnlineProducts);
  bindStockControls();
  document.querySelector("#orderShopFilter")?.addEventListener("change", (event) => {
    state.orderFilters.shopId = event.target.value;
    state.orderFilters.page = 1;
    localStorage.setItem("orderFilter:shopId", state.orderFilters.shopId);
    renderOrdersTable();
  });
}

function showView(view) {
  // 这里只切换界面状态，不在这里重新请求数据，避免 tab 切换触发全量刷新。
  state.currentView = view;
  sessionStorage.setItem("currentView", view);
  document.body.classList.toggle("procurement-mode", view === "procurement");
  document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".nav-group").forEach((group) => {
    group.classList.toggle("open", group.querySelector(`[data-view="${view}"]`) != null);
  });
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === view));
  document.querySelector("#pageTitle").textContent = titles[view][0];
  document.querySelector("#pageSubtitle").textContent = titles[view][1];
}

function bindForms() {
  normalizeProcurementForm();
  onSubmit("#productForm", "/api/products");
  onSubmit("#procurementForm", "/api/procurement/requests");
  onSubmit("#inboundForm", "/api/inbound-records");
  bindPeopleForm();
  bindShopForm();
}

function bindSelectionCreatePanel() {
  document.querySelector("#openSelectionCreate")?.addEventListener("click", openSelectionCreatePanel);
  document.querySelector("#closeSelectionCreate")?.addEventListener("click", closeSelectionCreatePanel);
}

function openSelectionCreatePanel() {
  const panel = document.querySelector("#selectionCreatePanel");
  if (!panel) return;
  document.body.appendChild(panel);
  resetSelectionCreateForm();
  setDefaults();
  updateRecommendation();
  panel.classList.add("visible");
  const backdrop = document.createElement("div");
  backdrop.className = "edit-dialog-backdrop selection-create-backdrop";
  backdrop.addEventListener("click", closeSelectionCreatePanel);
  document.body.appendChild(backdrop);
  panel.querySelector("[name='name']")?.focus();
}

function closeSelectionCreatePanel() {
  document.querySelector("#selectionCreatePanel")?.classList.remove("visible");
  document.querySelector(".selection-create-backdrop")?.remove();
}

function resetSelectionCreateForm() {
  const form = document.querySelector("#productForm");
  if (!form) return;
  form.reset();
  form.elements.handling_fee.value = "0";
  form.elements.purchase_quantity.value = "1";
  form.elements.package_weight_g.value = "30";
  form.elements.length_cm.value = "15";
  form.elements.width_cm.value = "10";
  form.elements.height_cm.value = "5";
  form.elements.exchange_rate.value = currentExchangeRate();
  form.elements.return_rate.value = "0.05";
  form.elements.desired_profit_mode.value = "margin";
  form.elements.desired_profit_value.value = "20";
  form.elements.air_sale_price_rmb.value = "";
  form.elements.online_product_id.value = "";
  form.elements.person_id.value = state.currentUserId;
  form.elements.owner_person_id.value = state.currentUserId;
  document.querySelector("#listingPriceRmbInput").value = "";
  document.querySelector("#listingPriceRubInput").value = "";
  document.querySelector("#imageData").value = "";
  const imageFile = document.querySelector("#imageFile");
  if (imageFile) imageFile.value = "";
}

function openSelectionCreateFromOutbound(row) {
  openSelectionCreatePanel();
  const form = document.querySelector("#productForm");
  if (!form || !row) return;
  if (row.online_product_id) {
    fillSelectionCreateFromOnline(Number(row.online_product_id));
    return;
  }
  const images = String(row.image_urls || "").split(",").map((item) => item.trim()).filter(Boolean);
  form.elements.name.value = row.product_name && row.product_name !== "未绑定产品" ? row.product_name : `订单 ${row.order_ref || ""} 商品`;
  form.elements.image_url.value = images[0] || "";
  form.elements.source_platform.value = "supplier";
  form.elements.supplier_note.value = `来自出库订单 ${row.order_ref || ""}${row.ozon_sku ? ` / SKU ${row.ozon_sku}` : ""}`;
  updateRecommendation();
}

function fillSelectionCreateFromOnline(onlineId) {
  const online = state.onlineProducts.find((item) => item.id === Number(onlineId));
  const form = document.querySelector("#productForm");
  if (!online || !form) return;
  const attrs = parseJson(online.attributes_json) || {};
  const imageUrl = online.primary_image || online.image_url || firstJsonItem(online.images_json);
  form.elements.online_product_id.value = online.id;
  form.elements.person_id.value = state.currentUserId;
  form.elements.owner_person_id.value = state.currentUserId;
  form.elements.name.value = online.name || "";
  form.elements.image_url.value = imageUrl || "";
  form.elements.source_platform.value = "supplier";
  form.elements.supplier_note.value = `来自 Ozon SKU ${online.ozon_sku}${online.offer_id ? ` / Offer ${online.offer_id}` : ""}`;
  form.elements.air_sale_price_rmb.value = Number(online.sale_price || 0);
  form.elements.package_weight_g.value = inferOnlineWeightGrams(attrs) || 30;
  form.elements.length_cm.value = attrs.length || attrs.depth || 15;
  form.elements.width_cm.value = attrs.width || 10;
  form.elements.height_cm.value = attrs.height || 5;
  syncListingReferencePrice();
  updateRecommendation();
}

function bindPeopleForm() {
  const form = document.querySelector("#peopleForm");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const id = body.id;
    delete body.id;
    const url = id ? `/api/people/${id}` : "/api/people";
    const method = id ? "PUT" : "POST";
    await api(url, { method, body: JSON.stringify(body) });
    resetPeopleForm();
    await loadAll();
  });
  document.querySelector("#peopleCancelEdit")?.addEventListener("click", resetPeopleForm);
  document.addEventListener("click", async (event) => {
    const editBtn = event.target.closest(".edit-person-btn");
    if (editBtn) {
      const person = state.people.find((item) => item.id === Number(editBtn.dataset.id));
      if (person) fillPeopleForm(person);
      return;
    }
    const deleteBtn = event.target.closest(".delete-person-btn");
    if (deleteBtn) {
      const person = state.people.find((item) => item.id === Number(deleteBtn.dataset.id));
      if (!person) return;
      if (!confirm(`确定停用人员「${person.name}」吗？历史记录会保留。`)) return;
      try {
        await api(`/api/people/${person.id}`, { method: "DELETE" });
        await loadAll();
      } catch (error) {
        alert(error.message || "鍋滅敤澶辫触");
      }
      return;
    }
    const hardDeleteBtn = event.target.closest(".hard-delete-person-btn");
    if (hardDeleteBtn) {
      const person = state.people.find((item) => item.id === Number(hardDeleteBtn.dataset.id));
      if (!person) return;
      if (!confirm(`确定永久删除人员「${person.name}」吗？历史记录会保留，但不再关联这个人员。`)) return;
      try {
        await api(`/api/people/${person.id}?hard=1`, { method: "DELETE" });
        await loadAll();
      } catch (error) {
        alert(error.message || "鍒犻櫎澶辫触");
      }
    }
  });
}

function bindShopForm() {
  const form = document.querySelector("#shopForm");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const id = body.id;
    delete body.id;
    const url = id ? `/api/shops/${id}` : "/api/shops";
    const method = id ? "PUT" : "POST";
    await api(url, { method, body: JSON.stringify(body) });
    resetShopForm();
    await loadAll();
  });
  document.querySelector("#shopCancelEdit")?.addEventListener("click", resetShopForm);
  document.addEventListener("click", async (event) => {
    const editBtn = event.target.closest(".edit-shop-btn");
    if (editBtn) {
      const shop = state.shops.find((item) => item.id === Number(editBtn.dataset.id));
      if (shop) fillShopForm(shop);
      return;
    }
    const deleteBtn = event.target.closest(".delete-shop-btn");
    if (deleteBtn) {
      const shop = state.shops.find((item) => item.id === Number(deleteBtn.dataset.id));
      if (!shop) return;
      if (!confirm(`确定删除店铺「${shop.name}」吗？删除后不会再参与同步。`)) return;
      await api(`/api/shops/${shop.id}`, { method: "DELETE" });
      await loadAll();
    }
  });
}

function bindOnlineControls() {
  document.querySelector("#onlineShopFilter")?.addEventListener("change", (event) => {
    state.onlineFilters.shopId = event.target.value;
    state.onlineFilters.page = 1;
    localStorage.setItem("onlineFilter:shopId", state.onlineFilters.shopId);
    renderOnlineTable();
  });
  document.querySelector("#onlinePageSize")?.addEventListener("change", (event) => {
    state.onlineFilters.pageSize = Number(event.target.value || 50);
    state.onlineFilters.page = 1;
    localStorage.setItem("onlineFilter:pageSize", String(state.onlineFilters.pageSize));
    renderOnlineTable();
  });
  document.querySelector("#onlinePrevPage")?.addEventListener("click", () => {
    state.onlineFilters.page = Math.max(1, state.onlineFilters.page - 1);
    renderOnlineTable();
  });
  document.querySelector("#onlineNextPage")?.addEventListener("click", () => {
    const totalPages = onlineTotalPages();
    state.onlineFilters.page = Math.min(totalPages, state.onlineFilters.page + 1);
    renderOnlineTable();
  });
}

function bindBindDialog() {
  const dialog = document.querySelector("#bindOnlineDialog");
  const form = document.querySelector("#bindDialogForm");
  if (!dialog || !form) return;
  document.querySelector("#bindDialogClose")?.addEventListener("click", closeBindDialog);
  document.querySelector("#bindDialogCancel")?.addEventListener("click", closeBindDialog);
  document.querySelector("#bindProductSearch")?.addEventListener("input", renderBindProductOptions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (!body.online_product_id) throw new Error("???????");
    if (!body.product_id) throw new Error("????????????");
    await api("/api/online-products/bind", { method: "POST", body: JSON.stringify(body) });
    closeBindDialog();
    await loadAll();
  });
}

function bindProductCreateDialog() {
  document.querySelector("#openProductCreate")?.addEventListener("click", openSelectionCreatePanel);
  document.querySelector("#productCreateClose")?.addEventListener("click", closeProductCreateDialog);
  document.querySelector("#productCreateCancel")?.addEventListener("click", closeProductCreateDialog);
  document.querySelector("#productCreateForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    syncCreateListingPrice();
    const form = event.target;
    const error = document.querySelector("#productCreateError");
    const submit = document.querySelector("#productCreateSubmit");
    if (error) error.style.display = "none";
    if (submit) {
      submit.disabled = true;
      submit.textContent = "保存中...";
    }
    const body = Object.fromEntries(new FormData(form));
    body.create_procurement_request = form.dataset.createProcurementRequest || "0";
    const url = body.online_product_id ? "/api/online-products/create-product" : "/api/products";
    try {
      const result = await api(url, { method: "POST", body: JSON.stringify(body) });
      if (result?.id) {
        const procProduct = document.querySelector("#procProduct");
        if (procProduct) procProduct.value = result.id;
      }
      closeProductCreateDialog();
      await loadAll();
    } catch (err) {
      if (error) {
        error.textContent = err.message || "保存失败，请检查必填信息";
        error.style.display = "";
      } else {
        alert(err.message || "保存失败，请检查必填信息");
      }
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "保存库存产品";
      }
    }
  });
  for (const selector of ["#productCreateForm [name='air_sale_price_rmb']", "#productCreateForm [name='exchange_rate']"]) {
    document.querySelector(selector)?.addEventListener("input", syncCreateListingPrice);
  }
}

function bindOutboundControls() {
  document.querySelector("#outboundPageSize")?.addEventListener("change", (event) => {
    state.outboundFilters.pageSize = Number(event.target.value || 30);
    state.outboundFilters.page = 1;
    localStorage.setItem("outboundFilter:pageSize", String(state.outboundFilters.pageSize));
    renderOutboundTable();
  });
  document.querySelector("#outboundPrevPage")?.addEventListener("click", () => {
    state.outboundFilters.page = Math.max(1, state.outboundFilters.page - 1);
    renderOutboundTable();
  });
  document.querySelector("#outboundNextPage")?.addEventListener("click", () => {
    const filtered = filteredOutboundRows();
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.outboundFilters.pageSize));
    state.outboundFilters.page = Math.min(totalPages, state.outboundFilters.page + 1);
    renderOutboundTable();
  });
  document.querySelector("#outboundQueryBtn")?.addEventListener("click", () => {
    const dateFrom = document.querySelector("#outboundDateFrom");
    const dateTo = document.querySelector("#outboundDateTo");
    state.outboundFilters.dateFrom = dateFrom ? dateFrom.value : "";
    state.outboundFilters.dateTo = dateTo ? dateTo.value : "";
    state.outboundFilters.page = 1;
    localStorage.setItem("outboundFilter:dateFrom", state.outboundFilters.dateFrom);
    localStorage.setItem("outboundFilter:dateTo", state.outboundFilters.dateTo);
    renderOutboundTable();
  });
}

function bindProcurementControls() {
  document.querySelector("#procProductSearch")?.addEventListener("input", renderProcProductOptions);
  document.querySelector("#procStatusFilter")?.addEventListener("change", (event) => { state.procurementFilters.status = event.target.value; renderProcurementRequests(); });
  document.querySelector("#procPersonFilter")?.addEventListener("change", (event) => { state.procurementFilters.personId = event.target.value; renderProcurementRequests(); });
  document.querySelector("#procUrgencyFilter")?.addEventListener("change", (event) => { state.procurementFilters.urgency = event.target.value; renderProcurementRequests(); });
  document.querySelector("#procRequestSearch")?.addEventListener("input", (event) => { state.procurementFilters.query = event.target.value; renderProcurementRequests(); });
  document.querySelector("#mergeProcurementBtn")?.addEventListener("click", mergeSelectedProcurementRequests);
  document.querySelector("#clearProcurementSelectionBtn")?.addEventListener("click", () => {
    state.procurementSelectedRequestIds.clear();
    renderProcurementRequests();
  });
  document.querySelector("#procurementTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button) return;
    state.procurementTab = button.dataset.tab;
    renderProcurementWorkspace();
  });
  document.querySelector("#purchaseOrderDrawerClose")?.addEventListener("click", closePurchaseOrderDrawer);
  document.addEventListener("click", async (event) => {
    const requestCheck = event.target.closest(".proc-request-check");
    if (requestCheck) {
      const id = Number(requestCheck.dataset.id);
      if (requestCheck.checked) state.procurementSelectedRequestIds.add(id);
      else state.procurementSelectedRequestIds.delete(id);
      return;
    }
    const cancelReq = event.target.closest(".cancel-proc-request-btn");
    if (cancelReq) {
      const row = state.procurementRequests.find((item) => Number(item.id) === Number(cancelReq.dataset.id));
      if (!row || !confirm("确认取消这条采购需求吗？")) return;
      await api(`/api/procurement/requests/${row.id}`, { method: "PUT", body: JSON.stringify({ ...row, status: "cancelled" }) });
      await loadAll();
      return;
    }
    const detailBtn = event.target.closest(".po-detail-btn");
    if (detailBtn) { await openPurchaseOrderDrawer(Number(detailBtn.dataset.id)); return; }
    const confirmBtn = event.target.closest(".po-confirm-btn");
    if (confirmBtn) { await confirmPurchaseOrderAction(Number(confirmBtn.dataset.id)); return; }
    const cancelPoBtn = event.target.closest(".po-cancel-btn");
    if (cancelPoBtn) {
      if (!confirm("确认取消这张采购单吗？已合并需求会回到待合并。")) return;
      await api(`/api/procurement/purchase-orders/${cancelPoBtn.dataset.id}/cancel`, { method: "POST", body: JSON.stringify({}) });
      await loadAll();
      return;
    }
    const inboundBtn = event.target.closest(".confirm-inbound-btn");
    if (inboundBtn) { await confirmInboundRecordAction(Number(inboundBtn.dataset.id)); return; }
    const editInboundBtn = event.target.closest(".edit-inbound-record-btn");
    if (editInboundBtn) { await editInboundRecordAction(Number(editInboundBtn.dataset.id)); return; }
    const deleteInboundBtn = event.target.closest(".delete-inbound-record-btn");
    if (deleteInboundBtn) { await deleteInboundRecordAction(Number(deleteInboundBtn.dataset.id)); }
  });
}

function bindStockControls() {
  document.querySelector("#stockHiddenToggle")?.addEventListener("click", () => {
    state.stockViewMode = state.stockViewMode === "active" ? "hidden" : "active";
    state.stockPage = 1;
    renderStockTable();
  });
  document.querySelector("#stockPrevPage")?.addEventListener("click", () => {
    state.stockPage = Math.max(1, state.stockPage - 1);
    renderStockTable();
  });
  document.querySelector("#stockNextPage")?.addEventListener("click", () => {
    state.stockPage = Math.min(stockTotalPages(), state.stockPage + 1);
    renderStockTable();
  });
}

function normalizeProcurementForm() {
  const form = document.querySelector("#procurementForm");
  if (!form || form.dataset.normalized === "1") return;
  const amountLabel = form.elements.amount?.closest("label");
  const quantityLabel = form.elements.quantity?.closest("label");
  const urgencyLabel = form.elements.urgency?.closest("label");
  const linkLabel = form.elements.purchase_url?.closest("label");
  const noteLabel = form.elements.note?.closest("label");
  const submitButton = form.querySelector("button[type='submit']");
  if (amountLabel) setLabelText(amountLabel, "采购总金额");
  if (quantityLabel) setLabelText(quantityLabel, "采购总数");
  if (linkLabel) linkLabel.classList.add("wide-field");
  if (noteLabel) noteLabel.classList.add("wide-field");
  if (amountLabel && quantityLabel) quantityLabel.before(amountLabel);
  if (!form.elements.shipping_amount && urgencyLabel) {
    const shippingLabel = document.createElement("label");
    shippingLabel.innerHTML = `采购总运费<input name="shipping_amount" type="number" step="0.01" value="0" />`;
    urgencyLabel.before(shippingLabel);
  }
  if (submitButton) submitButton.textContent = "加入需求池";
  form.dataset.normalized = "1";
}

function onSubmit(selector, url) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (selector === "#productForm") syncListingReferencePrice();
    const body = Object.fromEntries(new FormData(event.target));
    // 如果本次创建来源于在线商品，需要额外保留在线 SKU 的上下文关系。
    const finalUrl = selector === "#productForm" && body.online_product_id ? "/api/online-products/create-product" : url;
    await api(finalUrl, { method: "POST", body: JSON.stringify(body) });
    if (selector === "#procurementForm") state.selectedProcurementProductId = Number(body.product_id);
    event.target.reset();
    setDefaults();
    if (selector === "#productForm") closeSelectionCreatePanel();
    await loadAll();
  });
}

function bindImageUpload() {
  document.querySelector("#imageFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.querySelector("#imageData").value = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function bindShippingRecommendation() {
  for (const id of ["weightInput", "lengthInput", "widthInput", "heightInput"]) {
    document.querySelector(`#${id}`).addEventListener("input", updateRecommendation);
  }
  for (const id of ["purchaseCostInput", "domesticShipInput", "purchaseQtyInput", "exchangeRateInput", "returnRateInput", "desiredModeInput", "desiredValueInput", "saleRmbInput"]) {
    const el = document.querySelector(`#${id}`);
    if (el) el.addEventListener("input", updateRecommendation);
  }
}

function bindCelFbsCalculator() {
  const form = document.querySelector("#celFbsForm");
  if (!form) return;
  form.addEventListener("input", calculateCelFbs);
  calculateCelFbs();
}

async function calculateCelFbs() {
  const form = document.querySelector("#celFbsForm");
  const target = document.querySelector("#celFbsResult");
  if (!form || !target) return;
  const body = Object.fromEntries(new FormData(form));
  try {
    const result = await api("/api/pricing/cel-fbs", { method: "POST", body: JSON.stringify(body) });
    renderCelFbsResult(result);
  } catch (error) {
    target.innerHTML = `<div class="empty">计价失败：${escape(error.message)}</div>`;
  }
}

function renderCelFbsResult(result) {
  const target = document.querySelector("#celFbsResult");
  if (!target) return;
  if (!result?.matched) {
    target.innerHTML = `
      <div class="empty">${escape(result?.message || "当前售价、重量或尺寸未匹配到可用 CEL 渠道")}</div>
      <div class="pricing-metrics">
        ${metric("售价", `${num(result?.saleRmb, 2)} RMB / ${num(result?.listingPriceRub, 0)} RUB`)}
        ${metric("实际重量", `${num(result?.weightKg, 3)} KG`)}
        ${metric("三边和", `${num(result?.sumCm, 1)} CM`)}
        ${metric("体积重", `${num(result?.volumetricWeightKg, 3)} KG`)}
      </div>
    `;
    return;
  }

  const rows = result.channels.map((channel) => `
    <tr>
      <td>${escape(channel.channel)}</td>
      <td>${escape(channel.days)}</td>
      <td>${moneyText(channel.amount)}</td>
      <td>${moneyText(channel.commission)}</td>
      <td>${moneyText(channel.paymentFee + channel.withdrawalFee)}</td>
      <td>${moneyText(channel.expectedReturnLoss)}</td>
      <td class="${channel.profit < 0 ? "loss" : ""}">${moneyText(channel.profit)}</td>
      <td>${num(channel.margin, 2)}%</td>
    </tr>
  `).join("");

  target.innerHTML = `
    <div class="pricing-metrics">
      ${metric("匹配档位", result.categoryLabel)}
      ${metric("售价", `${num(result.saleRmb, 2)} RMB / ${num(result.listingPriceRub, 0)} RUB`)}
      ${metric("计费重量", `${num(result.chargeableWeightKg, 3)} KG`)}
      ${metric("体积重", `${num(result.volumetricWeightKg, 3)} KG`)}
      ${metric("三边和", `${num(result.sumCm, 1)} CM`)}
      ${metric("佣金率", `${num(result.commissionRate * 100, 0)}%`)}
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>渠道</th>
            <th>时效</th>
            <th>运费</th>
            <th>佣金</th>
            <th>手续费</th>
            <th>退货损失</th>
            <th>净利润</th>
            <th>净利率</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function metric(label, value) {
  return `<article><span>${escape(label)}</span><strong>${escape(value)}</strong></article>`;
}

function moneyText(value) {
  return `${num(value, 2)} RMB`;
}

function updateRecommendation() {
  syncListingReferencePrice();
  const weight = Number(document.querySelector("#weightInput").value || 0);
  const l = Number(document.querySelector("#lengthInput").value || 15);
  const w = Number(document.querySelector("#widthInput").value || 10);
  const h = Number(document.querySelector("#heightInput").value || 5);
  const longest = Math.max(l, w, h);
  const sum = l + w + h;
  const recommended = weight <= 500 && longest <= 60 && sum <= 90 ? "air_land" : weight <= 30000 && longest <= 150 && sum <= 310 ? "land" : "manual_review";
  document.querySelector("#shippingMethod").value = recommended;
  document.querySelector("#shippingHint").textContent = `推荐配送方式：${methodName(recommended)}，三边和 ${num(sum, 1)}cm，最长边 ${num(longest, 1)}cm`;

  // 反推建议上架价
  calcSuggestedPrice({
    purchaseCost: Number(document.querySelector("#purchaseCostInput")?.value || 0),
    domestic: Number(document.querySelector("#domesticShipInput")?.value || 0),
    handling: 0,
    qty: Math.max(Number(document.querySelector("#purchaseQtyInput")?.value || 1), 1),
    exchangeRate: Number(document.querySelector("#exchangeRateInput")?.value || currentExchangeRate()),
    returnRate: Number(document.querySelector("#returnRateInput")?.value || 0.05),
    mode: document.querySelector("#desiredModeInput")?.value || "margin",
    value: Number(document.querySelector("#desiredValueInput")?.value || 20),
    weightKg: weight / 1000,
    l, w, h
  }, "#suggestedPriceHint");
}

function syncListingReferencePrice() {
  const saleRmb = Number(document.querySelector("#saleRmbInput")?.value || 0);
  const exchangeRate = Number(document.querySelector("#exchangeRateInput")?.value || currentExchangeRate());
  const listingRmb = saleRmb ? saleRmb * 2 : 0;
  const listingRmbInput = document.querySelector("#listingPriceRmbInput");
  const listingRubInput = document.querySelector("#listingPriceRubInput");
  if (listingRmbInput) listingRmbInput.value = listingRmb ? listingRmb.toFixed(2) : "";
  if (listingRubInput) listingRubInput.value = listingRmb && exchangeRate ? (listingRmb * exchangeRate).toFixed(2) : "";
}

// 鈹€鈹€鈹€ 寤鸿涓婃灦浠峰墠绔弽鎺?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 鍓嶇杞婚噺鐗堝弽鎺ㄥ缓璁笂鏋朵环锛堜笌鍚庣 celRates 閫昏緫涓€鑷达級
 * @param {object} p - 浜у搧鍙傛暟
 * @param {string} targetSelector - 鏄剧ず缁撴灉鐨勫厓绱犻€夋嫨鍣? */
function calcSuggestedPrice(p, targetSelector) {
  const el = document.querySelector(targetSelector);
  if (!el) return;

  const mode = p.mode || "margin";
  if (mode !== "margin") { el.textContent = ""; return; }

  const targetMargin = p.value > 1 ? p.value / 100 : p.value;
  if (!targetMargin || targetMargin >= 1) { el.textContent = ""; return; }

  const purchaseCostPerUnit = p.purchaseCost + p.domestic / Math.max(p.qty, 1) + p.handling;
  if (!purchaseCostPerUnit) { el.textContent = "填写采购成本后自动计算建议上架价"; return; }

  const exchangeRate = p.exchangeRate || currentExchangeRate();
  const returnRate = p.returnRate || 0.05;
  const paymentFeeRate = 0.013;
  const withdrawalFeeRate = 0.012;

  // 简化估算运费
  const weightKg = p.weightKg || 0;
  const sum = (p.l || 15) + (p.w || 10) + (p.h || 5);
  const maxSide = Math.max(p.l || 15, p.w || 10, p.h || 5);
  const isSmall = weightKg <= 0.5 && maxSide <= 60 && sum <= 90;

  // 使用典型运费估算
  let airFreightRmb = isSmall ? (weightKg * 1000 * 0.0364 + 3.12) : (weightKg * 1000 * 0.026 + 23.92);
  let landFreightRmb = isSmall ? (weightKg * 1000 * 0.026 + 3.12) : (weightKg * 1000 * 0.01768 + 23.92);

  function calcRub(freightRmb) {
    for (const commRate of [0.12, 0.17]) {
      const denom = 1 - commRate - paymentFeeRate - withdrawalFeeRate - targetMargin;
      if (denom <= 0) return null;
      const saleRmb = (purchaseCostPerUnit + freightRmb) * (1 + returnRate) / denom;
      const rub = Math.round(saleRmb * exchangeRate);
      const correctComm = rub <= 1500 ? 0.12 : 0.17;
      if (correctComm === commRate) return rub;
    }
    return null;
  }

  const airRub = calcRub(airFreightRmb);
  const landRub = calcRub(landFreightRmb);
  if (targetSelector === "#suggestedPriceHint" && airRub && document.activeElement?.id !== "saleRmbInput") {
    const saleInput = document.querySelector("#saleRmbInput");
    if (saleInput) {
      saleInput.value = (airRub / exchangeRate).toFixed(2);
      syncListingReferencePrice();
    }
  }

  const lines = [];
  if (airRub) lines.push(`陆空最低上架价约 ${airRub} RUB / x2 参考价约 ${airRub * 2} RUB`);
  if (landRub) lines.push(`陆运最低上架价约 ${landRub} RUB / x2 参考价约 ${landRub * 2} RUB`);
  el.textContent = lines.length ? `目标净利率 ${Math.round(targetMargin * 100)}%：${lines.join("；")}` : "";
}

// 鈹€鈹€鈹€ 閫夊搧缂栬緫寮圭獥 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function closeEditDialog() {
  const dialog = document.querySelector("#editProductDialog");
  dialog.classList.remove("visible");
  // 绉婚櫎閬僵
  const backdrop = document.querySelector(".edit-dialog-backdrop");
  if (backdrop) backdrop.remove();
}

function bindEditDialog() {
  const dialog = document.querySelector("#editProductDialog");
  const form = document.querySelector("#editProductForm");

  // 鐐瑰嚮閬僵鍏抽棴
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target.classList.contains("edit-dialog-backdrop")) closeEditDialog();
  });

  // 绑定关闭按钮
  const closeBtn = document.querySelector("#editCancelBtn");
  const closeBtn2 = document.querySelector("#editCancelBtn2");
  if (closeBtn) closeBtn.addEventListener("click", closeEditDialog);
  if (closeBtn2) closeBtn2.addEventListener("click", closeEditDialog);
  const cancelSubmit = form.querySelector(".cancel-btn");
  if (cancelSubmit) cancelSubmit.addEventListener("click", closeEditDialog);

  // ESC 键关闭
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dialog.classList.contains("visible")) closeEditDialog();
  });

  // 缂栬緫鍥剧墖涓婁紶
  document.querySelector("#editImageFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.querySelector("#editImageData").value = reader.result;
      document.querySelector("#editImagePreview").src = reader.result;
      document.querySelector("#editImagePreview").style.display = "block";
    };
    reader.readAsDataURL(file);
  });

  // 编辑配送方式推荐和建议价
  for (const id of ["editWeight", "editLength", "editWidth", "editHeight", "editPurchaseCost", "editDomesticShip", "editPurchaseQty", "editExchangeRate", "editReturnRate", "editDesiredMode", "editDesiredValue", "editSaleRmbInput"]) {
    const el = document.querySelector(`#${id}`);
    if (el) el.addEventListener("input", updateEditRecommendation);
  }

  // 琛ㄥ崟鎻愪氦
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = form.dataset.productId;
    const body = Object.fromEntries(new FormData(form));
    // 濡傛灉娌℃湁鏂颁笂浼犲浘鐗囷紝淇濈暀鍘熸潵鐨?image_url
    if (!body.image_url) {
      body.image_url = form.dataset.originalImageUrl || "";
    }
    const btn = form.querySelector(".save-edit-btn");
    btn.disabled = true;
    btn.textContent = "保存中...";
    try {
      await api(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(body) });
      closeEditDialog();
      await loadAll();
    } finally {
      btn.disabled = false;
      btn.textContent = "保存修改";
    }
  });

  // 事件委托：编辑/删除按钮
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".edit-product-btn");
    if (btn) {
      const product = state.products.find((p) => p.id === Number(btn.dataset.id));
      if (product) openEditDialog(product);
      return;
    }
    const deleteBtn = e.target.closest(".delete-product-btn");
    if (deleteBtn) {
      const product = state.products.find((p) => p.id === Number(deleteBtn.dataset.id));
      if (!product) return;
      if (!confirm(`确定隐藏「${product.name}」吗？历史采购、入库、库存流水和订单会保留，可在“已隐藏产品”里恢复。`)) return;
      state.stockPage = 1;
      api(`/api/products/${product.id}`, { method: "DELETE" }).then(loadAll);
      return;
    }
    const restoreBtn = e.target.closest(".restore-product-btn");
    if (restoreBtn) {
      const product = state.hiddenProducts.find((p) => p.id === Number(restoreBtn.dataset.id));
      if (!product) return;
      state.stockPage = 1;
      api(`/api/products/${product.id}/restore`, { method: "POST", body: JSON.stringify({}) }).then(loadAll);
    }
  });
}

function updateEditRecommendation() {
  syncEditListingReferencePrice();
  const form = document.querySelector("#editProductForm");
  const weight = Number(document.querySelector("#editWeight").value || 0);
  const l = Number(document.querySelector("#editLength").value || 30);
  const w = Number(document.querySelector("#editWidth").value || 20);
  const h = Number(document.querySelector("#editHeight").value || 10);
  const longest = Math.max(l, w, h);
  const sum = l + w + h;
  const recommended = weight <= 500 && longest <= 60 && sum <= 90 ? "air_land" : weight <= 30000 && longest <= 150 && sum <= 310 ? "land" : "manual_review";
  document.querySelector("#editShippingHint").textContent = `推荐：${methodName(recommended)}（三边和 ${num(sum, 1)}cm，最长边 ${num(longest, 1)}cm）`;

  // 反推建议价
  calcSuggestedPrice({
    purchaseCost: Number(form?.querySelector("[name='purchase_cost']")?.value || 0),
    domestic: Number(form?.querySelector("[name='domestic_shipping']")?.value || 0),
    handling: 0,
    qty: Math.max(Number(form?.querySelector("[name='purchase_quantity']")?.value || 1), 1),
    exchangeRate: Number(form?.querySelector("[name='exchange_rate']")?.value || currentExchangeRate()),
    returnRate: Number(form?.querySelector("[name='return_rate']")?.value || 0.05),
    mode: form?.querySelector("[name='desired_profit_mode']")?.value || "margin",
    value: Number(form?.querySelector("[name='desired_profit_value']")?.value || 20),
    weightKg: weight / 1000,
    l, w, h
  }, "#editSuggestedPriceHint");
}

function syncEditListingReferencePrice() {
  const saleRmb = Number(document.querySelector("#editSaleRmbInput")?.value || 0);
  const exchangeRate = Number(document.querySelector("#editExchangeRate")?.value || currentExchangeRate());
  const listingRmb = saleRmb ? saleRmb * 2 : 0;
  const listingRmbInput = document.querySelector("#editListingPriceRmbInput");
  const listingRubInput = document.querySelector("#editListingPriceRubInput");
  if (listingRmbInput) listingRmbInput.value = listingRmb ? listingRmb.toFixed(2) : "";
  if (listingRubInput) listingRubInput.value = listingRmb && exchangeRate ? (listingRmb * exchangeRate).toFixed(2) : "";
}

function openEditDialog(product) {
  const dialog = document.querySelector("#editProductDialog");
  // 闃叉閲嶅鎵撳紑
  if (!product?.id) return;
  if (dialog.classList.contains("visible")) return;

  const form = document.querySelector("#editProductForm");
  form.dataset.productId = product.id;
  form.dataset.originalImageUrl = product.image_url || "";

  fillPeople("editOwnerPerson");
  fillPeople("editCreatorPerson");
  document.querySelector("#editOwnerName").textContent = product.owner_name || "-";
  setVal(form, "owner_person_id", product.owner_person_id || state.currentUserId);
  setVal(form, "created_by_person_id", product.created_by_person_id || product.owner_person_id || state.currentUserId);

  // 填充各字段
  setVal(form, "name", product.name);
  setVal(form, "source_platform", product.source_platform || "1688");
  setVal(form, "shipping_method", product.shipping_method || "air_land");
  setVal(form, "desired_profit_mode", product.desired_profit_mode || "margin");
  setVal(form, "desired_profit_value", product.desired_profit_value ?? 20);
  setVal(form, "return_rate", product.return_rate ?? 0.05);
  setVal(form, "purchase_cost", product.purchase_cost ?? 0);
  setVal(form, "domestic_shipping", product.domestic_shipping ?? 0);
  setVal(form, "handling_fee", product.handling_fee ?? 0);
  setVal(form, "purchase_quantity", product.purchase_quantity ?? 1);
  setVal(form, "package_weight_g", product.package_weight_g ?? 0);
  setVal(form, "length_cm", product.length_cm ?? 30);
  setVal(form, "width_cm", product.width_cm ?? 20);
  setVal(form, "height_cm", product.height_cm ?? 10);
  const saleRmb = Number(product.air_sale_price_rmb || 0) || listingRubToRmb(product.listing_price_rub, product.exchange_rate) / 2;
  setVal(form, "air_sale_price_rmb", saleRmb || 0);
  setVal(form, "exchange_rate", product.exchange_rate ?? currentExchangeRate());
  syncEditListingReferencePrice();
  setVal(form, "purchase_url", product.purchase_url || "");
  setVal(form, "supplier_note", product.supplier_note || "");

  // 鍥剧墖棰勮
  const preview = document.querySelector("#editImagePreview");
  if (product.image_url) {
    preview.src = product.image_url;
    preview.style.display = "block";
  } else {
    preview.src = "";
    preview.style.display = "none";
  }
  // 清空图片输入，提交时未选新图则沿用原图
  document.querySelector("#editImageData").value = "";
  document.querySelector("#editImageFile").value = "";

  // 鏇存柊鎺ㄨ崘鏂囧瓧
  updateEditRecommendation();

  // 璁剧疆寮圭獥鏍囬
  document.querySelector("#editDialogTitle").textContent = `编辑选品：${product.name}`;

  // 鎵嬪姩鎺у埗鏄剧ず锛堟浛浠?showModal锛屽畬鍏ㄩ伩鍏嶆祻瑙堝櫒鍏煎闂锛?  // 鍏堢Щ闄ゆ棫閬僵
  const oldBackdrop = document.querySelector(".edit-dialog-backdrop");
  if (oldBackdrop) oldBackdrop.remove();
  // 鍒涘缓閬僵
  const backdrop = document.createElement("div");
  backdrop.className = "edit-dialog-backdrop";
  backdrop.addEventListener("click", closeEditDialog);
  document.body.appendChild(backdrop);
  // 鏄剧ず寮圭獥
  dialog.classList.add("visible");
  // 鑱氱劍鍒扮涓€涓緭鍏ユ
  dialog.querySelector("input, select")?.focus();
}

function setVal(form, name, value) {
  const el = form.querySelector(`[name="${name}"]`);
  if (el) el.value = value;
}

// 鈹€鈹€鈹€ 鏁版嵁鍔犺浇 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function loadAll() {
  // 首屏并行加载全局主数据，保证多个模块读到的是同一批状态快照。
  const [systemInfo, exchangeRate, exchangeRates, products, hiddenProducts, people, shops, onlineProducts, inboundRecords, outboundRecords, procurementSummary, procurementRequests, purchaseOrders, pendingInbound, orders, profitSummary] = await Promise.all([
    api("/api/system/info"),
    api("/api/exchange-rate/current"),
    api("/api/exchange-rates"),
    api("/api/products"),
    api("/api/products/hidden"),
    api("/api/people"),
    api("/api/shops"),
    api("/api/online-products"),
    api("/api/inbound-records"),
    api("/api/outbound-records"),
    api("/api/procurement/summary"),
    api("/api/procurement/requests"),
    api("/api/procurement/purchase-orders"),
    api("/api/procurement/pending-inbound"),
    api("/api/orders"),
    api("/api/profit-summary")
  ]);
  Object.assign(state, { systemInfo, exchangeRate, exchangeRates, products, hiddenProducts, people, shops, onlineProducts, inboundRecords, outboundRecords, procurementSummary, procurementRequests, purchaseOrders, pendingInbound, orders, profitSummary });
  renderAll();
  restoreCurrentView();
}

function bindOrderControls() {
  document.querySelector("#orderStatusButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button) return;
    state.orderFilters.status = button.dataset.status;
    state.orderFilters.page = 1;
    localStorage.setItem("orderFilter:status", state.orderFilters.status);
    renderOrdersTable();
  });
  document.querySelector("#orderPageSize")?.addEventListener("change", (event) => {
    state.orderFilters.pageSize = Number(event.target.value || 30);
    state.orderFilters.page = 1;
    localStorage.setItem("orderFilter:pageSize", String(state.orderFilters.pageSize));
    renderOrdersTable();
  });
  document.querySelector("#orderPrevPage")?.addEventListener("click", () => {
    state.orderFilters.page = Math.max(1, state.orderFilters.page - 1);
    renderOrdersTable();
  });
  document.querySelector("#orderNextPage")?.addEventListener("click", () => {
    const totalPages = orderTotalPages();
    state.orderFilters.page = Math.min(totalPages, state.orderFilters.page + 1);
    renderOrdersTable();
  });
  document.querySelector("#orderDateFrom")?.addEventListener("change", (event) => {
    state.orderFilters.dateFrom = event.target.value;
    state.orderFilters.page = 1;
    localStorage.setItem("orderFilter:dateFrom", state.orderFilters.dateFrom);
    renderOrdersTable();
  });
  document.querySelector("#orderDateTo")?.addEventListener("change", (event) => {
    state.orderFilters.dateTo = event.target.value;
    state.orderFilters.page = 1;
    localStorage.setItem("orderFilter:dateTo", state.orderFilters.dateTo);
    renderOrdersTable();
  });
  document.querySelector("#orderDateReset")?.addEventListener("click", () => {
    state.orderFilters.dateFrom = defaultDateFrom(30);
    state.orderFilters.dateTo = todayInputValue();
    state.orderFilters.page = 1;
    localStorage.setItem("orderFilter:dateFrom", state.orderFilters.dateFrom);
    localStorage.setItem("orderFilter:dateTo", state.orderFilters.dateTo);
    renderOrdersTable();
  });
}

function renderAll() {
  renderSystemInfo();
  fillSelects();
  renderConfigAccountInfo(currentUser);
  renderExchangeRateConfig();
  renderTable("selectionTable", state.products, visibleColumns("selection"));
  renderStockTable();
  renderOnlineTable();
  syncProcurementFilters();
  renderProcProductOptions();
  updateProcProductPreview();
  renderProcurementRequests();
  renderProcurementWorkspace();
  renderInboundAlert();
  renderTable("inboundTable", state.inboundRecords, [
    ["time", "时间", (r) => date(r.created_at)],
    ["image", "图片", (r) => image(r.product_image_url)],
    ["product", "产品名称", (r) => strong(r.product_name, r.product_code || "")],
    ["person", "归属人", (r) => r.person_name],
    ["qty", "数量", (r) => r.quantity],
    ["amount", "货款/运费", (r) => `${money(r.amount)}<small>运费 ${money(r.shipping_amount)}</small>`],
    ["unit", "单价", (r) => money(r.unit_cost)],
    ["status", "状态", (r) => tag(inboundWaitDays(r) > 2 && r.status === "pending_arrival" ? "超 2 天待验收" : inboundStatus(r.status), r.status === "approved" ? "green" : inboundWaitDays(r) > 2 ? "red" : "amber")],
    ["actions", "操作", (r) => `<span class="action-row">${r.status === "pending_arrival" ? `<button class="linklike approve-inbound-btn" data-id="${r.id}">验收通过</button>` : ""}<button class="linklike edit-inbound-record-btn" data-id="${r.id}">编辑</button><button class="linklike danger delete-inbound-record-btn" data-id="${r.id}">删除</button></span>`]
  ]);
  bindInboundActions();
  renderTable("outboundTable", state.outboundRecords, [
    ["time", "时间", (r) => date(r.created_at)],
    ["order", "订单", (r) => r.order_ref],
    ["shop", "店铺", (r) => r.shop_name],
    ["sku", "SKU", (r) => r.ozon_sku],
    ["product", "产品", (r) => r.product_name],
    ["qty", "数量", (r) => r.quantity],
    ["reason", "原因", (r) => outboundReason(r.reason)],
    ["status", "状态", (r) => tag(r.status, "green")]
  ]);
  renderOutboundTable();
  renderTable("peopleTable", state.people, [
    ["name", "姓名", (r) => r.name],
    ["username", "登录名", (r) => r.username],
    ["role", "角色", (r) => roleName(r.role)],
    ["active", "状态", (r) => tag(r.active ? "启用" : "停用", r.active ? "green" : "red")],
    ["actions", "操作", (r) => `<span class="action-row"><button class="linklike edit-person-btn" data-id="${r.id}">编辑</button><button class="linklike danger delete-person-btn" data-id="${r.id}">停用</button><button class="linklike danger hard-delete-person-btn" data-id="${r.id}">删除</button></span>`]
  ]);
  renderTable("shopsTable", state.shops, [
    ["name", "店铺", (r) => r.name],
    ["legal", "主体", (r) => r.legal_entity],
    ["client", "Client ID", (r) => r.ozon_client_id],
    ["hint", "API Key", (r) => maskSecret(r.api_key_hint)],
    ["status", "状态", (r) => tag(r.status, r.status === "active" ? "green" : "amber")],
    ["actions", "操作", (r) => `<span class="action-row"><button class="linklike edit-shop-btn" data-id="${r.id}">编辑</button><button class="linklike danger delete-shop-btn" data-id="${r.id}">删除</button></span>`]
  ]);
  renderOrdersTable();
  renderProfitSummary();
}

function bindExchangeRateForm() {
  document.querySelector("#exchangeRateForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.querySelector("#exchangeRateStatus");
    const body = Object.fromEntries(new FormData(event.target));
    if (status) status.textContent = "正在保存汇率...";
    try {
      await api("/api/exchange-rate", { method: "POST", body: JSON.stringify(body) });
      if (status) status.textContent = "汇率已保存，新选品会使用最新汇率。";
      await loadAll();
    } catch (error) {
      if (status) status.textContent = `保存失败：${error.message}`;
    }
  });
}

function renderExchangeRateConfig() {
  const current = state.exchangeRate || {};
  const rateInput = document.querySelector("#exchangeRateConfigInput");
  const dateInput = document.querySelector("#exchangeRateDateInput");
  if (rateInput) rateInput.value = current.rate || currentExchangeRate();
  if (dateInput) dateInput.value = current.effective_date || todayInputValue();
  renderTable("exchangeRateTable", state.exchangeRates || [], [
    ["date", "生效日期", (r) => r.effective_date],
    ["rate", "汇率", (r) => strong(`1 RMB = ${num(r.rate, 4)} RUB`, r.source || "")],
    ["note", "备注", (r) => r.note || ""],
    ["created", "记录时间", (r) => date(r.created_at)]
  ]);
  const productRate = document.querySelector("#exchangeRateInput");
  if (productRate && !productRate.value) productRate.value = currentExchangeRate();
  const formulaRate = document.querySelector("#celFbsForm [name='exchange_rate']");
  if (formulaRate && (!formulaRate.dataset.rateInitialized || formulaRate.value === "11.32")) {
    formulaRate.value = currentExchangeRate();
    formulaRate.dataset.rateInitialized = "1";
    calculateCelFbs();
  }
}

function renderProfitSummary() {
  const data = state.profitSummary || {};
  const summary = data.summary || {};
  const overview = document.querySelector("#profitOverview");
  if (overview) {
    const revenue = Number(summary.revenue || 0);
    const estimated = Number(summary.estimated_profit || 0);
    const accrued = Number(summary.accrued_profit || 0);
    const pending = Number(summary.pending_profit || 0);
    overview.innerHTML = `
      <article><span>有效订单</span><strong>${escape(summary.order_count || 0)}</strong><small>${escape(summary.item_quantity || 0)} 件商品</small></article>
      <article><span>总销售额</span><strong>${moneyPlain(revenue)}</strong><small>不含已取消订单</small></article>
      <article><span>预估净利润</span><strong class="${estimated < 0 ? "loss" : ""}">${moneyPlain(estimated)}</strong><small>${profitPercent(estimated, revenue)}</small></article>
      <article><span>已确认利润</span><strong class="${accrued < 0 ? "loss" : ""}">${moneyPlain(accrued)}</strong><small>已签收/已结算口径</small></article>
      <article><span>待确认利润</span><strong class="${pending < 0 ? "loss" : ""}">${moneyPlain(pending)}</strong><small>未签收订单预估</small></article>
      <article><span>取消订单</span><strong>${escape(summary.cancelled_orders || 0)}</strong><small>${moneyPlain(summary.cancelled_revenue || 0)}</small></article>
    `;
  }

  renderTable("profitShopTable", data.byShop || [], [
    ["shop", "店铺", (r) => strong(r.shop_name, `${r.order_count || 0} 单 / ${r.item_quantity || 0} 件`)],
    ["revenue", "销售额", (r) => money(r.revenue)],
    ["profit", "利润", (r) => profitSummaryMoney(r.profit, r.revenue)],
    ["cancel", "取消", (r) => `${escape(r.cancelled_orders || 0)} 单<small>${money(r.cancelled_revenue)}</small>`]
  ]);

  renderTable("profitSkuTable", data.bySku || [], [
    ["sku", "SKU", (r) => strong(r.ozon_sku, r.shop_name)],
    ["product", "绑定产品", (r) => strong(r.product_code, `${r.product_name || ""} / ${r.owner_name || ""}`)],
    ["qty", "出单", (r) => `${escape(r.order_count || 0)} 单<small>${escape(r.item_quantity || 0)} 件</small>`],
    ["revenue", "销售额", (r) => money(r.revenue)],
    ["profit", "利润", (r) => profitSummaryMoney(r.profit, r.revenue)]
  ]);

  renderTable("profitProductTable", data.byProduct || [], [
    ["product", "库存产品", (r) => strong(r.product_code, r.product_name)],
    ["owner", "负责人", (r) => r.owner_name],
    ["sku", "SKU/库存", (r) => `${escape(r.sku_count || 0)} 个 SKU<small>可用库存 ${escape(r.available_stock || 0)}</small>`],
    ["qty", "出单", (r) => `${escape(r.order_count || 0)} 单<small>${escape(r.item_quantity || 0)} 件</small>`],
    ["revenue", "销售额", (r) => money(r.revenue)],
    ["profit", "利润", (r) => profitSummaryMoney(r.profit, r.revenue)]
  ]);
}

function profitSummaryMoney(profit, revenue) {
  const value = Number(profit || 0);
  return `<span class="money ${value < 0 ? "loss" : ""}">${num(value, 2)}</span><small>${profitPercent(value, Number(revenue || 0))}</small>`;
}

function profitPercent(profit, revenue) {
  const rev = Number(revenue || 0);
  if (!rev) return "利润率 0.00%";
  return `利润率 ${num((Number(profit || 0) / rev) * 100, 2)}%`;
}

function moneyPlain(value) {
  return `${num(value, 2)}`;
}

function renderStockTable() {
  const target = document.querySelector("#stockTable");
  if (!target) return;
  const isHidden = state.stockViewMode === "hidden";
  const rows = isHidden ? (state.hiddenProducts || []) : (state.products || []);
  const totalPages = stockTotalPages();
  state.stockPage = Math.min(Math.max(1, state.stockPage), totalPages);
  syncStockControls(rows.length);
  const pageRows = rows.slice((state.stockPage - 1) * state.stockPageSize, state.stockPage * state.stockPageSize);
  if (!isHidden) {
    renderTable("stockTable", pageRows, visibleColumns("stock"));
    return;
  }
  if (!rows.length) {
    target.innerHTML = `<div class="empty">暂无隐藏产品</div>`;
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table class="table">
    <thead><tr><th>产品</th><th>归属人</th><th>当前库存</th><th>待入库</th><th>库存流水</th><th>操作</th></tr></thead>
    <tbody>${pageRows.map((row) => `<tr>
      <td><div class="outbound-product">${image(row.image_url)}<span><strong>${escape(row.name)}</strong><small>${escape(row.inventory_id || row.code || "")}</small></span></div></td>
      <td>${escape(row.owner_name || "")}</td>
      <td>${escape(row.stock || 0)}</td>
      <td>${escape(row.pending_inbound || 0)}</td>
      <td>${escape(row.movement_count || 0)}</td>
      <td><button class="linklike restore-product-btn" data-id="${row.id}">恢复到库存表</button></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function stockRows() {
  return state.stockViewMode === "hidden" ? (state.hiddenProducts || []) : (state.products || []);
}

function stockTotalPages() {
  return Math.max(1, Math.ceil(stockRows().length / state.stockPageSize));
}

function syncStockControls(total) {
  const hidden = state.stockViewMode === "hidden";
  const title = document.querySelector("#stockPanelTitle");
  const toggle = document.querySelector("#stockHiddenToggle");
  const add = document.querySelector("#openProductCreate");
  const info = document.querySelector("#stockPageInfo");
  const prev = document.querySelector("#stockPrevPage");
  const next = document.querySelector("#stockNextPage");
  const totalPages = stockTotalPages();
  if (title) title.textContent = hidden ? "已隐藏产品" : "产品库存表";
  if (toggle) toggle.textContent = hidden ? "返回库存表" : "已隐藏产品";
  if (add) add.style.display = hidden ? "none" : "";
  if (info) info.textContent = `第 ${state.stockPage} / ${totalPages} 页，共 ${total} 条`;
  if (prev) prev.disabled = state.stockPage <= 1;
  if (next) next.disabled = state.stockPage >= totalPages;
}

function renderSystemInfo() {
  const target = document.querySelector("#systemInfo");
  if (!target) return;
  const info = state.systemInfo;
  if (!info) {
    target.textContent = "正在读取数据文件...";
    return;
  }
  const sizeMb = info.databaseSizeBytes ? `${(info.databaseSizeBytes / 1024 / 1024).toFixed(2)} MB` : "0 MB";
  target.innerHTML = `
    <strong>数据安全</strong>
    <span title="${escape(info.databasePath)}">当前文件：${escape(shortPath(info.databasePath))}</span>
    <small>${info.databaseExists ? `数据库大小 ${sizeMb}` : "未找到数据库文件"}</small>
    <div class="data-actions">
      <span>备份：双击 <code>backup-data.bat</code></span>
      <span>恢复：双击 <code>restore-data.bat</code></span>
    </div>
    <small>换电脑或压缩项目之前，先备份。</small>
  `;
}

// 渲染配置页账户信息
function renderConfigAccountInfo(user) {
  const nameEl = document.querySelector("#configUserName");
  const roleEl = document.querySelector("#configUserRole");
  if (nameEl) nameEl.textContent = user ? (user.name || user.username || "-") : "-";
  if (roleEl) roleEl.textContent = user ? roleName(user.role) : "-";
}

// 鈹€鈹€鈹€ 鍦ㄧ嚎鍟嗗搧椤垫覆鏌?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function filteredOutboundRows() {
  const allRows = state.outboundRecords || [];
  const f = state.outboundFilters;
  return allRows.filter((row) => {
    if (!row.created_at) return false;
    const d = row.created_at.slice(0, 10);
    if (f.dateFrom && d < f.dateFrom) return false;
    if (f.dateTo && d > f.dateTo) return false;
    return true;
  });
}

function renderOutboundTable() {
  const target = document.querySelector("#outboundTable");
  if (!target) return;
  const allRows = state.outboundRecords || [];
  if (!allRows.length) {
    target.innerHTML = `<div class="empty">暂无出库记录。同步订单后，系统会自动生成待出库或已扣库存记录。</div>`;
    updateOutboundPager(0);
    syncOutboundFilterInputs();
    return;
  }
  const filter = state.outboundFilters;
  const filtered = filteredOutboundRows();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / filter.pageSize));
  if (filter.page > totalPages) filter.page = totalPages;
  const start = (filter.page - 1) * filter.pageSize;
  const rows = filtered.slice(start, start + filter.pageSize);

  const summary = outboundSummary(filtered);
  const cols = [
    ["time", "时间", (r) => date(r.created_at)],
    ["order", "订单信息", (r) => outboundOrderCell(r)],
    ["image", "商品图", (r) => outboundImageCell(r)],
    ["qty", "数量", (r) => tag(r.quantity || 0, Number(r.quantity || 0) > 1 ? "blue" : "")],
    ["sku", "SKU", (r) => r.ozon_sku],
    ["product", "库存产品", (r) => outboundProductCell(r)],
    ["status", "状态", (r) => outboundStatusCell(r)],
    ["audit", "流水审计", (r) => outboundAuditCell(r)]
  ];
  renderOutboundInlineSummary(total, summary);
  target.innerHTML = `
    <div class="table-wrap"><table class="table outbound-table"><thead><tr>${cols.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${cols.map(([, , getter]) => `<td>${getter(row) ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  syncOutboundFilterInputs();
  updateOutboundPager(total);
}

function syncOutboundFilterInputs() {
  const pageSize = document.querySelector("#outboundPageSize");
  if (pageSize) pageSize.value = String(state.outboundFilters.pageSize);
  const dateFrom = document.querySelector("#outboundDateFrom");
  if (dateFrom) dateFrom.value = state.outboundFilters.dateFrom || "";
  const dateTo = document.querySelector("#outboundDateTo");
  if (dateTo) dateTo.value = state.outboundFilters.dateTo || "";
}

function updateOutboundPager(total) {
  const pageInfo = document.querySelector("#outboundPageInfo");
  const prev = document.querySelector("#outboundPrevPage");
  const next = document.querySelector("#outboundNextPage");
  const totalPages = Math.max(1, Math.ceil(total / state.outboundFilters.pageSize));
  if (pageInfo) pageInfo.textContent = `第 ${state.outboundFilters.page} / ${totalPages} 页，共 ${total} 条`;
  if (prev) prev.disabled = state.outboundFilters.page <= 1;
  if (next) next.disabled = state.outboundFilters.page >= totalPages;
}

function renderOutboundInlineSummary(total, summary) {
  const target = document.querySelector("#outboundInlineSummary");
  if (!target) return;
  const filter = state.outboundFilters;
  const rangeText = filter.dateFrom || filter.dateTo
    ? `${filter.dateFrom || "..."} ~ ${filter.dateTo || "今天"}`
    : "全部数据";
  target.innerHTML = `
    <span>${escape(rangeText)}</span>
    <b>${escape(total)} 条明细</b>
    <b>${escape(summary.totalOrders)} 个订单</b>
    <b>${escape(summary.totalQty)} 件</b>
    ${summary.cancelledCount ? `<b class="danger-text">${escape(summary.cancelledCount)} 条已取消</b>` : `<b>真实流水</b>`}
  `;
}

function outboundSummary(rows) {
  const byShop = new Map();
  for (const row of rows) {
    const shop = row.shop_name || "未记录店铺";
    const current = byShop.get(shop) || { shop, qty: 0, orders: new Set() };
    current.qty += Number(row.quantity || 0);
    if (row.order_ref) current.orders.add(row.order_ref);
    byShop.set(shop, current);
  }
  const totalQty = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const totalOrders = new Set(rows.map((row) => row.order_ref).filter(Boolean)).size;
  return {
    totalQty,
    totalOrders,
    cancelledCount: rows.filter((row) => row.status === "cancelled").length,
    shopStats: [...byShop.values()].map((item) => ({ shop: item.shop, qty: item.qty, orders: item.orders.size }))
  };
}

function outboundImageCell(row) {
  const src = String(row.image_urls || row.product_image_url || "").split(",").find(Boolean);
  return image(src);
}

function outboundOrderCell(row) {
  const shop = row.shop_name ? `（${row.shop_name}）` : "";
  return strong(row.order_ref || "-", `${row.order_number || ""}${shop}`);
}

function outboundProductCell(row) {
  return `<div class="outbound-product">${image(row.product_image_url || row.image_urls)}<div>${strong(row.product_code || "", row.product_name || "")}</div></div>`;
}

function outboundStatusCell(row) {
  if (row.status === "cancelled") return tag("已取消回退", "amber");
  return tag("已扣库存", "green");
}

function outboundAuditCell(row) {
  const movement = row.order_item_id ? `明细 #${row.order_item_id}` : "无明细ID";
  const operator = row.person_name ? `负责人：${row.person_name}` : "负责人未记录";
  const note = row.note || outboundReason(row.reason);
  return `<div class="outbound-audit">${strong(movement, operator)}<small>${escape(note || "")}</small></div>`;
}

function renderOnlineTable() {
  syncOnlineControls();
  const rows = filteredOnlineRows();
  const target = document.querySelector("#onlineTable");
  if (!rows?.length) {
    target.innerHTML = `<div class="empty">暂无数据。可以切换店铺筛选，或点击“同步 Ozon 在线商品”从店铺拉取 SKU。</div>`;
    updateOnlinePager(0);
    return;
  }
  const totalPages = onlineTotalPages();
  state.onlineFilters.page = Math.min(Math.max(1, state.onlineFilters.page), totalPages);
  const start = (state.onlineFilters.page - 1) * state.onlineFilters.pageSize;
  const pageRows = rows.slice(start, start + state.onlineFilters.pageSize);
  const cols = [
    ["shop", "所属店铺 / 状态", (r) => onlineShopCell(r)],
    ["sku", "Ozon SKU ID", (r) => onlineSkuCell(r)],
    ["image", "鍥剧墖", (r) => onlineImageCell(r)],
    ["product", "商品信息", (r) => onlineProductCell(r)],
    ["price", "售价", (r) => onlinePriceCell(r)],
    ["extra", "其他 Ozon 信息", (r) => onlineExtraCell(r)],
    ["bind", "绑定", (r) => r.product_id ? `<span class="tag green">已绑定</span>` : `<span class="action-row"><button class="linklike quick-bind-btn" data-id="${r.id}">去绑定</button><button class="linklike create-product-from-online-btn" data-id="${r.id}">创建库存</button></span>`]
  ];
  target.innerHTML = `<div class="table-wrap"><table class="table online-table"><thead><tr>${cols.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${pageRows.map((row) => `<tr>${cols.map(([, , getter]) => `<td>${getter(row) ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  updateOnlinePager(rows.length);

  // 快速绑定
  target.querySelectorAll(".quick-bind-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      openBindDialog(id);
    });
  });
  target.querySelectorAll(".create-product-from-online-btn").forEach((btn) => {
    btn.addEventListener("click", () => openProductCreateDialog(Number(btn.dataset.id)));
  });
}

function syncOnlineControls() {
  const shopSelect = document.querySelector("#onlineShopFilter");
  if (shopSelect) {
    const value = state.onlineFilters.shopId || "all";
    shopSelect.innerHTML = `<option value="all">全部店铺</option>${state.shops.map((shop) => `<option value="${shop.id}">${escape(shop.name)}</option>`).join("")}`;
    shopSelect.value = [...shopSelect.options].some((option) => option.value === value) ? value : "all";
    state.onlineFilters.shopId = shopSelect.value;
  }
  const pageSize = document.querySelector("#onlinePageSize");
  if (pageSize) pageSize.value = String(state.onlineFilters.pageSize);
}

function filteredOnlineRows() {
  const shopId = state.onlineFilters.shopId;
  return state.onlineProducts.filter((row) => shopId === "all" || String(row.shop_id) === String(shopId));
}

function onlineTotalPages() {
  return Math.max(1, Math.ceil(filteredOnlineRows().length / state.onlineFilters.pageSize));
}

function updateOnlinePager(total) {
  const pageInfo = document.querySelector("#onlinePageInfo");
  const prev = document.querySelector("#onlinePrevPage");
  const next = document.querySelector("#onlineNextPage");
  const totalPages = Math.max(1, Math.ceil(total / state.onlineFilters.pageSize));
  if (pageInfo) pageInfo.textContent = `第 ${state.onlineFilters.page} / ${totalPages} 页，共 ${total} 条`;
  if (prev) prev.disabled = state.onlineFilters.page <= 1;
  if (next) next.disabled = state.onlineFilters.page >= totalPages;
}

function renderProcurementSummary() {
  const target = document.querySelector("#procurementSummary");
  if (!target) return;
  const rows = state.procurementSummary || [];
  if (!rows.length) {
    target.innerHTML = `<div class="empty">暂无待采购请求</div>`;
    state.selectedProcurementProductId = null;
    return;
  }
  if (!state.selectedProcurementProductId || !rows.some((row) => Number(row.product_id) === Number(state.selectedProcurementProductId))) {
    state.selectedProcurementProductId = Number(rows[0].product_id);
  }
  target.innerHTML = `<div class="procurement-summary-list">${rows.map((row) => {
    const selected = Number(row.product_id) === Number(state.selectedProcurementProductId);
    const requesterCount = String(row.requesters || "").split("||").filter(Boolean).length;
    return `
      <button class="procurement-summary-row ${selected ? "active" : ""} ${row.overdue ? "overdue" : ""}" type="button" data-product-id="${row.product_id}">
        ${image(row.image_url)}
        <span class="proc-summary-main">
          <strong>${escape(row.code || "")}</strong>
          <small>${escape(row.name || "")}</small>
          <small>${requesterCount} 人提交 / 最早 ${date(row.earliest_created_at)}</small>
        </span>
        <span class="proc-summary-total">
          <b>${escape(row.total_quantity)}</b>
          <small>${money(row.total_amount)}</small>
        </span>
      </button>
    `;
  }).join("")}</div>`;
}

function renderProcurementRequests() {
  const target = document.querySelector("#procurementRequests");
  if (!target) return;
  const rows = filteredProcurementRequests();
  if (!rows.length) {
    target.innerHTML = `<div class="empty">暂无待合并采购需求</div>`;
    return;
  }
  target.innerHTML = `
    <div class="table-wrap"><table class="table procurement-detail-table">
      <thead><tr><th></th><th>产品</th><th>库存</th><th>申请人</th><th>数量</th><th>货款</th><th>运费</th><th>均摊</th><th>采购链接</th><th>备注</th><th>紧急</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.overdue ? "row-overdue" : ""}">
        <td><input class="proc-request-check" type="checkbox" data-id="${r.id}" ${state.procurementSelectedRequestIds.has(Number(r.id)) ? "checked" : ""} ${r.status === "pending" ? "" : "disabled"} /></td>
        <td><div class="outbound-product">${image(r.product_image_url)}<span><strong>${escape(r.product_name || "")}</strong><small>${escape(r.product_code || "")} / ${escape(r.mapped_skus || "无 SKU")}</small></span></div></td>
        <td>${stockWarningCell(r)}</td>
        <td>${escape(r.person_name || "")}</td>
        <td>${escape(r.quantity)}</td>
        <td>${money(r.amount)}</td>
        <td>${money(r.shipping_amount)}</td>
        <td>${money(procurementAverageCost(r))}</td>
        <td>${link(r.purchase_url || r.product_purchase_url)}</td>
        <td>${escape(r.note || "")}</td>
        <td>${tag(procUrgencyName(r.urgency), r.urgency === "urgent" ? "red" : "blue")}</td>
        <td>${tag(procRequestStatusName(r.status), procRequestStatusColor(r.status))}</td>
        <td>${date(r.created_at)}</td>
        <td><button class="linklike cancel-proc-request-btn" data-id="${r.id}" ${r.status === "pending" ? "" : "disabled"}>取消需求</button></td>
      </tr>`).join("")}</tbody></table></div>
  `;
}

function procurementAverageCost(row) {
  const quantity = Number(row.quantity || 0);
  return quantity ? (Number(row.amount || 0) + Number(row.shipping_amount || 0)) / quantity : 0;
}

function filteredProcurementRequests() {
  return (state.procurementRequests || []).filter((row) => {
    const status = state.procurementFilters.status;
    const statusOk = status === "all" || row.status === status;
    const personOk = state.procurementFilters.personId === "all" || String(row.person_id) === String(state.procurementFilters.personId);
    const urgencyOk = state.procurementFilters.urgency === "all" || row.urgency === state.procurementFilters.urgency;
    const q = normalizeSearch(state.procurementFilters.query);
    const queryOk = !q || normalizeSearch(`${row.product_name || ""} ${row.product_code || ""} ${row.mapped_skus || ""}`).includes(q);
    return statusOk && personOk && urgencyOk && queryOk;
  });
}

function syncProcurementFilters() {
  const person = document.querySelector("#procPersonFilter");
  if (person) {
    person.innerHTML = `<option value="all">全部申请人</option>${state.people.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join("")}`;
    person.value = state.procurementFilters.personId;
  }
}

function renderProcurementWorkspace() {
  document.querySelectorAll("#procurementTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.procurementTab);
  });
  const target = document.querySelector("#procurementWorkspace");
  if (!target) return;
  if (state.procurementTab === "pendingInbound") return renderPendingInboundWorkspace(target);
  if (state.procurementTab === "inboundRecords") return renderInboundRecordsWorkspace(target);
  return renderPurchaseOrdersWorkspace(target);
}

function renderPurchaseOrdersWorkspace(target) {
  const rows = state.purchaseOrders || [];
  target.innerHTML = rows.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>采购单号</th><th>商品</th><th>创建时间</th><th>创建人</th><th>种类</th><th>总数量</th><th>总金额</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td><strong>${escape(row.order_no)}</strong></td>
      <td>${purchaseOrderGoodsCell(row)}</td>
      <td>${date(row.created_at)}</td>
      <td>${escape(row.creator_name || "")}</td>
      <td>${escape(row.item_count || 0)}</td>
      <td>${escape(row.total_quantity || 0)}</td>
      <td>${money(row.total_amount)}</td>
      <td>${tag(purchaseOrderStatusName(row.status), purchaseOrderStatusColor(row.status))}</td>
      <td class="action-row"><button class="linklike po-detail-btn" data-id="${row.id}">查看详情</button><button class="linklike po-confirm-btn" data-id="${row.id}" ${row.status === "pending_purchase" ? "" : "disabled"}>确认已采购</button><button class="linklike danger po-cancel-btn" data-id="${row.id}" ${["inbound_done", "cancelled"].includes(row.status) ? "disabled" : ""}>取消采购单</button></td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="empty">暂无采购单，请先在需求池合并生成采购单</div>`;
}

function purchaseOrderGoodsCell(row) {
  const names = String(row.product_names || "").split("||").filter(Boolean);
  const images = String(row.product_image_urls || "").split("||");
  if (!names.length) return tag("暂无商品", "amber");
  const preview = names.slice(0, 3).map((name, index) => `<span class="po-goods-chip">${image(images[index])}<b>${escape(name)}</b></span>`).join("");
  const more = names.length > 3 ? `<small>另 ${escape(names.length - 3)} 种商品</small>` : "";
  return `<div class="po-goods-list">${preview}${more}</div>`;
}

function renderPendingInboundWorkspace(target) {
  const rows = state.pendingInbound || [];
  target.innerHTML = rows.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>产品</th><th>采购单号</th><th>应到</th><th>已入库</th><th>剩余</th><th>质检</th><th>备注</th><th>操作</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td><div class="outbound-product">${image(row.product_image_url)}<span><strong>${escape(row.product_name)}</strong><small>${escape(row.product_code)} / ${escape(row.mapped_skus || "无 SKU")}</small></span></div></td>
      <td>${escape(row.order_no)}</td>
      <td>${escape(row.actual_quantity || row.expected_quantity || 0)}</td>
      <td>${escape(row.inbound_quantity || 0)}</td>
      <td>${escape(row.remaining_quantity || row.expected_quantity || 0)}</td>
      <td>${tag(qcStatusName(row.qc_status), row.qc_status === "exception" ? "red" : "amber")}</td>
      <td>${escape(row.inbound_note || "")}</td>
      <td><button class="linklike confirm-inbound-btn" data-id="${row.inbound_record_id}">确认入库</button></td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="empty">暂无待入库商品</div>`;
}

function renderInboundRecordsWorkspace(target) {
  const rows = (state.inboundRecords || []).filter((row) => row.status === "approved");
  target.innerHTML = rows.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>入库时间</th><th>产品</th><th>采购单号</th><th>数量</th><th>货款</th><th>运费</th><th>均摊</th><th>操作人</th><th>质检</th><th>备注</th><th>操作</th></tr></thead>
    <tbody>${rows.map((row) => `<tr>
      <td>${date(row.approved_at || row.created_at)}</td>
      <td><div class="outbound-product">${image(row.product_image_url)}<span><strong>${escape(row.product_name)}</strong><small>${escape(row.product_code || "")}</small></span></div></td>
      <td>${escape(row.purchase_order_no || "-")}</td>
      <td>${escape(row.quantity)}</td>
      <td>${money(row.amount)}</td>
      <td>${money(row.shipping_amount)}</td>
      <td>${money(row.unit_cost)}</td>
      <td>${escape(row.person_name || "")}</td>
      <td>${tag(qcStatusName(row.qc_status), row.qc_status === "exception" ? "red" : "green")}</td>
      <td>${escape(row.note || "")}</td>
      <td class="action-row"><button class="linklike edit-inbound-record-btn" data-id="${row.id}">编辑</button><button class="linklike danger delete-inbound-record-btn" data-id="${row.id}">删除</button></td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="empty">暂无入库记录</div>`;
}

async function mergeSelectedProcurementRequests() {
  const ids = [...state.procurementSelectedRequestIds];
  if (!ids.length) { alert("请先勾选采购需求"); return; }
  await api("/api/procurement/purchase-orders", {
    method: "POST",
    body: JSON.stringify({ request_ids: ids, person_id: state.currentUserId })
  });
  state.procurementSelectedRequestIds.clear();
  state.procurementTab = "orders";
  await loadAll();
}

async function openPurchaseOrderDrawer(id) {
  const detail = await api(`/api/procurement/purchase-orders/${id}`);
  const drawer = document.querySelector("#purchaseOrderDrawer");
  const body = document.querySelector("#purchaseOrderDrawerBody");
  if (!drawer || !body) return;
  body.innerHTML = `
    <section class="drawer-section"><strong>${escape(detail.order.order_no)}</strong>${tag(purchaseOrderStatusName(detail.order.status), purchaseOrderStatusColor(detail.order.status))}<small>创建：${date(detail.order.created_at)} / 创建人：${escape(detail.order.creator_name || "")}</small><small>总数量 ${escape(detail.order.total_quantity)} / 总金额 ${money(detail.order.total_amount)}</small></section>
    <section class="drawer-section"><h3>商品明细</h3>${detail.items.map((item) => `<div class="drawer-row">${image(item.product_image_url)}<span><strong>${escape(item.product_name)}</strong><small>${escape(item.product_code)} / ${escape(item.mapped_skus || "无 SKU")}</small><small>来源 ${escape(item.requested_quantity)} / 实采 ${escape(item.actual_quantity)} / 已入库 ${escape(item.inbound_quantity)}</small><small>货款 ${money(item.amount)} / 运费 ${money(item.shipping_amount)} / 均摊 ${money(item.unit_cost)} / ${link(item.purchase_url)}</small></span></div>`).join("")}</section>
    <section class="drawer-section"><h3>来源需求</h3>${detail.requests.map((r) => `<p>${escape(r.person_name || "")} 申请 ${escape(r.quantity)} 件：货款 ${money(r.amount)} / 运费 ${money(r.shipping_amount)} ${escape(r.note || "")} <small>${date(r.created_at)}</small></p>`).join("")}</section>
  `;
  drawer.style.display = "";
  drawer.classList.add("visible");
}

function closePurchaseOrderDrawer() {
  const drawer = document.querySelector("#purchaseOrderDrawer");
  if (!drawer) return;
  drawer.classList.remove("visible");
  drawer.style.display = "none";
}

async function confirmPurchaseOrderAction(id) {
  const detail = await api(`/api/procurement/purchase-orders/${id}`);
  const ok = confirm(`确认已采购「${detail.order.order_no}」吗？\n系统会生成待入库记录，并增加产品即将入库数量。`);
  if (!ok) return;
  await api(`/api/procurement/purchase-orders/${id}/confirm-purchased`, {
    method: "POST",
    body: JSON.stringify({ person_id: state.currentUserId })
  });
  state.procurementTab = "pendingInbound";
  await loadAll();
}

async function confirmInboundRecordAction(id) {
  const record = state.pendingInbound.find((item) => Number(item.inbound_record_id) === Number(id));
  if (!record) return;
  const qty = Number(prompt(`本次入库数量（剩余 ${record.remaining_quantity || record.expected_quantity}）`, String(record.remaining_quantity || record.expected_quantity || 1)) || 0);
  if (!qty) return;
  const qc = confirm("质检是否通过？点击“确定”为通过，点击“取消”为异常。") ? "passed" : "exception";
  const note = prompt("入库备注", record.inbound_note || "") || "";
  const expectedQty = Number(record.expected_quantity || record.actual_quantity || qty || 1);
  const ratio = expectedQty ? qty / expectedQty : 1;
  const amount = Number(record.amount || 0) * ratio;
  const shippingAmount = Number(record.shipping_amount || 0) * ratio;
  await api(`/api/inbound-records/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      product_id: record.product_id,
      person_id: state.currentUserId,
      quantity: qty,
      amount,
      shipping_amount: shippingAmount,
      purchase_url: record.purchase_url || "",
      status: "approved",
      qc_status: qc,
      note
    })
  });
  await loadAll();
}

async function editInboundRecordAction(id) {
  const record = state.inboundRecords.find((item) => Number(item.id) === Number(id));
  if (!record) return;
  const quantity = promptNumber("入库数量", record.quantity);
  if (quantity == null) return;
  const amount = promptNumber("采购总金额（不含运费）", record.amount);
  if (amount == null) return;
  const shippingAmount = promptNumber("采购总运费", record.shipping_amount || 0);
  if (shippingAmount == null) return;
  const qc = prompt("质检状态：passed / exception / pending", record.qc_status || "passed") || record.qc_status || "passed";
  const note = prompt("入库备注", record.note || "") ?? record.note ?? "";
  await api(`/api/inbound-records/${record.id}`, {
    method: "PUT",
    body: JSON.stringify({
      product_id: record.product_id,
      person_id: record.person_id || state.currentUserId,
      quantity,
      amount,
      shipping_amount: shippingAmount,
      purchase_url: record.purchase_url || "",
      status: record.status,
      qc_status: qc,
      note
    })
  });
  await loadAll();
}

async function deleteInboundRecordAction(id) {
  const record = state.inboundRecords.find((item) => Number(item.id) === Number(id));
  if (!record) return;
  const ok = confirm(`确认删除「${record.product_name || ""}」这条入库记录吗？\n如果已经入库，系统会同步撤销对应库存流水。`);
  if (!ok) return;
  await api(`/api/inbound-records/${record.id}`, { method: "DELETE" });
  await loadAll();
}

function promptNumber(label, value) {
  const raw = prompt(label, String(value ?? 0));
  if (raw == null) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    alert(`${label} 需要填写大于等于 0 的数字`);
    return null;
  }
  return number;
}

function bindInboundActions() {
  document.querySelectorAll(".approve-inbound-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const record = state.inboundRecords.find((item) => Number(item.id) === Number(button.dataset.id));
      if (!record) return;
      if (!confirm(`确认「${record.product_name}」到货验收通过并加入库存吗？`)) return;
      await api(`/api/inbound-records/${record.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...record, status: "approved" })
      });
      await loadAll();
    });
  });
}

function renderInboundAlert() {
  const target = document.querySelector("#inboundAlert");
  if (!target) return;
  const overdue = state.inboundRecords.filter((record) => record.status === "pending_arrival" && inboundWaitDays(record) > 2);
  if (!overdue.length) {
    target.innerHTML = "";
    return;
  }
  const totalQuantity = overdue.reduce((sum, record) => sum + Number(record.quantity || 0), 0);
  target.innerHTML = `
    <div class="inbound-alert">
      <strong>${overdue.length} 条入库记录等待验收已超过 2 天</strong>
      <span>合计 ${escape(totalQuantity)} 件，请尽快确认验收。</span>
    </div>
  `;
}

function inboundWaitDays(record) {
  if (!record?.created_at) return 0;
  const created = new Date(record.created_at);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
}

function renderOrdersTable() {
  syncOrderControls();
  const rows = filteredOrderRows();
  const totalPages = orderTotalPages();
  state.orderFilters.page = Math.min(Math.max(1, state.orderFilters.page), totalPages);
  const start = (state.orderFilters.page - 1) * state.orderFilters.pageSize;
  const pageRows = rows.slice(start, start + state.orderFilters.pageSize);
  renderTable("ordersTable", pageRows, [
    ["posting", "订单信息", (r) => orderInfoCell(r)],
    ["goods", "商品 / SKU", (r) => orderGoodsCell(r)],
    ["stock", "库存处理", (r) => orderStockCell(r)],
    ["amount", "金额/利润", (r) => orderProfitCell(r)],
    ["logistics", "物流", (r) => orderLogisticsCell(r)],
    ["time", "下单/备货", (r) => orderTimeCell(r)]
  ]);
  updateOrderPager(rows.length);
  bindOrderRowActions();
}

function syncOrderControls() {
  const shopSelect = document.querySelector("#orderShopFilter");
  if (shopSelect) {
    shopSelect.innerHTML = `<option value="all">全部店铺</option>${state.shops.map((shop) => `<option value="${shop.id}">${escape(shop.name)}</option>`).join("")}`;
    shopSelect.value = [...shopSelect.options].some((option) => option.value === state.orderFilters.shopId) ? state.orderFilters.shopId : "all";
  }
  renderOrderStatusTabs();
  const pageSize = document.querySelector("#orderPageSize");
  if (pageSize) pageSize.value = String(state.orderFilters.pageSize);
  const dateFrom = document.querySelector("#orderDateFrom");
  if (dateFrom) dateFrom.value = state.orderFilters.dateFrom;
  const dateTo = document.querySelector("#orderDateTo");
  if (dateTo) dateTo.value = state.orderFilters.dateTo;
}

function filteredOrderRows() {
  return state.orders.filter((row) => {
    const shopOk = orderMatchesShop(row);
    const statusOk = orderMatchesStatus(row, state.orderFilters.status);
    const dateOk = orderMatchesDate(row);
    return shopOk && statusOk && dateOk;
  });
}

function renderOrderStatusTabs() {
  const target = document.querySelector("#orderStatusButtons");
  if (!target) return;
  const counts = orderStatusCounts();
  target.innerHTML = `<span class="order-date-summary">${escape(orderDateRangeLabel())}</span>` + orderStatusTabs.map(([status, label]) => `
    <button type="button" data-status="${escape(status)}" class="${status === state.orderFilters.status ? "active" : ""}">
      <span>${escape(label)}</span>
      <b>${escape(counts[status] || 0)}</b>
    </button>
  `).join("");
}

function orderStatusCounts() {
  const shopRows = state.orders.filter((row) => orderMatchesShop(row) && orderMatchesDate(row));
  const counts = Object.fromEntries(orderStatusTabs.map(([status]) => [status, 0]));
  counts.all = shopRows.length;
  for (const row of shopRows) {
    for (const [status] of orderStatusTabs) {
      if (status !== "all" && orderMatchesStatus(row, status)) counts[status] += 1;
    }
  }
  return counts;
}

function orderMatchesShop(row) {
  return state.orderFilters.shopId === "all" || String(row.shop_id) === String(state.orderFilters.shopId);
}

function orderMatchesDate(row) {
  const value = String(row.ordered_at || row.created_at || "").slice(0, 10);
  if (!value) return false;
  if (state.orderFilters.dateFrom && value < state.orderFilters.dateFrom) return false;
  if (state.orderFilters.dateTo && value > state.orderFilters.dateTo) return false;
  return true;
}

function orderMatchesStatus(row, status) {
  if (status === "all") return true;
  const workbench = orderWorkbenchState(row);
  if (["unbound", "stock_issue", "outbound_ready"].includes(status)) return workbench.key === status;
  if (status === "overdue") return orderIsOverdue(row);
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (status === "cancelled") return values.some((value) => value.includes("cancel"));
  if (status === "delivered") return values.some((value) => value === "delivered" || value === "posting_delivered" || value === "posting_received");
  if (status === "delivering") return values.some((value) => value === "delivering" || value.includes("transferring") || value.includes("carriage") || value.includes("pickup") || value.includes("sorting") || value.includes("customs"));
  return values.includes(status);
}

function orderTotalPages() {
  return Math.max(1, Math.ceil(filteredOrderRows().length / state.orderFilters.pageSize));
}

function updateOrderPager(total) {
  const pageInfo = document.querySelector("#orderPageInfo");
  const prev = document.querySelector("#orderPrevPage");
  const next = document.querySelector("#orderNextPage");
  const totalPages = Math.max(1, Math.ceil(total / state.orderFilters.pageSize));
  if (pageInfo) pageInfo.textContent = `第 ${state.orderFilters.page} / ${totalPages} 页，共 ${total} 条`;
  if (prev) prev.disabled = state.orderFilters.page <= 1;
  if (next) next.disabled = state.orderFilters.page >= totalPages;
}

function orderGoodsCell(row) {
  const imageUrl = String(row.image_urls || "").split(",").find(Boolean);
  const name = cleanOrderProductName(row.product_names);
  const code = cleanOrderProductCode(row.product_codes);
  return `<div class="order-goods">${image(imageUrl)}<div>${strong(name, code)}${orderQuantitySummary(row)}</div></div>`;
}

function orderInfoCell(row) {
  const overdue = orderIsOverdue(row) ? tag("超时发货", "red") : "";
  return `<div class="order-info-cell">
    ${orderPostingLink(row)}
    <small>${escape(row.shop_name || "-")}</small>
    <span class="order-state-line">${overdue}${tag(orderStatusLabel(row.tracking_stage || row.status), statusColor(row.status))}</span>
  </div>`;
}

function orderQuantitySummary(row) {
  const total = Number(row.total_quantity || row.item_count || 0);
  const itemCount = Number(row.item_count || 0);
  const quantityText = total > itemCount
    ? `<small class="order-quantity-alert">共 <b>${escape(total)}</b> 件，${escape(itemCount)} 个明细</small>`
    : `<small>${escape(itemCount)} 件商品</small>`;
  return quantityText;
}

function cleanOrderProductName(value) {
  const text = String(value || "").trim();
  if (!text || text === "Unbound product" || text.includes("未绑定")) return "商品待绑定";
  return text;
}

function cleanOrderProductCode(value) {
  const text = String(value || "").trim();
  if (!text || text === "UNBOUND" || text.includes("未绑定")) return "";
  return text;
}

function orderSkuQuantities(row) {
  const result = {};
  String(row.sku_quantities || "").split("||").forEach((entry) => {
    const index = entry.lastIndexOf(":");
    if (index <= 0) return;
    const sku = entry.slice(0, index);
    result[sku] = (result[sku] || 0) + Number(entry.slice(index + 1) || 0);
  });
  return result;
}

function findOnlineForOrderSku(row, sku) {
  return state.onlineProducts.find((item) => (
    String(item.shop_id) === String(row.shop_id) &&
    String(item.ozon_sku || "").trim() === String(sku || "").trim()
  ));
}

function orderSkuStockRows(row) {
  const quantities = orderSkuQuantities(row);
  const skus = String(row.skus || "").split(",").map((item) => item.trim()).filter(Boolean);
  return skus.map((sku) => {
    const qty = Math.max(1, Number(quantities[sku] || 1));
    const online = findOnlineForOrderSku(row, sku);
    const product = online?.product_id ? state.products.find((item) => String(item.id) === String(online.product_id)) : null;
    const stock = Number(product?.stock || 0);
    const processed = orderSkuProcessed(row, sku, product);
    const shortage = product && !processed ? Math.max(0, qty - stock) : 0;
    return { sku, qty, online, product, stock, shortage, processed };
  });
}

function orderSkuProcessed(row, sku, product) {
  if (!product) return false;
  const posting = String(row.posting_number || "");
  return state.outboundRecords.some((record) => (
    String(record.order_ref || "") === posting &&
    String(record.ozon_sku || "").trim() === String(sku || "").trim() &&
    String(record.product_id || "") === String(product.id) &&
    !String(record.status || "").toLowerCase().includes("cancel")
  ));
}

function orderWorkbenchState(row) {
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (values.some((value) => value.includes("cancel"))) return { key: "cancelled", label: "已取消", color: "red" };
  if (orderMatchesDeliveredValues(values)) return { key: "delivered", label: "已签收", color: "green" };
  if (orderMatchesDeliveringValues(values)) return { key: "delivering", label: "运输中", color: "blue" };
  const items = orderSkuStockRows(row);
  if (!items.length || items.some((item) => !item.product)) return { key: "unbound", label: "待绑定 SKU", color: "amber" };
  if (items.some((item) => item.shortage > 0)) return { key: "stock_issue", label: "库存不足", color: "red" };
  return { key: "outbound_ready", label: "可出库/已处理", color: "green" };
}

function orderIsOverdue(row) {
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (values.some((value) => value.includes("cancel")) || orderMatchesDeliveredValues(values) || orderMatchesDeliveringValues(values) || orderIsShipped(row)) return false;
  const days = Number(row.ship_days_remaining);
  if (Number.isFinite(days)) return days < 0;
  const deadline = String(row.shipment_deadline_at || "").slice(0, 10);
  return Boolean(deadline && deadline < todayInputValue());
}

function orderStockCell(row) {
  const items = orderSkuStockRows(row);
  if (!items.length) return tag("无 SKU 明细", "amber");
  return `<div class="order-stock-list">${items.map((item) => {
    if (!item.product) {
      const action = item.online
        ? `<span class="order-stock-actions"><button class="mini-action blue order-bind-product-btn" data-online-id="${item.online.id}">去绑定</button><button class="mini-action green order-create-product-btn" data-online-id="${item.online.id}" data-order-id="${row.id}" data-sku="${escape(item.sku)}">创建库存</button></span>`
        : tag("未同步在线 SKU", "amber");
      return `<div class="order-stock-item pending"><b>${escape(item.sku)}</b><small>订单 ${escape(item.qty)} 件</small>${action}</div>`;
    }
    const label = item.product.inventory_id || item.product.code || item.product.selection_id || `ID ${item.product.id}`;
    const status = item.processed ? tag("已扣库存", "green") : item.shortage > 0 ? tag(`缺 ${item.shortage} 件`, "red") : tag("库存可用", "green");
    const stockText = item.processed ? `订单 ${item.qty} 件 / 已生成出库` : `订单 ${item.qty} 件 / 库存 ${item.stock} 件`;
    return `<div class="order-stock-item ${item.shortage > 0 ? "danger" : ""}">
      <b>${escape(item.sku)}</b>
      <small>${escape(stockText)}</small>
      <button class="mini-action stock-jump-btn" data-product-id="${item.product.id}">${escape(label)}</button>
      ${status}
    </div>`;
  }).join("")}</div>`;
}

function orderMatchesDeliveredValues(values) {
  return values.some((value) => value === "delivered" || value === "posting_delivered" || value === "posting_received");
}

function orderMatchesDeliveringValues(values) {
  return values.some((value) => value === "delivering" || value.includes("transferring") || value.includes("carriage") || value.includes("pickup") || value.includes("sorting") || value.includes("customs"));
}

function bindOrderRowActions() {
  const target = document.querySelector("#ordersTable");
  if (!target) return;
  target.querySelectorAll(".order-bind-product-btn").forEach((button) => {
    button.addEventListener("click", () => openBindDialog(Number(button.dataset.onlineId)));
  });
  target.querySelectorAll(".order-create-product-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const order = state.orders.find((item) => String(item.id) === String(button.dataset.orderId));
      openProductCreateDialog(Number(button.dataset.onlineId), { order, sku: button.dataset.sku });
    });
  });
  target.querySelectorAll(".stock-jump-btn").forEach((button) => {
    button.addEventListener("click", () => jumpToStockProduct(Number(button.dataset.productId)));
  });
}

function jumpToStockProduct(productId) {
  state.stockHighlightProductId = productId;
  showView("stock");
  window.setTimeout(() => {
    const row = document.querySelector(`#stockTable tr[data-row-id="${productId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("row-flash");
    window.setTimeout(() => row.classList.remove("row-flash"), 1800);
  }, 50);
}

function orderPostingLink(row) {
  const postingNumber = row.posting_number || "";
  const encodedPosting = encodeURIComponent(postingNumber);
  const detailUrl = `https://seller.ozon.ru/app/fbs/postings/${encodedPosting}`;
  return `<div class="order-posting"><a href="${escape(detailUrl)}" target="_blank" rel="noreferrer">${formatPostingNumber(postingNumber)}</a></div>`;
}

function formatPostingNumber(value) {
  const text = String(value || "");
  const match = text.match(/^([^-]+)(-\d+)(-\d+)$/);
  if (!match) return `<span>${escape(text)}</span>`;
  const first = match[1];
  const head = first.slice(0, -4);
  const tail = first.slice(-4);
  return `
    <span class="posting-main">${escape(head)}<strong class="posting-hot">${escape(tail)}</strong></span>
    <span>${escape(match[2])}</span>
    <span>${escape(match[3])}</span>
  `;
}

function orderLogisticsCell(row) {
  const warehouse = compactWarehouse(row.warehouse_name);
  const channel = row.logistics_channel || row.delivery_method_name || row.tracking_number || "-";
  const mode = logisticsMode(row);
  return `<div class="order-logistics">
    <span class="logistics-tags">${tag(mode.label, mode.color)}${tag(row.delivery_schema || "FBS 自发货", "blue")}</span>
    <small>${escape(warehouse || "未返回仓库")}</small>
    <small>${escape(channel)}</small>
  </div>`;
}

function orderTimeCell(row) {
  return `${strong(date(row.ordered_at), `截止：${date(row.shipment_deadline_at) || "按 2 天备货"}`)}${shipDeadlineTag(row)}`;
}

function shipDeadlineTag(row) {
  if (["delivered", "cancelled", "canceled"].includes(String(row.status || "").toLowerCase())) return tag("已结束", "green");
  if (orderIsShipped(row)) return tag("产品已发运", "blue");
  const days = Number(row.ship_days_remaining);
  if (!Number.isFinite(days)) return tag("未返回时效", "amber");
  if (days < 0) return tag(`已超时 ${Math.abs(days)} 天`, "red");
  if (days === 0) return tag("今天截止", "red");
  if (days <= 1) return tag(`剩 ${days} 天`, "amber");
  return tag(`剩 ${days} 天`, "green");
}

function logisticsMode(row) {
  const warehouse = String(row.warehouse_name || "").toLowerCase();
  const method = String(row.delivery_method_name || "").toLowerCase();
  const combined = `${warehouse} ${method}`;
  if (combined.includes("风船") || combined.includes("風船") || combined.includes("fbp")) {
    return { label: "FBP", color: "purple" };
  }
  if (combined.includes("cl")) {
    return { label: "FBS", color: "green" };
  }
  return { label: "FBS", color: "blue" };
}

function orderIsShipped(row) {
  const values = [row.status, row.tracking_stage, row.logistics_status, row.delivery_method_name, row.logistics_channel]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  if (values.includes("awaiting_packaging") || values.includes("awaiting_deliver") || values.includes("pending_stock")) return false;
  return ["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "posting_in_carriage", "posting_transferring", "发往", "已上网", "发走"]
    .some((keyword) => values.includes(keyword));
}

function compactWarehouse(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.replace(/（.*?）/g, "").replace(/\(.*?\)/g, "").trim();
}

function orderProfitCell(row) {
  const unmapped = String(row.product_codes || "").includes("未绑定");
  const profit = Number(row.estimated_profit || 0);
  const actual = Number(row.actual_profit || 0);
  const profitLabel = actual ? `实际利润：${num(actual, 2)}` : `预估利润：${num(profit, 2)}`;
  const hint = unmapped ? "SKU 未绑定产品，暂不能按成本估算" : profitLabel;
  const profitClass = (actual || profit) < 0 ? "loss" : "";
  return `${money(row.revenue)}<small>${escape(hint)}</small>${!unmapped ? `<span class="money ${profitClass}">${num(actual || profit, 2)}</span>` : ""}`;
}

function statusColor(value) {
  if (String(value).includes("cancel")) return "red";
  if (String(value).includes("deliver")) return "green";
  return "amber";
}

function orderStatusLabel(value) {
  const map = {
    awaiting_registration: "等待注册",
    acceptance_in_progress: "验收中",
    awaiting_approve: "等待确认",
    awaiting_packaging: "等待打包",
    awaiting_deliver: "等待备货/发货",
    arbitration: "争议处理中",
    client_arbitration: "买家争议处理中",
    delivering: "运输中",
    driver_pickup: "等待司机取件",
    delivered: "已签收",
    cancelled: "已取消",
    not_accepted: "未被接收",
    sent_by_seller: "卖家已发出",
    posting_created: "订单已创建",
    posting_registered: "订单已注册",
    posting_awaiting_registration: "等待订单注册",
    posting_acceptance_in_progress: "订单验收中",
    posting_transferring_to_delivery: "转交配送中",
    posting_in_carriage: "运输交接中",
    posting_not_in_carriage: "未进入运输",
    posting_on_way_to_city: "发往买家城市",
    posting_on_way_to_pickup_point: "发往自提点",
    posting_in_pickup_point: "已到自提点",
    posting_received: "买家已收到",
    posting_delivered: "已签收",
    posting_canceled: "订单已取消",
    posting_canceled_by_customer: "买家取消",
    posting_canceled_by_seller: "卖家取消",
    posting_in_client_arbitration: "买家争议处理中",
    posting_returned_to_seller: "已退回卖家",
    posting_return_in_transit: "退货运输中",
    posting_in_warehouse: "已到仓库",
    posting_ready_for_pickup: "可取件",
    posting_transferred_to_courier_service: "已交给承运商",
    posting_in_sorting_center: "分拣中心处理中",
    posting_sent_to_sorting_center: "发往分拣中心",
    posting_left_sorting_center: "离开分拣中心",
    posting_customs_clearance: "清关中",
    customs: "清关中"
  };
  if (!value) return "";
  return map[value] || statusLabel(value) || `未知节点：${value}`;
}

function onlineSkuCell(row) {
  const productId = row.ozon_product_id ? `<small>Product ID：${escape(row.ozon_product_id)}</small>` : "";
  return `<strong class="sku-code">${escape(row.ozon_sku || "")}</strong>${productId}`;
}

function onlineImageCell(row) {
  const src = row.primary_image || row.image_url || firstJsonItem(row.images_json);
  return src ? `<img class="online-thumb" src="${escape(src)}" alt="${escape(row.name || "")}">` : `<div class="online-thumb placeholder"></div>`;
}

function onlineProductCell(row) {
  const ozonUrl = row.ozon_product_id ? `https://www.ozon.ru/product/${encodeURIComponent(row.ozon_product_id)}/` : "";
  const title = ozonUrl
    ? `<a class="online-title" href="${escape(ozonUrl)}" target="_blank" rel="noreferrer">${escape(row.name || "")}</a>`
    : `<strong class="online-title">${escape(row.name || "")}</strong>`;
  const bound = row.product_name ? `<span class="tag green">已绑定：${escape(row.product_code || "")} ${escape(row.product_name || "")}</span>` : `<span class="tag amber">未绑定库存产品</span>`;
  return `${title}<div class="online-meta">Offer ID：${escape(row.offer_id || "-")}</div><div class="online-tags">${bound}</div>`;
}

function onlineShopCell(row) {
  const statusColor = row.status === "online" ? "green" : row.status === "archived" || row.archived ? "red" : "amber";
  const visibility = row.visibility ? `<small>可见性：${escape(row.visibility)}</small>` : "";
  return `<strong>${escape(row.shop_name || "")}</strong><small>${escape(statusLabel(row.status))}</small>${visibility}${tag(row.product_id ? "已映射" : "待映射", row.product_id ? "green" : "amber")}`;
}

function onlinePriceCell(row) {
  const currency = row.currency_code || "RUB";
  const current = `<strong class="money">${num(row.sale_price, 2)} ${escape(currency)}</strong>`;
  const marketing = Number(row.marketing_price || 0) && Number(row.marketing_price || 0) !== Number(row.sale_price || 0)
    ? `<small>营销价：${num(row.marketing_price, 2)} ${escape(currency)}</small>`
    : "";
  const old = Number(row.old_price || 0) ? `<small>划线价：${num(row.old_price, 2)} ${escape(currency)}</small>` : "";
  return `${current}${marketing}${old}`;
}

function onlineExtraCell(row) {
  const barcodes = parseJson(row.barcodes_json);
  const stocks = parseJson(row.stocks_json);
  const images = parseJson(row.images_json);
  const commissions = parseJson(row.commissions_json);
  const attrs = parseJson(row.attributes_json) || {};
  const pieces = [
    `图片 ${Array.isArray(images) ? images.length : 0} 张`,
    `条码 ${Array.isArray(barcodes) ? barcodes.length : barcodes ? 1 : 0} 个`,
    stockSummary(stocks),
    commissionSummary(commissions)
  ].filter(Boolean);
  const size = dimensionSummary(attrs);
  return `<div class="online-extra">${pieces.map((item) => `<span>${escape(item)}</span>`).join("")}</div>${size ? `<small>${escape(size)}</small>` : ""}<small>同步：${escape(date(row.synced_at) || "-")}</small>`;
}

function openBindDialog(onlineId) {
  const online = state.onlineProducts.find((item) => item.id === Number(onlineId));
  const dialog = document.querySelector("#bindOnlineDialog");
  if (!online || !dialog) return;
  state.bindTargetOnlineId = online.id;
  document.querySelector("#bindDialogOnlineId").value = online.id;
  document.querySelector("#bindDialogProductId").value = "";
  document.querySelector("#bindSelectedOnline").innerHTML = `
    ${onlineImageCell(online)}
    <div>
      <strong>${escape(online.ozon_sku || "")}</strong>
      <small>${escape(online.shop_name || "")} / Offer ID：${escape(online.offer_id || "-")}</small>
      <span>${escape(online.name || "")}</span>
    </div>
  `;
  document.querySelector("#bindProductSearch").value = "";
  fillPeople("bindDialogPerson");
  const person = document.querySelector("#bindDialogPerson");
  if (person && [...person.options].some((item) => item.value === String(state.currentUserId))) person.value = state.currentUserId;
  renderBindProductOptions();
  dialog.classList.add("visible");
  const backdrop = document.createElement("div");
  backdrop.className = "edit-dialog-backdrop bind-dialog-backdrop";
  backdrop.addEventListener("click", closeBindDialog);
  document.body.appendChild(backdrop);
  document.querySelector("#bindProductSearch")?.focus();
}

function closeBindDialog() {
  const dialog = document.querySelector("#bindOnlineDialog");
  if (dialog) dialog.classList.remove("visible");
  document.querySelector(".bind-dialog-backdrop")?.remove();
  state.bindTargetOnlineId = null;
}

function renderBindProductOptions() {
  const target = document.querySelector("#bindDialogProduct");
  const input = document.querySelector("#bindDialogProductId");
  if (!target || !input) return;
  const query = normalizeSearch(document.querySelector("#bindProductSearch")?.value || "");
  const rows = state.products.filter((product) => {
    if (!query) return true;
    return normalizeSearch(`${product.id} ${product.inventory_id || ""} ${product.code || ""} ${product.selection_id || ""} ${product.name || ""}`).includes(query);
  }).slice(0, 80);
  target.innerHTML = rows.length ? rows.map((product) => `
    <button class="product-pick ${String(input.value) === String(product.id) ? "active" : ""}" type="button" data-id="${product.id}">
      ${image(product.image_url)}
      <span>
        <strong>${escape(product.inventory_id || product.code || product.selection_id || "")}</strong>
        <small>内部ID：${escape(product.id)} / 创建：${escape(date(product.created_at) || "-")}</small>
        <b>${escape(product.name || "")}</b>
        <small>库存 ${escape(product.stock ?? 0)} / 已绑定 SKU ${escape(product.sku_count ?? 0)} 个</small>
      </span>
    </button>
  `).join("") : `<div class="empty">没有匹配的产品</div>`;
  target.querySelectorAll(".product-pick").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.id;
      target.querySelectorAll(".product-pick").forEach((item) => item.classList.toggle("active", item === button));
    });
  });
  if (rows.length && !input.value) input.value = rows[0].id;
}

function renderProcProductOptions() {
  const target = document.querySelector("#procProductOptions");
  const input = document.querySelector("#procProduct");
  if (!target || !input) return;
  const query = normalizeSearch(document.querySelector("#procProductSearch")?.value || "");
  const rows = state.products.filter((product) => {
    if (!query) return true;
    return normalizeSearch(productProcurementSearchText(product)).includes(query);
  }).slice(0, 80);
  if (rows.length && !input.value) input.value = rows[0].id;
  target.innerHTML = rows.length ? rows.map((product) => `
    <button class="proc-product-option ${String(input.value) === String(product.id) ? "active" : ""}" type="button" data-id="${product.id}">
      ${image(product.image_url)}
      <span>
        <strong>${escape(product.name || "")}</strong>
        <small>${escape(product.inventory_id || product.code || product.selection_id || "")} / 库存 ${escape(product.stock ?? 0)} / 即将入库 ${escape(product.incoming_stock ?? 0)}</small>
        ${skuList(product.mapped_skus)}
      </span>
    </button>
  `).join("") : `<div class="empty">没有匹配的产品</div>`;
  target.querySelectorAll(".proc-product-option").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.id;
      renderProcProductOptions();
      updateProcProductPreview();
    });
  });
}

function updateProcProductPreview() {
  const select = document.querySelector("#procProduct");
  if (!select) return;
  const product = state.products.find((item) => String(item.id) === String(select.value));
  if (!product) return;
  const url = document.querySelector("#procPurchaseUrl");
  if (url) url.value = product.purchase_url || "";
}

function openProductCreateDialog(onlineId = null, context = {}) {
  const dialog = document.querySelector("#productCreateDialog");
  const form = document.querySelector("#productCreateForm");
  if (!dialog || !form) return;
  form.reset();
  form.dataset.createProcurementRequest = "0";
  normalizeCreateStockPurchaseFields(form);
  form.elements.owner_person_id.value = state.currentUserId;
  form.elements.person_id.value = state.currentUserId;
  form.elements.source_platform.value = "1688";
  form.elements.shipping_method.value = "air_land";
  form.elements.exchange_rate.value = currentExchangeRate();
  form.elements.desired_profit_value.value = "20";
  form.elements.return_rate.value = "0.05";
  form.elements.purchase_quantity.value = "1";
  form.elements.length_cm.value = "30";
  form.elements.width_cm.value = "20";
  form.elements.height_cm.value = "10";
  form.elements.air_sale_price_rmb.value = "0";
  form.elements.package_weight_g.value = "0";
  const source = document.querySelector("#createOnlineSource");
  source.style.display = "none";
  source.innerHTML = "";
  const summary = document.querySelector("#createStockSummary");
  if (summary) summary.innerHTML = createStockSummary();
  bindCreateStockSummaryInputs();
  const error = document.querySelector("#productCreateError");
  if (error) error.style.display = "none";
  document.querySelector("#productCreateTitle").textContent = "添加库存产品";
  if (onlineId) fillCreateDialogFromOnline(onlineId, context);
  syncCreateListingPrice();
  dialog.classList.add("visible");
  const backdrop = document.createElement("div");
  backdrop.className = "edit-dialog-backdrop create-product-backdrop";
  backdrop.addEventListener("click", closeProductCreateDialog);
  document.body.appendChild(backdrop);
  form.elements.name.focus();
}

function fillCreateDialogFromOnline(onlineId, context = {}) {
  const online = state.onlineProducts.find((item) => item.id === Number(onlineId));
  const form = document.querySelector("#productCreateForm");
  if (!online || !form) return;
  const attrs = parseJson(online.attributes_json) || {};
  form.dataset.createProcurementRequest = context.order ? "1" : "0";
  const imageUrl = online.primary_image || online.image_url || firstJsonItem(online.images_json);
  document.querySelector("#productCreateTitle").textContent = "从在线 SKU 创建库存产品";
  form.elements.online_product_id.value = online.id;
  form.elements.name.value = online.name || "";
  form.elements.image_url.value = imageUrl || "";
  form.elements.source_platform.value = "1688";
  form.elements.shipping_method.value = inferShippingMethodFromOnline(online);
  form.elements.supplier_note.value = `来自 Ozon SKU ${online.ozon_sku}${online.offer_id ? ` / Offer ${online.offer_id}` : ""}`;
  const orderPrice = orderSkuPrice(context.order, context.sku);
  const saleRmb = Number(orderPrice || 0) || Number(online.sale_price || 0);
  form.elements.air_sale_price_rmb.value = saleRmb.toFixed(2);
  form.elements.package_weight_g.value = inferOnlineWeightGrams(attrs);
  form.elements.length_cm.value = attrs.length || attrs.depth || 30;
  form.elements.width_cm.value = attrs.width || 20;
  form.elements.height_cm.value = attrs.height || 10;
  const summary = document.querySelector("#createStockSummary");
  if (summary) summary.innerHTML = createStockSummary(online, attrs, { ...context, saleRmb });
  bindCreateStockSummaryInputs();
  const source = document.querySelector("#createOnlineSource");
  source.style.display = "";
  source.innerHTML = `${onlineImageCell(online)}<div><strong>${escape(online.ozon_sku)}</strong><small>${escape(online.shop_name)} / ${escape(online.offer_id || "-")}</small><span>${escape(online.name || "")}</span></div>`;
}

function productProcurementSearchText(product) {
  const onlineIds = state.onlineProducts
    .filter((item) => String(item.product_id) === String(product.id))
    .map((item) => `${item.ozon_product_id || ""} ${item.ozon_sku || ""} ${item.offer_id || ""}`)
    .join(" ");
  return `${product.id} ${product.inventory_id || ""} ${product.code || ""} ${product.selection_id || ""} ${product.name || ""} ${product.mapped_skus || ""} ${onlineIds}`;
}

function normalizeCreateStockPurchaseFields(form) {
  const quantityLabel = form.elements.purchase_quantity?.closest("label");
  const amountLabel = form.elements.purchase_cost?.closest("label");
  const freightLabel = form.elements.domestic_shipping?.closest("label");
  if (quantityLabel) setLabelText(quantityLabel, "采购数量");
  if (amountLabel) setLabelText(amountLabel, "商品总货款(RMB)");
  if (freightLabel) setLabelText(freightLabel, "国内总运费(RMB)");
  if (quantityLabel && amountLabel) amountLabel.before(quantityLabel);
  if (freightLabel && amountLabel) amountLabel.after(freightLabel);
  if (form.elements.purchase_quantity) form.elements.purchase_quantity.value = form.elements.purchase_quantity.value || "1";
  if (form.elements.purchase_cost) form.elements.purchase_cost.placeholder = "商品货款总额";
  if (form.elements.domestic_shipping) form.elements.domestic_shipping.placeholder = "可填 0";
}

function setLabelText(label, text) {
  const node = [...label.childNodes].find((item) => item.nodeType === Node.TEXT_NODE);
  if (node) node.textContent = text;
}

function openProductCreateDialogFromOrder(order) {
  openProductCreateDialog();
  const form = document.querySelector("#productCreateForm");
  if (!form || !order) return;
  const names = String(order.product_names || "").split(",").map((item) => item.trim()).filter(Boolean);
  const images = String(order.image_urls || "").split(",").map((item) => item.trim()).filter(Boolean);
  const skus = String(order.skus || "").split(",").map((item) => item.trim()).filter(Boolean);
  form.elements.name.value = names[0] && names[0] !== "未绑定产品" ? names[0] : `订单 ${order.posting_number || order.order_number || ""} 商品`;
  form.elements.image_url.value = images[0] || "";
  form.elements.source_platform.value = "supplier";
  form.elements.supplier_note.value = `来自订单 ${order.posting_number || order.order_number || ""}${skus[0] ? ` / SKU ${skus[0]}` : ""}`;
  document.querySelector("#productCreateTitle").textContent = "从订单创建库存产品";
}

function closeProductCreateDialog() {
  document.querySelector("#productCreateDialog")?.classList.remove("visible");
  document.querySelector(".create-product-backdrop")?.remove();
}

function syncCreateListingPrice() {
  const form = document.querySelector("#productCreateForm");
  if (!form) return;
  const saleRmb = Number(form.elements.air_sale_price_rmb.value || 0);
  const exchangeRate = Number(form.elements.exchange_rate.value || currentExchangeRate());
  document.querySelector("#createListingPriceRub").value = saleRmb && exchangeRate ? (saleRmb * 2 * exchangeRate).toFixed(2) : "";
}

function createStockSummary(online = null, attrs = {}, context = {}) {
  const form = document.querySelector("#productCreateForm");
  const saleRmb = Number(context.saleRmb || 0) || Number(online?.sale_price || 0);
  const weight = online ? num(inferOnlineWeightGrams(attrs), 0) : Number(form?.elements.package_weight_g.value || 0);
  const length = online ? Number(attrs.length || attrs.depth || 30) : Number(form?.elements.length_cm.value || 30);
  const width = online ? Number(attrs.width || 20) : Number(form?.elements.width_cm.value || 20);
  const height = online ? Number(attrs.height || 10) : Number(form?.elements.height_cm.value || 10);
  const shipping = online ? inferShippingMethodFromOnline(online) : "air_land";
  return `
    <label><b>供货平台</b><select id="createSummarySource"><option value="1688">1688</option><option value="pdd">拼多多</option><option value="supplier">供应商</option></select></label>
    <label><b>配送方式</b><select id="createSummaryShipping"><option value="air_land">陆空</option><option value="land">陆运</option><option value="air">空运</option><option value="manual_review">人工判断</option></select></label>
    <label><b>订单售价(RMB)</b><input id="createSummarySale" type="number" step="0.01" value="${escape(num(saleRmb, 2))}" /></label>
    <label><b>重量(g)</b><input id="createSummaryWeight" type="number" step="1" value="${escape(weight)}" /></label>
    <label><b>长宽高(cm)</b><span class="size-inputs"><input id="createSummaryLength" type="number" step="0.1" value="${escape(length)}" /><input id="createSummaryWidth" type="number" step="0.1" value="${escape(width)}" /><input id="createSummaryHeight" type="number" step="0.1" value="${escape(height)}" /></span></label>
  `;
}

function bindCreateStockSummaryInputs() {
  const form = document.querySelector("#productCreateForm");
  if (!form) return;
  const pairs = [
    ["#createSummarySource", "source_platform"],
    ["#createSummaryShipping", "shipping_method"],
    ["#createSummarySale", "air_sale_price_rmb"],
    ["#createSummaryWeight", "package_weight_g"],
    ["#createSummaryLength", "length_cm"],
    ["#createSummaryWidth", "width_cm"],
    ["#createSummaryHeight", "height_cm"]
  ];
  for (const [selector, field] of pairs) {
    const control = document.querySelector(selector);
    if (!control || !form.elements[field]) continue;
    control.value = form.elements[field].value || control.value;
    form.elements[field].value = control.value;
    control.addEventListener("input", () => {
      form.elements[field].value = control.value;
      if (field === "air_sale_price_rmb") syncCreateListingPrice();
    });
    control.addEventListener("change", () => {
      form.elements[field].value = control.value;
      if (field === "air_sale_price_rmb") syncCreateListingPrice();
    });
  }
}

function orderSkuPrice(order, sku) {
  if (!order || !sku) return 0;
  let amount = 0;
  let quantity = 0;
  String(order.sku_prices || "").split("||").forEach((entry) => {
    const parts = entry.split(":");
    if (parts.length < 3 || parts[0] !== String(sku)) return;
    const price = Number(parts[1] || 0);
    const qty = Number(parts[2] || 1);
    amount += price * qty;
    quantity += qty;
  });
  return quantity ? amount / quantity : 0;
}

function inferShippingMethodFromOnline(online) {
  const attrs = parseJson(online?.attributes_json) || {};
  const text = `${online?.name || ""} ${online?.offer_id || ""} ${JSON.stringify(attrs)}`.toLowerCase();
  if (text.includes("land") || text.includes("陆运")) return "land";
  if (text.includes("air") || text.includes("空运")) return "air";
  return "air_land";
}

function inferOnlineWeightGrams(attrs) {
  const weight = Number(attrs.weight || 0);
  if (weight > 0) return String(attrs.weight_unit || "").toLowerCase().includes("kg") ? weight * 1000 : weight;
  return Number(attrs.volume_weight || 0) ? Number(attrs.volume_weight || 0) * 1000 : 0;
}

function statusLabel(value) {
  return { online: "在线", hidden: "隐藏", archived: "已归档" }[value] || value || "";
}

function firstJsonItem(value) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed[0] || "" : "";
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stockSummary(stocks) {
  const list = Array.isArray(stocks) ? stocks : Array.isArray(stocks?.stocks) ? stocks.stocks : stocks ? [stocks] : [];
  if (!list.length) return "";
  const total = list.reduce((sum, item) => sum + Number(item.present ?? item.stock ?? item.quantity ?? 0), 0);
  return `库存 ${total}`;
}

function commissionSummary(commissions) {
  const list = Array.isArray(commissions) ? commissions : [];
  const fbs = list.find((item) => item.sale_schema === "FBS");
  if (!fbs) return list.length ? `佣金 ${list.length} 组` : "";
  return `FBS佣金 ${num(fbs.percent, 0)}%`;
}

function dimensionSummary(attrs) {
  const weight = attrs.weight ? `${attrs.weight}${attrs.weight_unit || "g"}` : "";
  const dimensions = [attrs.length || attrs.depth, attrs.width, attrs.height].filter(Boolean).join("x");
  const volumeWeight = attrs.volume_weight ? `体积重：${attrs.volume_weight}` : "";
  if (weight && dimensions) return `重量/尺寸：${weight} / ${dimensions}${attrs.dimension_unit || ""}`;
  if (weight) return `重量：${weight}`;
  if (dimensions) return `尺寸：${dimensions}${attrs.dimension_unit || ""}`;
  if (volumeWeight) return volumeWeight;
  return "";
}

// 鈹€鈹€鈹€ 杈呭姪 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function fillSelects() {
  const nameEl = document.querySelector("#currentUserName");
  const logoutBtn = document.querySelector("#logoutBtn");
  const changePwdBtn = document.querySelector("#changePwdBtn");
  if (state.authToken && state.currentUser) {
    if (nameEl) nameEl.textContent = state.currentUser.name || state.currentUser.username || "已登录";
    if (logoutBtn) logoutBtn.style.display = "";
    if (changePwdBtn) changePwdBtn.style.display = "";
  } else {
    if (nameEl) nameEl.textContent = "未登录";
    if (logoutBtn) logoutBtn.style.display = "none";
    if (changePwdBtn) changePwdBtn.style.display = "none";
  }

  fillPeople("productOwner");
  fillPeople("procPerson");
  fillPeople("inPerson");
  fillPeople("bindPerson");
  fillProducts("procProduct");
  renderProcProductOptions();
  fillProducts("inProduct");
  fillProducts("bindProduct");
  document.querySelector("#bindOnline").innerHTML = state.onlineProducts.map((op) => `<option value="${op.id}">${escape(op.shop_name)} / ${escape(op.ozon_sku)} / ${escape(op.name)}</option>`).join("");
  setDefaults();
  updateProcProductPreview();
}

function setDefaults() {
  for (const id of ["productOwner", "procPerson", "inPerson", "bindPerson"]) {
    const el = document.querySelector(`#${id}`);
    if (!el) continue;
    if (el.type === "hidden") {
      el.value = state.currentUserId;
    } else if ([...el.options].some((item) => item.value === state.currentUserId)) {
      el.value = state.currentUserId;
    }
  }
  const owner = state.people.find((person) => String(person.id) === String(state.currentUserId));
  const ownerName = document.querySelector("#productOwnerName");
  if (ownerName) ownerName.textContent = owner?.name || "-";
  syncListingReferencePrice();
  updateRecommendation();
}

function fillPeople(id) {
  const el = document.querySelector(`#${id}`);
  if (!el) return;
  if (el.type === "hidden") {
    el.value = state.currentUserId;
    return;
  }
  el.innerHTML = state.people.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join("");
}

function fillProducts(id) {
  const el = document.querySelector(`#${id}`);
  if (!el) return;
  if (el.type === "hidden") {
    if (!state.products.some((product) => String(product.id) === String(el.value))) el.value = state.products[0]?.id || "";
    return;
  }
  el.innerHTML = state.products.map((p) => `<option value="${p.id}">${escape(p.code || p.selection_id)} / ${escape(p.name)}</option>`).join("");
}

function visibleColumns(key) {
  return columns[key];
}

async function syncOzon() {
  const status = document.querySelector("#orderSyncStatus") || document.querySelector("#syncStatus");
  if (status) status.textContent = "正在同步订单...";
  const body = {};
  // 当前若已筛选店铺，则只同步该店铺，方便局部排查问题。
  if (state.orderFilters.shopId && state.orderFilters.shopId !== "all") body.shop_id = state.orderFilters.shopId;
  const result = await api("/api/sync/ozon", { method: "POST", body: JSON.stringify(body) });
  if (status) status.textContent = `同步完成：新增 ${result.inserted} 条明细`;
  await loadAll();
}

async function syncOnlineProducts() {
  const status = document.querySelector("#syncOnlineStatus");
  status.textContent = "正在从 Ozon 拉取在线商品...";
  try {
    const result = await api("/api/sync/online-products", { method: "POST", body: JSON.stringify({}) });
    status.textContent = `同步完成：拉取 ${result.fetched} 条，写入 ${result.upserted} 条${result.errors?.length ? `；部分失败 ${result.errors.length} 个店铺` : ""}`;
    await loadAll();
  } catch (error) {
    status.textContent = `同步失败：${error.message}`;
  }
}

function fillShopForm(shop) {
  const form = document.querySelector("#shopForm");
  form.elements.id.value = shop.id;
  form.elements.name.value = shop.name || "";
  form.elements.legal_entity.value = shop.legal_entity || "";
  form.elements.ozon_client_id.value = shop.ozon_client_id || "";
  form.elements.api_key_hint.value = "";
  form.elements.status.value = shop.status || "active";
  form.elements.payout_rate.value = shop.payout_rate ?? 0.33;
  document.querySelector("#shopFormTitle").textContent = `编辑店铺：${shop.name}`;
  document.querySelector("#shopSaveBtn").textContent = "淇濆瓨淇敼";
  document.querySelector("#shopCancelEdit").style.display = "";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetShopForm() {
  const form = document.querySelector("#shopForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.status.value = "active";
  form.elements.payout_rate.value = "0.33";
  document.querySelector("#shopFormTitle").textContent = "新增店铺";
  document.querySelector("#shopSaveBtn").textContent = "保存店铺";
  document.querySelector("#shopCancelEdit").style.display = "none";
}

function fillPeopleForm(person) {
  const form = document.querySelector("#peopleForm");
  form.elements.id.value = person.id;
  form.elements.name.value = person.name || "";
  form.elements.username.value = person.username || "";
  form.elements.role.value = person.role || "operator";
  form.elements.active.value = String(person.active ?? 1);
  document.querySelector("#peopleCancelEdit").style.display = "";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetPeopleForm() {
  const form = document.querySelector("#peopleForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.active.value = "1";
  document.querySelector("#peopleCancelEdit").style.display = "none";
}

function renderTable(target, rows, cols) {
  document.querySelector(`#${target}`).innerHTML = !rows?.length
    ? `<div class="empty">鏆傛棤鏁版嵁</div>`
    : `<div class="table-wrap"><table class="table"><thead><tr>${cols.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr ${row?.id != null ? `data-row-id="${escape(row.id)}"` : ""} class="${target === "stockTable" && String(row.id) === String(state.stockHighlightProductId) ? "row-flash" : ""}">${cols.map(([, , getter]) => `<td>${getter(row) ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.authToken) headers["Authorization"] = `Bearer ${state.authToken}`;
  const response = await fetch(url, { headers, ...options });
  if (response.status === 401) {
    handleAuthRequired();
    throw new Error("登录已过期，请重新登录");
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      message = text;
    }
    throw new Error(message);
  }
  return response.json();
}

// 鈹€鈹€鈹€ 娓叉煋宸ュ叿鍑芥暟 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function image(src) {
  return src ? `<img class="thumb" src="${escape(src)}" alt="">` : `<div class="thumb placeholder"></div>`;
}

function link(url) {
  return url ? `<a class="linklike" href="${escape(url)}" target="_blank" rel="noreferrer">打开</a>` : "";
}

function multiLinks(value) {
  const links = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return links.length ? links.map((item, index) => `<a href="${escape(item)}" target="_blank" rel="noreferrer">链接${index + 1}</a>`).join("<small></small>") : "";
}

function strong(title, sub) {
  return `<strong>${escape(title || "")}</strong>${sub ? `<small>${escape(sub)}</small>` : ""}`;
}

function small(text) {
  return `<small>${escape(text || "")}</small>`;
}

function skuList(value) {
  const items = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!items.length) return `<span class="tag amber">未绑定</span>`;
  return `<div class="sku-list">${items.map((item) => `<span>${escape(item)}</span>`).join("")}</div>`;
}

function collapsedSkuList(value) {
  const items = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!items.length) return `<span class="tag amber">未绑定</span>`;
  return `<div class="sku-grid">${items.map((item) => `<span>${escape(item)}</span>`).join("")}</div>`;
}

function stockCell(row) {
  const stock = Number(row.stock || 0);
  if (stock < 0) return `${tag("0", "red")}<small>缺货 ${Math.abs(stock)} 件，请先创建库存/入库</small>`;
  return tag(stock, stock <= Number(row.alert_stock) ? "amber" : "green");
}

function salesCell(row) {
  const qty = Number(row.total_sales_quantity || 0);
  const amount = Number(row.total_sales_amount || 0);
  const avg = qty ? amount / qty : 0;
  return `${money(amount)}<small>${qty || 0} 件 / ${row.order_count || 0} 单 / 均价 ${num(avg, 2)}</small>`;
}

function stockProfitCell(row) {
  const profit = Number(row.estimated_profit_total || 0);
  if (profit) return `<span class="money ${profit < 0 ? "loss" : ""}">${num(profit, 2)}</span><small>本地有效订单汇总</small>`;
  const quote = row.pricing?.air || row.pricing?.land;
  if (quote) return profitCell(quote);
  return tag("暂无签收", "amber");
}

function cancelCell(row) {
  const qty = Number(row.cancel_quantity || 0);
  const amount = Number(row.cancel_amount || 0);
  const orders = Number(row.cancel_order_count || 0);
  if (!qty && !amount && !orders) return tag("0", "green");
  return `<strong class="danger-text">${escape(qty)} 件取消</strong><small>${escape(orders)} 单取消 / ${money(amount)}</small>`;
}

function profitCell(quote) {
  if (!quote) return tag("未匹配", "red");
  return `<span class="money ${quote.profit < 0 ? "loss" : ""}">${num(quote.profit, 2)}</span><small>${escape(quote.channel || "")} ${escape(quote.days || "")}</small>`;
}

function marginCell(quote) {
  if (!quote) return "";
  return tag(`${num(quote.margin, 2)}%`, quote.margin < 0 ? "red" : "green");
}

function suggestedCell(rub, targetMarginPct) {
  if (!rub) return `<span class="tag amber">无数据</span>`;
  const pct = targetMarginPct != null ? `<small>目标 ${num(targetMarginPct, 0)}%</small>` : "";
  return `<strong class="money">${Math.round(rub)}</strong>${pct}`;
}

function suggestedX2Cell(rub) {
  if (!rub) return "";
  return `<span class="money">${Math.round(rub)}</span>`;
}

function tag(text, color = "") {
  return `<span class="tag ${color}">${escape(text)}</span>`;
}

function money(value) {
  return `<span class="money">${num(value, 2)}</span>`;
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.startsWith("demo")) return escape(text);
  return `${escape(text.slice(0, 4))}••••${escape(text.slice(-4))}`;
}

function shortPath(value) {
  const text = String(value || "");
  const marker = "\\data\\";
  const index = text.toLowerCase().lastIndexOf(marker);
  return index >= 0 ? `...${text.slice(index)}` : text;
}

function listingRubToRmb(value, exchangeRate) {
  const rate = Number(exchangeRate || currentExchangeRate());
  return rate ? Number(value || 0) / rate : 0;
}

function currentExchangeRate() {
  return Number(state.exchangeRate?.rate || 11.32);
}

function suggestedCellRmb(rub, exchangeRate, targetMarginPct) {
  return suggestedCell(listingRubToRmb(rub, exchangeRate), targetMarginPct);
}

function suggestedX2CellRmb(rub, exchangeRate) {
  return suggestedX2Cell(listingRubToRmb(rub, exchangeRate));
}

function num(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function date(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
}

function dateInputValue(value) {
  const dateValue = value ? new Date(value) : new Date();
  if (Number.isNaN(dateValue.getTime())) return "";
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayInputValue() {
  return dateInputValue(new Date());
}

function defaultDateFrom(days) {
  const dateValue = new Date();
  dateValue.setDate(dateValue.getDate() - Number(days || 30));
  return dateInputValue(dateValue);
}

function orderDateRangeLabel() {
  const from = state.orderFilters.dateFrom || "最早";
  const to = state.orderFilters.dateTo || "今天";
  return `${from} 至 ${to}`;
}

function methodName(value) {
  return { air_land: "陆空", land: "陆运", air: "空运", manual_review: "人工判断" }[value] || value || "";
}

function sourceName(value) {
  return { "1688": "1688", pdd: "拼多多", supplier: "供应商" }[value] || value || "";
}

function statusName(value) {
  return { pending: "待合并", merged: "已合并", done: "已完成", cancelled: "已取消" }[value] || value || "";
}

function procRequestStatusName(value) {
  return { pending: "待合并", merged: "已合并", done: "已完成", cancelled: "已取消" }[value] || value || "";
}

function procRequestStatusColor(value) {
  return { pending: "amber", merged: "blue", done: "green", cancelled: "red" }[value] || "";
}

function procUrgencyName(value) {
  return value === "urgent" ? "加急" : "普通";
}

function purchaseOrderStatusName(value) {
  return {
    pending_purchase: "待采购",
    purchased: "已采购待到货",
    partial_inbound: "部分入库",
    inbound_done: "已入库",
    cancelled: "已取消"
  }[value] || value || "";
}

function purchaseOrderStatusColor(value) {
  return {
    pending_purchase: "amber",
    purchased: "blue",
    partial_inbound: "amber",
    inbound_done: "green",
    cancelled: "red"
  }[value] || "";
}

function qcStatusName(value) {
  return { pending: "待质检", passed: "通过", exception: "异常" }[value] || value || "待质检";
}

function stockWarningCell(row) {
  const stock = Number(row.stock || 0);
  const alertStock = Number(row.alert_stock || 0);
  const color = stock < 0 ? "red" : stock <= alertStock ? "amber" : "green";
  return `${tag(`库存 ${stock}`, color)}<small>即将入库 ${escape(row.incoming_stock || 0)}</small>`;
}

function inboundStatus(value) {
  return { pending_arrival: "等待到货", approved: "已入库", rejected: "已驳回" }[value] || value || "";
}

function outboundReason(value) {
  return { order: "订单出库", unmapped_order: "待绑定出库", cancel_return: "取消回补", reject_loss: "拒收损失", return_loss: "退货损失" }[value] || value || "";
}

function roleName(value) {
  return { listing: "上品", buyer: "采购", admin: "管理员", operator: "普通" }[value] || value || "";
}

function escape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ── 登录 / 认证 ──────────────────────────────
let currentUser = null;
let loginBackdrop = null;

function createBackdrop() {
  if (loginBackdrop) return;
  loginBackdrop = document.createElement("div");
  loginBackdrop.className = "edit-dialog-backdrop";
  // 点击遮罩关闭当前弹窗
  loginBackdrop.addEventListener("click", () => {
    const login = document.querySelector("#loginDialog");
    const pwd = document.querySelector("#changePwdDialog");
    if (login?.classList.contains("visible")) closeLoginDialog();
    if (pwd?.classList.contains("visible")) closeChangePwdDialog();
  });
  document.body.appendChild(loginBackdrop);
}

function removeBackdrop() {
  if (loginBackdrop) {
    loginBackdrop.remove();
    loginBackdrop = null;
  }
}

function openLoginDialog() {
  const dialog = document.querySelector("#loginDialog");
  document.querySelector("#loginError").style.display = "none";
  dialog.style.display = "";
  dialog.classList.add("visible");
  createBackdrop();
  // 自动填入保存的用户名
  const savedUser = localStorage.getItem("loginUsername") || "";
  const savedUserBox = dialog.querySelector("#loginSavedUser");
  if (savedUserBox) {
    savedUserBox.style.display = savedUser ? "" : "none";
    savedUserBox.textContent = savedUser ? `当前浏览器上次登录：${savedUser}` : "";
  }
  if (savedUser && dialog.querySelector("[name='username']")) {
    dialog.querySelector("[name='username']").value = savedUser;
    dialog.querySelector("#loginPasswordInput")?.focus();
  } else {
    dialog.querySelector("[name='username']")?.focus();
  }
}

function closeLoginDialog() {
  const dialog = document.querySelector("#loginDialog");
  dialog.classList.remove("visible");
  // 延迟隐藏，让动画完成
  setTimeout(() => { dialog.style.display = "none"; }, 200);
  removeBackdrop();
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.querySelector("#loginError");
  const submitBtn = document.querySelector("#loginSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "登录中...";
  errorEl.style.display = "none";
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value })
    });
    console.log("[登录] API返回:", JSON.stringify(result));
    if (result.error) {
      throw new Error(result.error);
    }
    if (!result.token || !result.user) {
      console.error("[登录] 异常响应:", result);
      throw new Error("服务器响应异常，请检查控制台");
    }
    // ── 登录成功：保存状态 ──
    state.authToken = result.token;
    localStorage.setItem("loginUsername", form.elements.username.value);
    if (document.querySelector("#loginRemember")?.checked) {
      localStorage.setItem("authToken", result.token);
    } else {
      localStorage.removeItem("authToken");
    }
    currentUser = result.user;
    state.currentUser = result.user;
    state.currentUserId = String(result.user.id);
    updateAuthUI(result.user);
    closeLoginDialog();
    // ── 后续数据加载（独立错误处理）──
    try { fillSelects(); } catch (e) { console.warn("[登录后] fillSelects异常:", e); }
    try { await loadAll(); } catch (e) { console.warn("[登录后] loadAll异常:", e); }
    try { restoreCurrentView(); } catch (e) { console.warn("[登录后] restoreCurrentView异常:", e); }
  } catch (error) {
    errorEl.textContent = error.message || "登录失败，请检查用户名和密码";
    errorEl.style.display = "";
    form.elements.password.value = "";
    form.elements.password?.focus();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "登 录";
  }
}

function handleAuthRequired() {
  state.authToken = "";
  localStorage.removeItem("authToken");
  currentUser = null;
  state.currentUser = null;
  updateAuthUI(null);
  openLoginDialog();
}

// 更新认证相关UI（侧边栏用户名、按钮显示/隐藏、配置页账户信息）
function updateAuthUI(user) {
  const nameEl = document.querySelector("#currentUserName");
  const logoutBtn = document.querySelector("#logoutBtn");
  const changePwdBtn = document.querySelector("#changePwdBtn");
  if (!user) {
    if (nameEl) nameEl.textContent = "未登录";
    if (logoutBtn) logoutBtn.style.display = "none";
    if (changePwdBtn) changePwdBtn.style.display = "none";
  } else {
    if (nameEl) nameEl.textContent = user.name || user.username || "已登录";
    if (logoutBtn) logoutBtn.style.display = "";
    if (changePwdBtn) changePwdBtn.style.display = "";
  }
  // 填充配置页账户信息
  renderConfigAccountInfo(user);
}

async function checkAuthSession() {
  // 启动时先确认登录态，未登录时不继续加载业务数据。
  if (!state.authToken) { openLoginDialog(); return false; }
  try {
    const user = await api("/api/auth/me");
    if (!user) { handleAuthRequired(); return false; }
    currentUser = user;
    state.currentUser = user;
    state.currentUserId = String(user.id);
    updateAuthUI(user);
    return true;
  } catch {
    handleAuthRequired();
    return false;
  }
}

async function doLogout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  handleAuthRequired();
  location.reload();
}

// 修改密码
function openChangePwdDialog() {
  const dialog = document.querySelector("#changePwdDialog");
  document.querySelector("#changePwdError").style.display = "none";
  document.querySelector("#changePwdForm").reset();
  dialog.style.display = "";
  dialog.classList.add("visible");
  createBackdrop();
}

function closeChangePwdDialog() {
  const dialog = document.querySelector("#changePwdDialog");
  dialog.classList.remove("visible");
  setTimeout(() => { dialog.style.display = "none"; }, 200);
  removeBackdrop();
}

async function handleChangePwdSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.querySelector("#changePwdError");
  if (form.elements.new_password.value !== form.elements.new_password_confirm.value) {
    errorEl.textContent = "两次输入的新密码不一致";
    errorEl.style.display = "";
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        old_password: form.elements.old_password.value,
        new_password: form.elements.new_password.value
      })
    });
    closeChangePwdDialog();
    alert("密码修改成功");
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.style.display = "";
  }
}

function bindAuthControls() {
  // 登录表单
  document.querySelector("#loginForm")?.addEventListener("submit", handleLoginSubmit);
  // 退出按钮
  document.querySelector("#logoutBtn")?.addEventListener("click", doLogout);
  // 修改密码按钮（侧边栏 + 配置页）
  document.querySelector("#changePwdBtn")?.addEventListener("click", openChangePwdDialog);
  document.querySelector("#configChangePwdBtn")?.addEventListener("click", openChangePwdDialog);
  // 显示/隐藏密码切换（登录弹窗）
  document.querySelector("#loginTogglePwd")?.addEventListener("click", () => {
    const pwdInput = document.querySelector("#loginPasswordInput");
    const btn = document.querySelector("#loginTogglePwd");
    if (pwdInput.type === "password") { pwdInput.type = "text"; btn.textContent = "隐藏"; }
    else { pwdInput.type = "password"; btn.textContent = "显示"; }
  });
  // 显示/隐藏密码切换（修改密码弹窗 - 3个密码框共用委托）
  document.querySelectorAll(".pwd-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === "password") { input.type = "text"; btn.textContent = "隐藏"; }
      else { input.type = "password"; btn.textContent = "显示"; }
    });
  });
  // 修改密码弹窗
  document.querySelector("#changePwdCloseBtn")?.addEventListener("click", closeChangePwdDialog);
  document.querySelector("#changePwdCancelBtn")?.addEventListener("click", closeChangePwdDialog);
  document.querySelector("#changePwdForm")?.addEventListener("submit", handleChangePwdSubmit);
}
